import type { Participant, RemoteTrack, Room, Track } from 'livekit-client';
import { create } from 'zustand';
import { api } from './api';
import { gateway } from './gateway';
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
}

const PREFS_KEY = 'concord.voice';

function loadPrefs() {
  const defaults = { selfMute: false, selfDeaf: false, inputDeviceId: '', outputDeviceId: '', videoDeviceId: '', userVolumes: {}, localMuted: {} };
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
  ...loadPrefs(),
}));

function savePrefs() {
  const { selfMute, selfDeaf, inputDeviceId, outputDeviceId, videoDeviceId, userVolumes, localMuted } = useVoice.getState();
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ selfMute, selfDeaf, inputDeviceId, outputDeviceId, videoDeviceId, userVolumes, localMuted }));
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
  audioEls: Map<string, HTMLAudioElement>;
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
  private lkAudio = new Map<string, HTMLMediaElement>();
  // shared
  private analysers = new Map<string, () => void>();
  private audioCtx: AudioContext | null = null;
  private boost = new WeakMap<HTMLMediaElement, GainNode>();
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
      this.mic?.getTracks().forEach((t) => t.stop());
      this.mic = null;
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
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    if (this.room) {
      const room = this.room;
      this.room = null;
      void room.disconnect();
    }
    for (const el of this.lkAudio.values()) el.remove();
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
      audioCaptureDefaults: {
        deviceId: ui.inputDeviceId || undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
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
        el.muted = useVoice.getState().selfDeaf;
        el.style.display = 'none';
        el.dataset.uid = uid;
        document.body.appendChild(el);
        this.lkAudio.set(sid, el);
        this.applyUserVolume(uid);
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
      audioEls: new Map(),
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
    return peer;
  }

  private onTrack(uid: string, peer: Peer, e: RTCTrackEvent) {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    if (e.track.kind === 'audio' && !peer.audioEls.has(stream.id)) {
      const el = new Audio();
      el.autoplay = true;
      el.srcObject = stream;
      el.muted = useVoice.getState().selfDeaf;
      this.applySink(el);
      peer.audioEls.set(stream.id, el);
      this.applyUserVolume(uid);
      void el.play().catch(() => {});
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
    const el = peer?.audioEls.get(streamId);
    if (el) {
      el.pause();
      el.srcObject = null;
      peer!.audioEls.delete(streamId);
    }
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
    for (const el of peer.audioEls.values()) {
      el.pause();
      el.srcObject = null;
    }
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

  private async openMic(deviceId: string): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  private async applyMicEnabled() {
    const { selfMute, selfDeaf, channelId } = useVoice.getState();
    const enabled = !selfMute && !selfDeaf && !this.suppressed();
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
    this.applyDeafen();
    void this.applyMicEnabled();
    (selfMute ? sounds.mute : sounds.unmute)();
    savePrefs();
    this.pushState();
  }

  setDeaf(selfDeaf: boolean) {
    useVoice.setState({ selfDeaf });
    this.applyDeafen();
    void this.applyMicEnabled();
    (selfDeaf ? sounds.mute : sounds.unmute)();
    savePrefs();
    this.pushState();
  }

  private applyDeafen() {
    const { selfDeaf } = useVoice.getState();
    for (const peer of this.peers.values()) for (const el of peer.audioEls.values()) el.muted = selfDeaf;
    for (const el of this.lkAudio.values()) el.muted = selfDeaf;
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
        video: { frameRate: 30 },
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
    return stream;
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

    if (this.room) {
      const { Track } = livekit!;
      try {
        const [video] = stream.getVideoTracks();
        const [audio] = stream.getAudioTracks();
        await this.room.localParticipant.publishTrack(video, { source: Track.Source.ScreenShare, name: 'screen' });
        if (audio) await this.room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio, name: 'screen-audio' });
      } catch {
        stream.getTracks().forEach((t) => t.stop());
        toast('Não foi possível iniciar a transmissão');
        return;
      }
      useVoice.setState({ localScreen: stream, selfStream: true });
      this.pushState();
      return;
    }

    useVoice.setState({ localScreen: stream, selfStream: true });
    this.publish(stream);
    this.pushState();
  }

  stopScreenShare() {
    const { localScreen } = useVoice.getState();
    if (!localScreen) return;
    if (this.room) {
      for (const track of localScreen.getTracks()) void this.room.localParticipant.unpublishTrack(track, true);
    } else {
      this.unpublish(localScreen);
    }
    useVoice.setState({ localScreen: null, selfStream: false });
    this.sendMeta();
    this.pushState();
  }

  async setInputDevice(deviceId: string) {
    useVoice.setState({ inputDeviceId: deviceId });
    savePrefs();
    if (this.room) {
      await this.room.switchActiveDevice('audioinput', deviceId || 'default').catch(() => toast('Não foi possível trocar o microfone'));
      return;
    }
    if (!this.mic) return;
    try {
      const next = await this.openMic(deviceId);
      const oldTrack = this.mic.getAudioTracks()[0];
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
    for (const peer of this.peers.values()) for (const el of peer.audioEls.values()) this.applySink(el);
    this.applyContextSink();
  }

  // ---------- Per-person volume (local only) ----------

  /** Elements currently playing this person's audio, in either backend. */
  private audioFor(uid: string): HTMLMediaElement[] {
    const els: HTMLMediaElement[] = [...(this.peers.get(uid)?.audioEls.values() ?? [])];
    for (const el of this.lkAudio.values()) if (el.dataset.uid === uid) els.push(el);
    return els;
  }

  /**
   * <audio>.volume tops out at 100%. To go up to 200% the element is routed through a GainNode, created
   * only when somebody actually boosts (a media element can't be detached from the graph afterwards).
   */
  private applyUserVolume(uid: string) {
    const { userVolumes, localMuted } = useVoice.getState();
    const gain = localMuted[uid] ? 0 : (userVolumes[uid] ?? 100) / 100;
    for (const el of this.audioFor(uid)) {
      let node = this.boost.get(el);
      if (!node && gain > 1) {
        try {
          this.audioCtx ??= new AudioContext();
          if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
          node = this.audioCtx.createGain();
          this.audioCtx.createMediaElementSource(el).connect(node);
          node.connect(this.audioCtx.destination);
          this.boost.set(el, node);
          this.applyContextSink();
        } catch {
          /* no WebAudio: stay at 100% */
        }
      }
      if (node) {
        el.volume = 1;
        node.gain.value = gain;
      } else {
        el.volume = Math.min(1, gain);
      }
    }
  }

  private applyContextSink() {
    const ctx = this.audioCtx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    const { outputDeviceId } = useVoice.getState();
    if (ctx?.setSinkId) void ctx.setSinkId(outputDeviceId || '').catch(() => {});
  }

  setUserVolume(uid: string, percent: number) {
    const value = Math.max(0, Math.min(200, Math.round(percent)));
    useVoice.setState((s) => ({ userVolumes: { ...s.userVolumes, [uid]: value } }));
    this.applyUserVolume(uid);
    savePrefs();
  }

  toggleLocalMute(uid: string) {
    useVoice.setState((s) => ({ localMuted: { ...s.localMuted, [uid]: !s.localMuted[uid] } }));
    this.applyUserVolume(uid);
    savePrefs();
  }

  private applySink(el: HTMLAudioElement) {
    const { outputDeviceId } = useVoice.getState();
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (outputDeviceId && withSink.setSinkId) void withSink.setSinkId(outputDeviceId).catch(() => {});
  }

  // ---------- Speaking indicator (mesh; LiveKit reports active speakers itself) ----------

  private watchSpeaking(uid: string, stream: MediaStream) {
    if (this.analysers.has(uid) || !stream.getAudioTracks().length) return;
    try {
      this.audioCtx ??= new AudioContext();
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
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
