import type { LocalAudioTrack, Participant, RemoteAudioTrack, RemoteTrack, Room, Track } from 'livekit-client';
import { create } from 'zustand';
import { api } from './api';
import { gateway } from './gateway';
import { type InputProfile, MicPipeline, type MicPrefs, type NoiseMode, micConstraints, micProcessor, micSettings } from './mic';
import { sounds } from './sounds';
import { SpeechCapture } from './speech';
import { getState, setState, toast } from './store';
import type { Transcription, VoiceState } from './types';

// Two media backends behind one API:
//  - "mesh": WebRTC peer-to-peer, one RTCPeerConnection per peer, signaling relayed by the
//    gateway, glare resolved with the "perfect negotiation" pattern. No extra server needed.
//  - "livekit": an SFU (LiveKit). Used automatically when the server has LIVEKIT_* configured.
// Either way the gateway's voice states remain the source of truth for who is in a channel.

export type StreamKind = 'audio' | 'camera' | 'screen';

interface VoiceUI {
  channelId: string | null;
  guildId: string | null;
  mode: 'mesh' | 'livekit';
  selfMute: boolean;
  selfDeaf: boolean;
  selfVideo: boolean;
  selfStream: boolean;
  speaking: Record<string, boolean>;
  remoteStreams: Record<string, Record<string, MediaStream>>;
  streamKinds: Record<string, Record<string, StreamKind>>;
  connection: Record<string, RTCPeerConnectionState>;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  inputDeviceId: string;
  outputDeviceId: string;
  videoDeviceId: string;
  /** Bumped when a local track is swapped inside the same stream, so previews re-render. */
  deviceTick: number;
  transcriptOpen: boolean;
  /** Text chat panel next to a voice channel. */
  chatOpen: boolean;
  /** Per-person playback volume in percent (100 = untouched, up to 200), only on this device. */
  userVolumes: Record<string, number>;
  /** People muted just for me. */
  localMuted: Record<string, boolean>;
  /** Same as above, for the audio of each person's screen share. */
  streamVolumes: Record<string, number>;
  streamMuted: Record<string, boolean>;
  /** Microphone processing (see mic.ts). */
  inputProfile: InputProfile;
  echoCancellation: boolean;
  noiseSuppression: NoiseMode;
  autoGainControl: boolean;
  sensitivityAuto: boolean;
  inputThreshold: number;
  inputVolume: number;
  /** Everything we play, in percent (0–200). */
  outputVolume: number;
  /** Push-to-talk: the mic only transmits while the key is held (with the app focused). */
  pttEnabled: boolean;
  /** KeyboardEvent.code, or "Mouse3"/"Mouse4" for side mouse buttons. */
  pttKey: string;
  /** Keeps transmitting this long after the key is released, in ms. */
  pttDelay: number;
  /** Push-to-talk key currently held. */
  pttActive: boolean;
  /** Voice stage shows only tiles with camera or screen. */
  hideNoVideo: boolean;
  /** Screen share quality preset. */
  streamQuality: StreamQuality;
  /** Send the computer's audio with the screen share. */
  streamAudio: boolean;
}

export type StreamQuality = '720p30' | '1080p30' | '1080p60' | 'source';

export const STREAM_QUALITIES: Record<StreamQuality, { label: string; short: string; width?: number; height?: number; fps: number; bitrate: number }> = {
  '720p30': { label: '720p · 30 FPS', short: '720p 30FPS', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '1080p30': { label: '1080p · 30 FPS', short: '1080p 30FPS', width: 1920, height: 1080, fps: 30, bitrate: 4_500_000 },
  '1080p60': { label: '1080p · 60 FPS', short: '1080p 60FPS', width: 1920, height: 1080, fps: 60, bitrate: 7_000_000 },
  source: { label: 'Resolução original · 30 FPS', short: 'Original 30FPS', fps: 30, bitrate: 8_000_000 },
};

const PREFS_KEY = 'concord.voice';
const PREF_KEYS = [
  'selfMute',
  'selfDeaf',
  'inputDeviceId',
  'outputDeviceId',
  'videoDeviceId',
  'userVolumes',
  'localMuted',
  'streamVolumes',
  'streamMuted',
  'inputProfile',
  'echoCancellation',
  'noiseSuppression',
  'autoGainControl',
  'sensitivityAuto',
  'inputThreshold',
  'inputVolume',
  'outputVolume',
  'pttEnabled',
  'pttKey',
  'pttDelay',
  'hideNoVideo',
  'streamQuality',
  'streamAudio',
] as const;

function loadPrefs() {
  const defaults = {
    selfMute: false,
    selfDeaf: false,
    inputDeviceId: '',
    outputDeviceId: '',
    videoDeviceId: '',
    userVolumes: {},
    localMuted: {},
    streamVolumes: {},
    streamMuted: {},
    inputProfile: 'isolation' as InputProfile,
    echoCancellation: true,
    noiseSuppression: 'advanced' as NoiseMode,
    autoGainControl: true,
    sensitivityAuto: true,
    inputThreshold: -50,
    inputVolume: 100,
    outputVolume: 100,
    pttEnabled: false,
    pttKey: '',
    pttDelay: 200,
    hideNoVideo: false,
    streamQuality: '1080p30' as StreamQuality,
    streamAudio: true,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export const useVoice = create<VoiceUI>()(() => ({
  channelId: null,
  guildId: null,
  mode: 'mesh',
  selfVideo: false,
  selfStream: false,
  speaking: {},
  remoteStreams: {},
  streamKinds: {},
  connection: {},
  localCamera: null,
  localScreen: null,
  deviceTick: 0,
  transcriptOpen: false,
  chatOpen: true,
  pttActive: false,
  ...loadPrefs(),
}));

export function savePrefs() {
  const state = useVoice.getState();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(Object.fromEntries(PREF_KEYS.map((k) => [k, state[k]]))));
  } catch {
    /* ignore */
  }
}

// ---------- Server voice config (mode + ICE servers with short-lived TURN credentials) ----------

interface VoiceConfig {
  mode: 'mesh' | 'livekit';
  livekit_url: string | null;
  ice_servers: RTCIceServer[];
  ttl: number;
  transcription: 'local' | 'api' | 'off';
}

const FALLBACK_CONFIG: VoiceConfig = {
  mode: 'mesh',
  livekit_url: null,
  ice_servers: [{ urls: ['stun:stun.l.google.com:19302'] }],
  ttl: 3600,
  transcription: 'off',
};

export function transcriptionAvailable(): boolean {
  return (cachedConfig?.value.transcription ?? 'off') !== 'off';
}

function cameraConstraints(deviceId: string): MediaTrackConstraints {
  return { deviceId: deviceId ? { exact: deviceId } : undefined, width: 1280, height: 720, frameRate: 30 };
}
let cachedConfig: { value: VoiceConfig; at: number } | null = null;

async function voiceConfig(): Promise<VoiceConfig> {
  if (cachedConfig && Date.now() - cachedConfig.at < (cachedConfig.value.ttl * 1000) / 2) return cachedConfig.value;
  try {
    const value = await api<VoiceConfig>('/voice/config');
    cachedConfig = { value, at: Date.now() };
    return value;
  } catch {
    return cachedConfig?.value ?? FALLBACK_CONFIG;
  }
}

// ---------- Mesh peer state ----------

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  queue: Promise<void>;
  senders: Map<string, RTCRtpSender>;
  /** Remote audio being played, by stream id (microphone and screen audio are separate streams). */
  outputs: Map<string, RemoteAudio>;
}

