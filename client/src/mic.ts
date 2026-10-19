import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor';
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client';

// Everything between the microphone and the call:
//
//   mic (echo cancellation / browser suppressor / auto gain: getUserMedia constraints)
//     → input volume (GainNode, 0–200%)
//     → noise suppression "advanced": RNNoise, a small neural network (WebAssembly in an AudioWorklet)
//       that keeps the voice and removes keyboard, fans, traffic… Runs entirely on this device.
//     → level meter
//     → sensitivity gate: closes below a threshold (automatic, or a manual level in dB)
//     → outgoing track
//
// Push-to-talk and mute act on the outgoing track (track.enabled), in voice.ts.

export type NoiseMode = 'advanced' | 'standard' | 'off';
export type InputProfile = 'isolation' | 'studio' | 'custom';

export const NOISE_LABELS: Record<NoiseMode, { title: string; description: string }> = {
  advanced: { title: 'Avançada (IA)', description: 'Remove teclado, ventilador, trânsito e outros ruídos de fundo. Processado no seu computador.' },
  standard: { title: 'Padrão', description: 'O filtro simples do navegador. Use se a avançada pesar no seu computador.' },
  off: { title: 'Desligada', description: 'Envia o som do microfone como ele é. Bom para música e microfones de estúdio.' },
};

export const PROFILE_LABELS: Record<InputProfile, { title: string; description: string }> = {
  isolation: { title: 'Isolamento de voz', description: 'Só a sua voz: o ruído de fundo é removido e o volume equalizado.' },
  studio: { title: 'Estúdio', description: 'Áudio puro: microfone aberto, sem nenhum processamento.' },
  custom: { title: 'Personalizado', description: 'Você escolhe cada ajuste: eco, ruído, ganho e sensibilidade.' },
};

/** The user's choices, as stored in voice preferences. */
export interface MicPrefs {
  inputProfile: InputProfile;
  echoCancellation: boolean;
  noiseSuppression: NoiseMode;
  autoGainControl: boolean;
  sensitivityAuto: boolean;
  /** Manual gate threshold in dB (-100 … 0). */
  inputThreshold: number;
  /** Input volume in percent (0–200). */
  inputVolume: number;
}

/** What actually applies, after the profile. */
export interface MicSettings {
  echoCancellation: boolean;
  noiseSuppression: NoiseMode;
  autoGainControl: boolean;
  /** 'auto', a threshold in dB, or null for no gate. */
  gate: 'auto' | number | null;
  volume: number;
}

export function micSettings(p: MicPrefs): MicSettings {
  const volume = p.inputVolume / 100;
  if (p.inputProfile === 'isolation') return { echoCancellation: true, noiseSuppression: 'advanced', autoGainControl: true, gate: 'auto', volume };
  if (p.inputProfile === 'studio') return { echoCancellation: false, noiseSuppression: 'off', autoGainControl: false, gate: null, volume };
  return {
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    gate: p.sensitivityAuto ? 'auto' : p.inputThreshold,
    volume,
  };
}

export function micConstraints(deviceId: string, s: MicSettings): MediaTrackConstraints {
  return {
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: s.echoCancellation,
    noiseSuppression: s.noiseSuppression === 'standard',
    autoGainControl: s.autoGainControl,
  };
}

let binary: Promise<ArrayBuffer> | null = null;
function rnnoiseWasm(): Promise<ArrayBuffer> {
  binary ??= loadRnnoise({ url: wasmUrl, simdUrl }).catch((err) => {
    binary = null;
    throw err;
  });
  return binary;
}

const METER_FLOOR = -100;
const GATE_HOLD_MS = 300;

function toDb(rms: number): number {
  return rms > 0 ? Math.max(METER_FLOOR, 20 * Math.log10(rms)) : METER_FLOOR;
}

/** One running microphone graph. Owns its input track only when created with open(). */
export class MicPipeline {
  readonly track: MediaStreamTrack;
  /** Set when RNNoise was requested but could not start (the call goes on with the raw mic). */
  denoiseFailed = false;
  private ctx: AudioContext;
  private source: MediaStreamAudioSourceNode;
  private input: GainNode;
  private denoiser: RnnoiseWorkletNode | null = null;
  private analyser: AnalyserNode;
  private gateNode: GainNode;
  private timer: ReturnType<typeof setInterval>;
  private buf: Float32Array<ArrayBuffer>;
  private gate: MicSettings['gate'] = null;
  private noiseFloor = -60;
  private lastLoud = 0;
  private stopped = false;
  private ownedInput: MediaStreamTrack | null = null;
  level = METER_FLOOR;
  open = true;

