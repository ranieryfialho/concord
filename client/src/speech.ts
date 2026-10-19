import { apiRaw } from './api';

// Captures the local microphone, splits it into speech segments with a simple energy-based
// voice activity detector, and uploads each segment (16 kHz mono PCM) for transcription.

const TARGET_RATE = 16_000;
const SPEECH_RMS = 0.01;
const END_SILENCE_MS = 800;
const MAX_SEGMENT_MS = 20_000;
// One-word answers ("sim", "não") are ~250 ms of voiced sound.
const MIN_SPEECH_MS = 200;
// Audio kept from before speech is detected: soft onsets (the "en-" in "entendi") are quieter than the threshold.
const PREROLL_MS = 400;

function downsample(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === TARGET_RATE) return input;
  const ratio = fromRate / TARGET_RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start); // box filter doubles as a cheap low-pass
  }
  return out;
}

function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export class SpeechCapture {
  private ctx!: AudioContext;
  private source!: MediaStreamAudioSourceNode;
  private processor: ScriptProcessorNode;
  private sink: GainNode;
  private chunks: Float32Array[] = [];
  private preroll: Float32Array[] = [];
  private speaking = false;
  private silenceMs = 0;
  private speechMs = 0;
  private startedAt = 0;

  constructor(
    stream: MediaStream,
    private channelId: string,
  ) {
    // Let the browser's high-quality resampler produce 16 kHz directly; fall back to our own.
    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
      this.source = this.ctx.createMediaStreamSource(stream);
    } catch {
      this.ctx = new AudioContext();
      this.source = this.ctx.createMediaStreamSource(stream);
    }
    this.processor = this.ctx.createScriptProcessor(this.ctx.sampleRate <= TARGET_RATE ? 2048 : 4096, 1, 1);
    // ScriptProcessor only runs when connected to the destination; route it through a muted gain.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.ctx.destination);
    this.processor.onaudioprocess = (e) => this.onAudio(e.inputBuffer.getChannelData(0));
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  private onAudio(input: Float32Array) {
    const buf = new Float32Array(input);
    const ms = (buf.length / this.ctx.sampleRate) * 1000;
    let sum = 0;
    for (const v of buf) sum += v * v;
    const loud = Math.sqrt(sum / buf.length) > SPEECH_RMS;

    if (!this.speaking) {
      this.preroll.push(buf);
      if (this.preroll.length > Math.max(1, Math.ceil(PREROLL_MS / ms))) this.preroll.shift();
      if (!loud) return;
      this.speaking = true;
      this.chunks = [...this.preroll];
      this.preroll = [];
      this.silenceMs = 0;
      this.speechMs = ms;
      this.startedAt = Date.now() - this.chunks.length * ms;
      return;
    }

    this.chunks.push(buf);
    if (loud) {
      this.silenceMs = 0;
      this.speechMs += ms;
    } else {
      this.silenceMs += ms;
    }
    if (this.silenceMs >= END_SILENCE_MS || this.chunks.length * ms >= MAX_SEGMENT_MS) this.flush();
  }

  private flush() {
    const { chunks, speechMs, startedAt } = this;
    this.chunks = [];
    this.speaking = false;
    this.silenceMs = 0;
    this.speechMs = 0;
    if (speechMs < MIN_SPEECH_MS) return;

    const length = chunks.reduce((n, c) => n + c.length, 0);
    const joined = new Float32Array(length);
    let offset = 0;
    for (const c of chunks) {
      joined.set(c, offset);
      offset += c.length;
    }
    const pcm = toInt16(downsample(joined, this.ctx.sampleRate));
    void apiRaw(`/voice/transcribe?channel_id=${this.channelId}&at=${startedAt}`, pcm.buffer as ArrayBuffer).catch(() => {});
  }

  stop() {
    if (this.speaking) this.flush();
    this.processor.onaudioprocess = null;
    this.source.disconnect();
    this.processor.disconnect();
    this.sink.disconnect();
    void this.ctx.close();
  }
}