// ---------- Remote audio playback ----------

/** One remote audio stream being played, with its own volume (0 to 2 = 200%). */
interface RemoteAudio {
  setGain(gain: number): void;
  stop(): void;
}

type SinkCapable = { setSinkId?: (id: string) => Promise<void> };

/**
 * Plays remote audio through Web Audio: stream → GainNode → speakers. A GainNode goes past 100% and applies
 * instantly, unlike <audio>.volume. Chrome only pulls a remote WebRTC stream into Web Audio while a media
 * element is playing it, so each stream also gets a muted <audio>. Echo cancellation still works: Chrome
 * uses everything it plays as the echo reference. Browsers that can't route a context to the chosen output
 * device fall back to a plain <audio> per stream (volume up to 100%).
 */
class Mixer {
  private ctx: AudioContext | null = null;
  private readonly webAudio = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  private elements = new Set<HTMLAudioElement>(); // fallback mode only

  context(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.setSink(useVoice.getState().outputDeviceId);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  play(stream: MediaStream): RemoteAudio {
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = stream;
    if (!this.webAudio) {
      this.applyElementSink(el, useVoice.getState().outputDeviceId);
      this.elements.add(el);
      void el.play().catch(() => {});
      return {
        setGain: (gain) => {
          el.volume = Math.min(1, Math.max(0, gain));
        },
        stop: () => {
          el.pause();
          el.srcObject = null;
          this.elements.delete(el);
        },
      };
    }
    el.muted = true;
    void el.play().catch(() => {});
    const ctx = this.context();
    const source = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    source.connect(gain).connect(ctx.destination);
    return {
      setGain: (value) => gain.gain.setTargetAtTime(Math.max(0, value), ctx.currentTime, 0.015),
      stop: () => {
        source.disconnect();
        gain.disconnect();
        el.pause();
        el.srcObject = null;
      },
    };
  }

  setSink(deviceId: string) {
    const ctx = this.ctx as (AudioContext & SinkCapable) | null;
    if (ctx?.setSinkId) void ctx.setSinkId(deviceId || '').catch(() => {});
    for (const el of this.elements) this.applyElementSink(el, deviceId);
  }

  private applyElementSink(el: HTMLAudioElement, deviceId: string) {
    const withSink = el as HTMLAudioElement & SinkCapable;
    if (withSink.setSinkId) void withSink.setSinkId(deviceId || '').catch(() => {});
  }
}

type Signal =
  | { type: 'meta'; kinds: Record<string, StreamKind> }
  | { type: 'description'; description: RTCSessionDescriptionInit }
  | { type: 'candidate'; candidate: RTCIceCandidateInit };

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

// livekit-client is large; it's only downloaded when the server runs in LiveKit mode.
type LiveKit = typeof import('livekit-client');
let livekit: LiveKit | null = null;
async function loadLiveKit(): Promise<LiveKit> {
  livekit ??= await import('livekit-client');
  return livekit;
}

const LK_STATE: Record<string, RTCPeerConnectionState> = {
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'connecting',
  signalReconnecting: 'connecting',
  disconnected: 'disconnected',
};

class VoiceManager {
  // mesh
  private peers = new Map<string, Peer>();
  private mic: MediaStream | null = null;
  private iceServers: RTCIceServer[] = FALLBACK_CONFIG.ice_servers;
  // livekit
  private room: Room | null = null;
  private lkAudio = new Map<string, { track: RemoteAudioTrack; uid: string; kind: 'voice' | 'screen'; el: HTMLMediaElement }>();
  // shared
  private mixer = new Mixer();
  /** Our microphone graph (mesh: we own it; LiveKit: created by the track processor). */
  private pipe: MicPipeline | null = null;
  private analysers = new Map<string, () => void>();
  private awaitingJoin: string | null = null;
  private rejoin: { guildId: string | null; channelId: string } | null = null;
  private capture: SpeechCapture | null = null;

  guildId() {
    return useVoice.getState().guildId;
  }

  private meId(): string {
    return getState().me?.id ?? '';
  }

  private isLiveKit() {
    return useVoice.getState().mode === 'livekit';
  }