  /** Opens the microphone with these settings. */
  static async open(deviceId: string, settings: MicSettings): Promise<MicPipeline> {
    const raw = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId, settings) });
    const [input] = raw.getAudioTracks();
    try {
      const pipe = await MicPipeline.wrap(input, settings);
      pipe.ownedInput = input;
      return pipe;
    } catch (err) {
      input.stop();
      throw err;
    }
  }

  /** Builds the graph around an existing microphone track (LiveKit hands us one). */
  static async wrap(input: MediaStreamTrack, settings: MicSettings): Promise<MicPipeline> {
    // RNNoise works on 48 kHz frames; the context resamples the microphone if needed.
    const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    let denoiser: RnnoiseWorkletNode | null = null;
    let failed = false;
    if (settings.noiseSuppression === 'advanced') {
      try {
        const wasmBinary = await rnnoiseWasm();
        await ctx.audioWorklet.addModule(workletUrl);
        denoiser = new RnnoiseWorkletNode(ctx, { wasmBinary, maxChannels: 1 });
      } catch (err) {
        console.warn('[mic] noise suppression unavailable', err);
        failed = true;
      }
    }
    const pipe = new MicPipeline(ctx, input, denoiser, settings);
    pipe.denoiseFailed = failed;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    return pipe;
  }

  private constructor(ctx: AudioContext, inputTrack: MediaStreamTrack, denoiser: RnnoiseWorkletNode | null, settings: MicSettings) {
    this.ctx = ctx;
    this.source = ctx.createMediaStreamSource(new MediaStream([inputTrack]));
    this.input = ctx.createGain();
    this.denoiser = denoiser;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.gateNode = ctx.createGain();
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;

    let node: AudioNode = this.source.connect(this.input);
    if (denoiser) node = node.connect(denoiser);
    node.connect(this.analyser);
    node.connect(this.gateNode).connect(dest);
    this.track = dest.stream.getAudioTracks()[0];

    this.setVolume(settings.volume);
    this.setGate(settings.gate);
    this.timer = setInterval(() => this.tick(), 20);
  }

  setVolume(volume: number) {
    this.input.gain.setTargetAtTime(Math.max(0, volume), this.ctx.currentTime, 0.02);
  }

  setGate(gate: MicSettings['gate']) {
    this.gate = gate;
  }

  /** The level the gate currently opens at, in dB (for the meter's marker). */
  threshold(): number | null {
    if (this.gate === null) return null;
    return this.gate === 'auto' ? this.autoThreshold() : this.gate;
  }

  private autoThreshold(): number {
    // A bit above the background noise, kept inside sensible bounds.
    return Math.min(-30, Math.max(-65, this.noiseFloor + 15));
  }

  private tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    const db = toDb(Math.sqrt(sum / this.buf.length));
    this.level = db;
    // Noise floor: falls quickly to quiet moments, rises slowly so speech doesn't drag it up.
    this.noiseFloor = db < this.noiseFloor ? db : this.noiseFloor + 0.02;

    const threshold = this.threshold();
    const now = performance.now();
    if (threshold === null || db >= threshold) this.lastLoud = now;
    const open = now - this.lastLoud < GATE_HOLD_MS;
    if (open !== this.open) {
      this.open = open;
      // Opens fast (no clipped first syllable), closes gently.
      this.gateNode.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, open ? 0.003 : 0.05);
    }
  }

  /** Plays the processed microphone back to the speakers (mic test). */
  monitor(deviceId: string): () => void {
    const out = new MediaStreamAudioDestinationNode(this.ctx);
    const el = new Audio();
    this.gateNode.connect(out);
    el.srcObject = out.stream;
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (deviceId && withSink.setSinkId) void withSink.setSinkId(deviceId).catch(() => {});
    void el.play().catch(() => {});
    return () => {
      el.pause();
      el.srcObject = null;
      try {
        this.gateNode.disconnect(out);
      } catch {
        /* already torn down */
      }
    };
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.track.stop();
    this.source.disconnect();
    this.denoiser?.disconnect();
    this.denoiser?.destroy();
    this.ownedInput?.stop();
    void this.ctx.close().catch(() => {});
  }
}

/** The same pipeline as a LiveKit track processor (used when the server runs in LiveKit mode). */
export function micProcessor(settings: () => MicSettings, onPipe: (pipe: MicPipeline | null) => void): TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  let current: MicPipeline | null = null;
  const processor: TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> = {
    name: 'concord-mic',
    async init(opts) {
      current = await MicPipeline.wrap(opts.track, settings());
      processor.processedTrack = current.track;
      onPipe(current);
    },
    async restart(opts) {
      current?.stop();
      current = await MicPipeline.wrap(opts.track, settings());
      processor.processedTrack = current.track;
      onPipe(current);
    },
    async destroy() {
      current?.stop();
      current = null;
      processor.processedTrack = undefined;
      onPipe(null);
    },
  };
  return processor;
}