  private suppressed(): boolean {
    return !!getState().voiceStates[this.meId()]?.suppress;
  }

  // ---------- Session ----------

  async join(guildId: string | null, channelId: string) {
    const ui = useVoice.getState();
    if (ui.channelId === channelId) return;
    if (ui.channelId) this.leave();

    this.awaitingJoin = channelId;
    useVoice.setState({ channelId, guildId });
    this.mixer.context(); // created inside the click that joins, so autoplay rules let it run
    const config = await voiceConfig();
    if (useVoice.getState().channelId !== channelId) return;
    useVoice.setState({ mode: config.mode });

    const { selfMute, selfDeaf } = useVoice.getState();
    gateway.send('voice_join', { channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf });
    sounds.join();

    if (config.mode === 'livekit') {
      await this.connectLiveKit(channelId);
      void this.loadTranscription(channelId);
      return;
    }

    this.iceServers = config.ice_servers;
    try {
      this.mic = await this.openMic(ui.inputDeviceId);
    } catch {
      this.mic = null;
      toast('Não foi possível acessar o microfone. Você entrou só ouvindo.');
    }
    if (useVoice.getState().channelId !== channelId) {
      // Left (or switched) while the permission prompt was open.
      this.releaseMic();
      return;
    }
    this.applyMicEnabled();
    if (this.mic) this.watchSpeaking(this.meId(), this.mic);
    for (const v of Object.values(getState().voiceStates)) {
      if (v.channel_id === channelId && v.user_id !== this.meId()) this.ensurePeer(v.user_id);
    }
    void this.loadTranscription(channelId);
  }

  // ---------- Transcription ----------

  private async loadTranscription(channelId: string) {
    try {
      const t = await api<Transcription>(`/voice/transcription/${channelId}`);
      setState((s) => ({ transcriptions: { ...s.transcriptions, [channelId]: t } }));
    } catch {
      /* feature disabled or not allowed */
    }
    this.syncTranscription();
  }

  /** Starts/stops sending our own microphone for transcription to match the call's state. */
  syncTranscription() {
    const { channelId } = useVoice.getState();
    const active = !!channelId && !!getState().transcriptions[channelId]?.active;
    const stream = active ? this.micStream() : null;
    if (this.capture && (!active || !stream)) {
      this.capture.stop();
      this.capture = null;
    }
    if (active && stream && !this.capture) this.capture = new SpeechCapture(stream, channelId!);
  }

  async setTranscription(enabled: boolean) {
    const { channelId } = useVoice.getState();
    if (!channelId) return;
    try {
      await api('/voice/transcription', { body: { channel_id: channelId, enabled } });
    } catch (e) {
      toast((e as Error).message);
    }
  }

  private micStream(): MediaStream | null {
    if (this.mic) return this.mic;
    const track = this.room?.localParticipant.getTrackPublication(livekit!.Track.Source.Microphone)?.track?.mediaStreamTrack;
    return track ? new MediaStream([track]) : null;
  }

  leave(notifyServer = true) {
    const ui = useVoice.getState();
    if (!ui.channelId) return;
    this.capture?.stop();
    this.capture = null;
    for (const uid of [...this.peers.keys()]) this.closePeer(uid);
    this.releaseMic();
    if (this.room) {
      const room = this.room;
      this.room = null;
      void room.disconnect();
    }
    for (const { el } of this.lkAudio.values()) el.remove();
    this.lkAudio.clear();
    ui.localCamera?.getTracks().forEach((t) => t.stop());
    ui.localScreen?.getTracks().forEach((t) => t.stop());
    for (const stop of this.analysers.values()) stop();
    this.analysers.clear();
    this.awaitingJoin = null;
    if (notifyServer) gateway.send('voice_leave');
    sounds.leave();
    useVoice.setState({
      channelId: null,
      guildId: null,
      selfVideo: false,
      selfStream: false,
      speaking: {},
      remoteStreams: {},
      streamKinds: {},
      connection: {},
      localCamera: null,
      localScreen: null,
    });
  }

  onGatewayLost() {
    const { channelId, guildId } = useVoice.getState();
    if (!channelId) return;
    this.rejoin = { channelId, guildId };
    this.leave(false);
  }

  onReady() {
    const target = this.rejoin;
    this.rejoin = null;
    if (target && getState().channels[target.channelId]) void this.join(target.guildId, target.channelId);
  }

  onVoiceState(v: VoiceState, prev: VoiceState | undefined) {
    const ui = useVoice.getState();
    if (!ui.channelId) return;

    if (v.user_id === this.meId()) {
      if (v.channel_id === ui.channelId) {
        this.awaitingJoin = null;
        if (v.suppress !== prev?.suppress) this.applyMicEnabled();
        if (v.server_deaf !== prev?.server_deaf) this.applyGains();
      } else if (!this.awaitingJoin) {
        this.leave(false); // moved by the server: channel deleted, permission lost, or joined elsewhere
      }
      return;
    }

    if (v.channel_id === ui.channelId) {
      if (prev?.channel_id !== ui.channelId) {
        sounds.join();
        if (!this.isLiveKit()) this.ensurePeer(v.user_id);
      }
      if (!v.self_stream) this.dropRemoteKind(v.user_id, 'screen');
      if (!v.self_video) this.dropRemoteKind(v.user_id, 'camera');
    } else if (prev?.channel_id === ui.channelId) {
      sounds.leave();
      if (!this.isLiveKit()) this.closePeer(v.user_id);
    }
  }

  // ---------- LiveKit backend ----------

  private async connectLiveKit(channelId: string) {
    let url: string;
    let token: string;
    try {
      ({ url, token } = await api<{ url: string; token: string }>('/voice/livekit-token', { body: { channel_id: channelId } }));
    } catch (e) {
      toast((e as Error).message);
      this.leave();
      return;
    }
    const { Room, RoomEvent, Track } = await loadLiveKit();
    if (useVoice.getState().channelId !== channelId) return;
    const ui = useVoice.getState();
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Plays through Web Audio, so RemoteAudioTrack.setVolume can go past 100%.
      webAudioMix: { audioContext: this.mixer.context() },
      audioCaptureDefaults: {
        ...micConstraints(ui.inputDeviceId, micSettings(ui)),
        deviceId: ui.inputDeviceId || undefined,
        processor: this.lkProcessor(),
      },
      audioOutput: ui.outputDeviceId ? { deviceId: ui.outputDeviceId } : undefined,
      videoCaptureDefaults: { deviceId: ui.videoDeviceId || undefined, resolution: { width: 1280, height: 720, frameRate: 30 } },
    });
    this.room = room;

    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => this.lkTrack(track, participant, true));
    room.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => this.lkTrack(track, participant, false));
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      useVoice.setState({ speaking: Object.fromEntries(speakers.map((p) => [p.identity, true])) });
    });
    room.on(RoomEvent.LocalTrackUnpublished, (pub) => {
      if (pub.source === Track.Source.ScreenShare && useVoice.getState().selfStream) {
        useVoice.setState({ localScreen: null, selfStream: false });
        this.pushState();
      }
    });
    room.on(RoomEvent.ConnectionStateChanged, (state) => {
      useVoice.setState({ connection: { livekit: LK_STATE[state] } });
    });
    room.on(RoomEvent.Disconnected, () => {
      if (this.room === room && useVoice.getState().channelId) {
        toast('Conexão de voz perdida');
        this.leave();
      }
    });

    try {
      await room.connect(url, token);
    } catch {
      toast('Não foi possível conectar ao servidor de voz');
      if (this.room === room) this.leave();
      return;
    }
    if (this.room !== room) {
      void room.disconnect();
      return;
    }
    await this.applyMicEnabled();
  }

  private lkTrack(track: RemoteTrack, participant: Participant, subscribed: boolean) {
    const { Track } = livekit!;
    const uid = participant.identity;
    const sid = track.sid ?? track.mediaStreamTrack.id;
    const kind: StreamKind =
      track.source === Track.Source.ScreenShare || track.source === Track.Source.ScreenShareAudio
        ? 'screen'
        : track.source === Track.Source.Camera
          ? 'camera'
          : 'audio';

    if (track.kind === Track.Kind.Audio) {
      if (subscribed) {
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
        this.lkAudio.set(sid, { track: track as RemoteAudioTrack, uid, kind: kind === 'screen' ? 'screen' : 'voice', el });
        this.applyGains(uid);
      } else {
        track.detach().forEach((el) => el.remove());
        this.lkAudio.delete(sid);
      }
      return;
    }

    useVoice.setState((s) => {
      const forUser = { ...s.remoteStreams[uid] };
      const kinds = { ...s.streamKinds[uid] };
      if (subscribed) {
        forUser[sid] = new MediaStream([track.mediaStreamTrack]);
        kinds[sid] = kind;
      } else {
        delete forUser[sid];
        delete kinds[sid];
      }
      return { remoteStreams: { ...s.remoteStreams, [uid]: forUser }, streamKinds: { ...s.streamKinds, [uid]: kinds } };
    });
  }

  private lkLocalStream(source: Track.Source): MediaStream | null {
    const track = this.room?.localParticipant.getTrackPublication(source)?.track?.mediaStreamTrack;
    return track ? new MediaStream([track]) : null;
  }

  // ---------- Mesh signaling ----------

  private signal(to: string, data: Signal) {
    gateway.send('voice_signal', { to, data });
  }

  onSignal(from: string, data: unknown) {
    const ui = useVoice.getState();
    if (!ui.channelId || this.isLiveKit()) return;
    const v = getState().voiceStates[from];
    if (!v || v.channel_id !== ui.channelId) return;
    const peer = this.ensurePeer(from);
    peer.queue = peer.queue
      .then(() => this.processSignal(from, peer, data as Signal))
      .catch((err) => console.warn('[voice] signal failed', err));
  }

  private async processSignal(uid: string, p: Peer, data: Signal) {
    const pc = p.pc;
    if (data.type === 'meta') {
      useVoice.setState((s) => ({ streamKinds: { ...s.streamKinds, [uid]: data.kinds } }));
      this.applyGains(uid); // a stream's kind decides which volume applies to it
      return;
    }
    if (data.type === 'description') {
      const desc = data.description;
      const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        this.signal(uid, { type: 'description', description: pc.localDescription!.toJSON() });
      }
      return;
    }
    if (data.type === 'candidate') {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!p.ignoreOffer) throw err;
      }
    }
  }

  // ---------- Mesh peers ----------

  private localStreams(): [MediaStream, StreamKind][] {
    const ui = useVoice.getState();
    const out: [MediaStream, StreamKind][] = [];
    if (this.mic) out.push([this.mic, 'audio']);
    if (ui.localCamera) out.push([ui.localCamera, 'camera']);
    if (ui.localScreen) out.push([ui.localScreen, 'screen']);
    return out;
  }

  private sendMeta(uid?: string) {
    const kinds = Object.fromEntries(this.localStreams().map(([s, k]) => [s.id, k]));
    for (const id of uid ? [uid] : [...this.peers.keys()]) this.signal(id, { type: 'meta', kinds });
  }

  private ensurePeer(uid: string): Peer {
    const existing = this.peers.get(uid);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = {
      pc,
      polite: this.meId() > uid,
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      senders: new Map(),
      outputs: new Map(),
    };
    this.peers.set(uid, peer);

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.signal(uid, { type: 'description', description: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn('[voice] negotiation failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.signal(uid, { type: 'candidate', candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => this.onTrack(uid, peer, e);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') pc.restartIce();
      useVoice.setState((s) => ({ connection: { ...s.connection, [uid]: pc.connectionState } }));
    };

    this.sendMeta(uid);
    for (const [stream] of this.localStreams()) {
      for (const track of stream.getTracks()) peer.senders.set(track.id, pc.addTrack(track, stream));
    }
    if (useVoice.getState().localScreen) setTimeout(() => this.tuneScreenSenders(), 1500);
    return peer;
  }

  private onTrack(uid: string, peer: Peer, e: RTCTrackEvent) {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    if (e.track.kind === 'audio' && !peer.outputs.has(stream.id)) {
      peer.outputs.set(stream.id, this.mixer.play(stream));
      this.applyGains(uid);
      const kind = useVoice.getState().streamKinds[uid]?.[stream.id];
      if (kind !== 'screen') this.watchSpeaking(uid, stream);
    }
    useVoice.setState((s) => ({
      remoteStreams: { ...s.remoteStreams, [uid]: { ...s.remoteStreams[uid], [stream.id]: stream } },
    }));
    const cleanup = () => {
      if (stream.getTracks().some((t) => t.readyState === 'live')) {
        useVoice.setState((s) => ({ remoteStreams: { ...s.remoteStreams } })); // re-render with fewer tracks
        return;
      }
      this.dropRemoteStream(uid, stream.id);
    };
    stream.onremovetrack = cleanup;
    e.track.addEventListener('ended', cleanup);
  }

  private dropRemoteStream(uid: string, streamId: string) {
    const peer = this.peers.get(uid);
    peer?.outputs.get(streamId)?.stop();
    peer?.outputs.delete(streamId);
    useVoice.setState((s) => {
      const forUser = s.remoteStreams[uid];
      if (!forUser?.[streamId]) return {};
      return { remoteStreams: { ...s.remoteStreams, [uid]: omit(forUser, streamId) } };
    });
  }

  private dropRemoteKind(uid: string, kind: StreamKind) {
    if (this.isLiveKit()) return; // LiveKit unsubscribes tracks itself
    const ui = useVoice.getState();
    for (const streamId of Object.keys(ui.remoteStreams[uid] ?? {})) {
      if (ui.streamKinds[uid]?.[streamId] === kind) this.dropRemoteStream(uid, streamId);
    }
  }

  private closePeer(uid: string) {
    const peer = this.peers.get(uid);
    if (!peer) return;
    peer.pc.close();
    for (const out of peer.outputs.values()) out.stop();
    this.peers.delete(uid);
    this.analysers.get(uid)?.();
    this.analysers.delete(uid);
    useVoice.setState((s) => ({
      remoteStreams: omit(s.remoteStreams, uid),
      streamKinds: omit(s.streamKinds, uid),
      speaking: omit(s.speaking, uid),
      connection: omit(s.connection, uid),
    }));
  }

  private publish(stream: MediaStream) {
    this.sendMeta();
    for (const peer of this.peers.values()) {
      for (const track of stream.getTracks()) peer.senders.set(track.id, peer.pc.addTrack(track, stream));
    }
  }

  private unpublish(stream: MediaStream) {
    for (const peer of this.peers.values()) {
      for (const track of stream.getTracks()) {
        const sender = peer.senders.get(track.id);
        if (sender && peer.pc.signalingState !== 'closed') peer.pc.removeTrack(sender);
        peer.senders.delete(track.id);
      }
    }
    stream.getTracks().forEach((t) => t.stop());
  }

  // ---------- Local controls ----------

  private micPrefs(): MicPrefs {
    return useVoice.getState();
  }

  /** Opens the microphone through our processing graph (see mic.ts). */
  private async openMic(deviceId: string): Promise<MediaStream> {
    const pipe = await MicPipeline.open(deviceId, micSettings(this.micPrefs()));
    if (pipe.denoiseFailed) toast('Supressão de ruído avançada indisponível neste computador.');
    this.pipe?.stop();
    this.pipe = pipe;
    return new MediaStream([pipe.track]);
  }

  private releaseMic() {
    this.pipe?.stop();
    this.pipe = null;
    this.mic = null;
  }

  /** Live microphone level for meters: null when no microphone is open. */
  micLevel(): { level: number; threshold: number | null; open: boolean } | null {
    const p = this.pipe;
    return p ? { level: p.level, threshold: p.threshold(), open: p.open } : null;
  }

  private lkMicTrack(): LocalAudioTrack | undefined {
    return this.room?.localParticipant.getTrackPublication(livekit!.Track.Source.Microphone)?.track as LocalAudioTrack | undefined;
  }

  private lkProcessor() {
    return micProcessor(
      () => micSettings(this.micPrefs()),
      (pipe) => {
        this.pipe = pipe;
      },
    );
  }

  /**
   * Changes microphone processing. Volume and sensitivity apply live; echo cancellation, noise
   * suppression and auto gain need the microphone reopened (done without leaving the call).
   */
  async setMicPrefs(patch: Partial<MicPrefs>) {
    const before = micSettings(this.micPrefs());
    useVoice.setState(patch);
    savePrefs();
    const after = micSettings(this.micPrefs());
    const reopen =
      before.echoCancellation !== after.echoCancellation ||
      before.noiseSuppression !== after.noiseSuppression ||
      before.autoGainControl !== after.autoGainControl;
    if (!reopen) {
      this.pipe?.setVolume(after.volume);
      this.pipe?.setGate(after.gate);
      return;
    }
    if (this.room) {
      const track = this.lkMicTrack();
      if (!track) return;
      try {
        await track.stopProcessor();
        await track.mediaStreamTrack.applyConstraints(micConstraints(useVoice.getState().inputDeviceId, after));
        await track.setProcessor(this.lkProcessor());
      } catch {
        toast('Não foi possível aplicar o ajuste do microfone');
      }
      return;
    }
    // Chrome hands out the already-open capture (with its old processing) while that track is alive.
    if (this.mic) await this.setInputDevice(useVoice.getState().inputDeviceId, true);
  }

  /** Quick switch (call popover / device menu): moves to the custom profile with this suppressor. */
  setNoiseSuppression(mode: NoiseMode) {
    const ui = useVoice.getState();
    const s = micSettings(ui);
    return this.setMicPrefs({
      inputProfile: 'custom',
      noiseSuppression: mode,
      echoCancellation: s.echoCancellation,
      autoGainControl: s.autoGainControl,
      sensitivityAuto: s.gate === 'auto',
      inputThreshold: typeof s.gate === 'number' ? s.gate : s.gate === null ? -100 : ui.inputThreshold,
    });
  }

  setOutputVolume(percent: number) {
    useVoice.setState({ outputVolume: Math.max(0, Math.min(200, Math.round(percent))) });
    savePrefs();
    this.applyGains();
  }

  // ---------- Push-to-talk ----------

  private pttRelease: ReturnType<typeof setTimeout> | null = null;

  /** Fed by the key/mouse listeners in components/PushToTalk.tsx. */
  pushToTalk(down: boolean) {
    const ui = useVoice.getState();
    if (!ui.pttEnabled || !ui.channelId) return;
    if (this.pttRelease) clearTimeout(this.pttRelease);
    this.pttRelease = null;
    const set = (active: boolean) => {
      if (useVoice.getState().pttActive === active) return;
      useVoice.setState({ pttActive: active });
      void this.applyMicEnabled();
    };
    if (down) set(true);
    else this.pttRelease = setTimeout(() => set(false), ui.pttDelay);
  }

  setPushToTalk(patch: Partial<Pick<VoiceUI, 'pttEnabled' | 'pttKey' | 'pttDelay'>>) {
    useVoice.setState({ ...patch, pttActive: false });
    savePrefs();
    void this.applyMicEnabled();
  }

  private async applyMicEnabled() {
    const { selfMute, selfDeaf, channelId, pttEnabled, pttActive } = useVoice.getState();
    const enabled = !selfMute && !selfDeaf && !this.suppressed() && (!pttEnabled || pttActive);
    this.mic?.getAudioTracks().forEach((t) => (t.enabled = enabled));
    if (this.room && channelId) {
      try {
        await this.room.localParticipant.setMicrophoneEnabled(enabled);
      } catch {
        if (enabled) toast('Não foi possível acessar o microfone');
      }
    }
  }

  private pushState() {
    const ui = useVoice.getState();
    if (!ui.channelId) return;
    gateway.send('voice_update', {
      self_mute: ui.selfMute,
      self_deaf: ui.selfDeaf,
      self_video: ui.selfVideo,
      self_stream: ui.selfStream,
    });
  }

  setMute(selfMute: boolean) {
    if (!selfMute && this.suppressed()) toast('Você não tem permissão para falar neste canal');
    const patch: Partial<VoiceUI> = { selfMute };
    if (!selfMute && useVoice.getState().selfDeaf) patch.selfDeaf = false; // unmuting also undeafens, like Discord
    useVoice.setState(patch);
    this.applyGains();
    void this.applyMicEnabled();
    (selfMute ? sounds.mute : sounds.unmute)();
    savePrefs();
    this.pushState();
  }

  setDeaf(selfDeaf: boolean) {
    useVoice.setState({ selfDeaf });
    this.applyGains();
    void this.applyMicEnabled();
    (selfDeaf ? sounds.mute : sounds.unmute)();
    savePrefs();
    this.pushState();
  }

  async toggleCamera() {
    const ui = useVoice.getState();
    if (!ui.channelId) return;
    const turnOn = !ui.localCamera;
    if (this.room) {
      try {
        await this.room.localParticipant.setCameraEnabled(turnOn);
        useVoice.setState({ localCamera: turnOn ? this.lkLocalStream(livekit!.Track.Source.Camera) : null, selfVideo: turnOn });
      } catch {
        toast('Não foi possível acessar a câmera');
        return;
      }
    } else if (!turnOn) {
      this.unpublish(ui.localCamera!);
      useVoice.setState({ localCamera: null, selfVideo: false });
      this.sendMeta();
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(ui.videoDeviceId) });
        useVoice.setState({ localCamera: stream, selfVideo: true });
        this.publish(stream);
      } catch {
        toast('Não foi possível acessar a câmera');
        return;
      }
    }
    this.pushState();
  }

  /**
   * Captures the screen with its audio, minus our own playback. `restrictOwnAudio` makes the system
   * audio loopback exclude this app's output (the call's voices), so others never hear themselves.
   * Measured in Electron 44 on Windows: our own tone drops from -71 dB to silence while other apps'
   * audio is still captured.
   */
  private async captureScreen(): Promise<MediaStream | null> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: this.screenConstraints(),
        audio: {
          restrictOwnAudio: true,
          // Voice processing ruins music and game audio.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);
    } catch {
      return null; // user cancelled the picker
    }
    const audio = stream.getAudioTracks()[0];
    const surface = (stream.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string }).displaySurface;
    const restricted = (audio?.getSettings() as (MediaTrackSettings & { restrictOwnAudio?: boolean }) | undefined)?.restrictOwnAudio;
    // Whole-screen audio without the exclusion would loop the call back to everyone: send video only.
    if (audio && surface === 'monitor' && restricted !== true) {
      stream.removeTrack(audio);
      audio.stop();
      toast('Este navegador não consegue separar o áudio da chamada; transmitindo só a imagem.');
    }
    this.applyScreenSettings(stream);
    return stream;
  }

  /** Resolution / frame-rate caps for the chosen quality. */
  private screenConstraints(): MediaTrackConstraints {
    const q = STREAM_QUALITIES[useVoice.getState().streamQuality];
    return {
      frameRate: { ideal: q.fps, max: q.fps },
      ...(q.width ? { width: { max: q.width }, height: { max: q.height } } : {}),
    };
  }

  private applyScreenSettings(stream: MediaStream) {
    const { streamQuality, streamAudio } = useVoice.getState();
    const video = stream.getVideoTracks()[0];
    // "detail" keeps text sharp (code, documents); "motion" keeps 60 FPS smooth (games, video).
    if (video) video.contentHint = STREAM_QUALITIES[streamQuality].fps >= 60 ? 'motion' : 'detail';
    for (const t of stream.getAudioTracks()) t.enabled = streamAudio;
  }

  /** Senders currently carrying our screen video (one per peer, or LiveKit's single one). */
  private screenSenders(): RTCRtpSender[] {
    const video = useVoice.getState().localScreen?.getVideoTracks()[0];
    if (!video) return [];
    if (this.room) {
      const pub = this.room.localParticipant.getTrackPublication(livekit!.Track.Source.ScreenShare);
      const sender = pub?.track?.sender;
      return sender ? [sender] : [];
    }
    return [...this.peers.values()].map((p) => p.senders.get(video.id)).filter((x): x is RTCRtpSender => !!x);
  }

  /** Bitrate / frame-rate caps on the encoder; encodings exist once negotiation has run. */
  private tuneScreenSenders() {
    const q = STREAM_QUALITIES[useVoice.getState().streamQuality];
    for (const sender of this.screenSenders()) {
      const params = sender.getParameters();
      if (!params.encodings?.length) continue;
      params.encodings[0].maxBitrate = q.bitrate;
      params.encodings[0].maxFramerate = q.fps;
      void sender.setParameters(params).catch(() => {});
    }
  }

  private async publishScreen(stream: MediaStream) {
    if (this.room) {
      const { Track } = livekit!;
      const q = STREAM_QUALITIES[useVoice.getState().streamQuality];
      const [video] = stream.getVideoTracks();
      const [audio] = stream.getAudioTracks();
      await this.room.localParticipant.publishTrack(video, {
        source: Track.Source.ScreenShare,
        name: 'screen',
        screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
      });
      if (audio) await this.room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio, name: 'screen-audio' });
      return;
    }
    this.publish(stream);
    setTimeout(() => this.tuneScreenSenders(), 1500);
  }

  private unpublishScreen(stream: MediaStream) {
    if (this.room) {
      for (const track of stream.getTracks()) void this.room.localParticipant.unpublishTrack(track, true);
    } else {
      this.unpublish(stream);
    }
  }

  async startScreenShare() {
    const ui = useVoice.getState();
    if (!ui.channelId || ui.localScreen) return;
    const stream = await this.captureScreen();
    if (!stream || useVoice.getState().channelId !== ui.channelId) {
      stream?.getTracks().forEach((t) => t.stop());
      return;
    }
    stream.getVideoTracks()[0]?.addEventListener('ended', () => this.stopScreenShare());
    useVoice.setState({ localScreen: stream, selfStream: true });
    try {
      await this.publishScreen(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      useVoice.setState({ localScreen: null, selfStream: false });
      toast('Não foi possível iniciar a transmissão');
      return;
    }
    this.pushState();
  }

  /** "Alterar a transmissão": picks another screen/window and swaps it in without ending the stream. */
  async replaceScreenShare() {
    const ui = useVoice.getState();
    if (!ui.localScreen) return this.startScreenShare();
    const next = await this.captureScreen();
    const old = useVoice.getState().localScreen;
    if (!next || !old || useVoice.getState().channelId !== ui.channelId) {
      next?.getTracks().forEach((t) => t.stop());
      return;
    }
    this.unpublishScreen(old); // stopping tracks ourselves doesn't fire "ended", so the share goes on
    next.getVideoTracks()[0]?.addEventListener('ended', () => this.stopScreenShare());
    useVoice.setState({ localScreen: next });
    try {
      await this.publishScreen(next);
    } catch {
      this.stopScreenShare();
      toast('Não foi possível trocar a transmissão');
    }
  }

  stopScreenShare() {
    const { localScreen } = useVoice.getState();
    if (!localScreen) return;
    this.unpublishScreen(localScreen);
    useVoice.setState({ localScreen: null, selfStream: false });
    this.sendMeta();
    this.pushState();
  }

  async setStreamQuality(quality: StreamQuality) {
    useVoice.setState({ streamQuality: quality });
    savePrefs();
    const { localScreen } = useVoice.getState();
    const video = localScreen?.getVideoTracks()[0];
    if (!localScreen || !video) return;
    this.applyScreenSettings(localScreen);
    await video.applyConstraints(this.screenConstraints()).catch(() => toast('Esta fonte não aceita essa qualidade'));
    this.tuneScreenSenders();
  }

  setStreamAudio(enabled: boolean) {
    useVoice.setState({ streamAudio: enabled });
    savePrefs();
    const { localScreen } = useVoice.getState();
    if (!localScreen) return;
    if (enabled && !localScreen.getAudioTracks().length) {
      toast('Esta transmissão foi iniciada sem áudio. Use "Alterar a transmissão" para capturar com som.');
    }
    this.applyScreenSettings(localScreen);
  }

  async setInputDevice(deviceId: string, releaseFirst = false) {
    useVoice.setState({ inputDeviceId: deviceId });
    savePrefs();
    if (this.room) {
      await this.room.switchActiveDevice('audioinput', deviceId || 'default').catch(() => toast('Não foi possível trocar o microfone'));
      return;
    }
    if (!this.mic) return;
    try {
      const oldTrack = this.mic.getAudioTracks()[0];
      const oldPipe = this.pipe;
      if (releaseFirst) oldPipe?.stop();
      const next = await this.openMic(deviceId); // replaces (and stops) this.pipe
      const newTrack = next.getAudioTracks()[0];
      for (const peer of this.peers.values()) {
        const sender = peer.senders.get(oldTrack.id);
        if (sender) {
          await sender.replaceTrack(newTrack);
          peer.senders.delete(oldTrack.id);
          peer.senders.set(newTrack.id, sender);
        }
      }
      this.mic.removeTrack(oldTrack);
      oldTrack.stop();
      this.mic.addTrack(newTrack);
      void this.applyMicEnabled();
      const me = this.meId();
      this.analysers.get(me)?.();
      this.analysers.delete(me);
      this.watchSpeaking(me, this.mic);
      // The transcription capture reads from the old track; restart it on the new one.
      this.capture?.stop();
      this.capture = null;
      this.syncTranscription();
    } catch {
      toast('Não foi possível trocar o microfone');
    }
  }

  async setVideoDevice(deviceId: string) {
    useVoice.setState({ videoDeviceId: deviceId });
    savePrefs();
    const { localCamera } = useVoice.getState();
    if (!localCamera) return;
    try {
      if (this.room) {
        await this.room.switchActiveDevice('videoinput', deviceId || 'default');
        useVoice.setState({ localCamera: this.lkLocalStream(livekit!.Track.Source.Camera) });
        return;
      }
      const next = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(deviceId) });
      const newTrack = next.getVideoTracks()[0];
      const oldTrack = localCamera.getVideoTracks()[0];
      // replaceTrack swaps the camera without renegotiating; the stream id (and its "camera" tag) stays the same.
      for (const peer of this.peers.values()) {
        const sender = oldTrack && peer.senders.get(oldTrack.id);
        if (sender) {
          await sender.replaceTrack(newTrack);
          peer.senders.delete(oldTrack.id);
          peer.senders.set(newTrack.id, sender);
        }
      }
      if (oldTrack) {
        localCamera.removeTrack(oldTrack);
        oldTrack.stop();
      }
      localCamera.addTrack(newTrack);
      useVoice.setState((s) => ({ deviceTick: s.deviceTick + 1 }));
    } catch {
      toast('Não foi possível trocar a câmera');
    }
  }

  setOutputDevice(deviceId: string) {
    useVoice.setState({ outputDeviceId: deviceId });
    savePrefs();
    if (this.room) {
      void this.room.switchActiveDevice('audiooutput', deviceId || 'default').catch(() => {});
      return;
    }
    this.mixer.setSink(deviceId);
  }

  // ---------- Per-person volume (local only) ----------

  /** Volume (0–2) for one of a person's audio streams: their voice or their screen share's audio. */
  private gainFor(uid: string, kind: 'voice' | 'screen'): number {
    const s = useVoice.getState();
    if (s.selfDeaf || getState().voiceStates[this.meId()]?.server_deaf) return 0;
    const master = s.outputVolume / 100;
    if (kind === 'screen') return s.streamMuted[uid] ? 0 : ((s.streamVolumes[uid] ?? 100) / 100) * master;
    return s.localMuted[uid] ? 0 : ((s.userVolumes[uid] ?? 100) / 100) * master;
  }

  /** Re-applies volumes to everything playing (or only one person's streams). */
  private applyGains(uid?: string) {
    const { streamKinds } = useVoice.getState();
    for (const [peerId, peer] of this.peers) {
      if (uid && peerId !== uid) continue;
      for (const [streamId, out] of peer.outputs) {
        out.setGain(this.gainFor(peerId, streamKinds[peerId]?.[streamId] === 'screen' ? 'screen' : 'voice'));
      }
    }
    for (const a of this.lkAudio.values()) {
      if (!uid || a.uid === uid) a.track.setVolume(this.gainFor(a.uid, a.kind));
    }
  }

  setUserVolume(uid: string, percent: number) {
    const value = Math.max(0, Math.min(200, Math.round(percent)));
    useVoice.setState((s) => ({ userVolumes: { ...s.userVolumes, [uid]: value }, localMuted: { ...s.localMuted, [uid]: false } }));
    this.applyGains(uid);
    savePrefs();
  }

  toggleLocalMute(uid: string) {
    useVoice.setState((s) => ({ localMuted: { ...s.localMuted, [uid]: !s.localMuted[uid] } }));
    this.applyGains(uid);
    savePrefs();
  }

  setStreamVolume(uid: string, percent: number) {
    const value = Math.max(0, Math.min(200, Math.round(percent)));
    useVoice.setState((s) => ({ streamVolumes: { ...s.streamVolumes, [uid]: value }, streamMuted: { ...s.streamMuted, [uid]: false } }));
    this.applyGains(uid);
    savePrefs();
  }

  toggleStreamMute(uid: string) {
    useVoice.setState((s) => ({ streamMuted: { ...s.streamMuted, [uid]: !s.streamMuted[uid] } }));
    this.applyGains(uid);
    savePrefs();
  }

  // ---------- Speaking indicator (mesh; LiveKit reports active speakers itself) ----------

  private watchSpeaking(uid: string, stream: MediaStream) {
    if (this.analysers.has(uid) || !stream.getAudioTracks().length) return;
    try {
      const ctx = this.mixer.context();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      let speaking = false;
      let lastLoud = 0;
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const x = (v - 128) / 128;
          sum += x * x;
        }
        const now = Date.now();
        if (Math.sqrt(sum / data.length) > 0.025) lastLoud = now;
        const next = now - lastLoud < 300;
        if (next !== speaking) {
          speaking = next;
          useVoice.setState((s) => ({ speaking: { ...s.speaking, [uid]: next } }));
        }
      }, 80);
      this.analysers.set(uid, () => {
        clearInterval(timer);
        source.disconnect();
      });
    } catch {
      /* AudioContext unavailable */
    }
  }
}

export const voice = new VoiceManager();
