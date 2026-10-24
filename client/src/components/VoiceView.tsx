import {
  ArrowLeft,
  Captions,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  Trash2,
  HeadphoneOff,
  Headphones,
  Maximize2,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  PhoneOff,
  PictureInPicture2,
  ScrollText,
  SlidersHorizontal,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { P, has } from '../permissions';
import { channelLabel, closeModal, getState, isUnread, nameOf, openModal, toast, useStore } from '../store';
import type { Channel, SavedTranscript, TranscriptEntry } from '../types';
import { cx } from '../utils';
import { STREAM_QUALITIES, type StreamKind, savePrefs, transcriptionAvailable, useVoice, voice } from '../voice';
import { Avatar, MobileBack, ResizablePanel, Spinner, useLongPress } from './common';
import { DeviceMenu } from './DeviceMenu';
import { onScreenShareClick } from './StreamMenu';
import { keyLabel } from './PushToTalk';
import { Composer } from './Composer';
import { MessageList, TypingIndicator } from './ChatView';
import { openVoiceUserMenu, openVoiceUserMenuAt } from './VoiceUserMenu';

function VideoEl({ stream, mirror = false, contain = false }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const trackId = stream.getVideoTracks()[0]?.id;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Re-assign when the camera track inside the same stream was swapped.
    el.srcObject = null;
    el.srcObject = stream;
  }, [stream, trackId]);
  return <video ref={ref} autoPlay playsInline muted className={cx(mirror && 'mirror', contain && 'contain')} />;
}

interface Tile {
  key: string;
  userId: string;
  kind: 'user' | 'screen';
  stream: MediaStream | null;
}

function hasVideo(stream: MediaStream): boolean {
  return stream.getVideoTracks().some((t) => t.readyState === 'live');
}

function useParticipants(channelId: string): string[] {
  return useStore(
    useShallow((s) =>
      Object.values(s.voiceStates)
        .filter((v) => v.channel_id === channelId)
        .map((v) => v.user_id),
    ),
  );
}

function useTiles(channelId: string): Tile[] {
  const meId = useStore((s) => s.me?.id ?? '');
  const participants = useParticipants(channelId);
  const connectedHere = useVoice((s) => s.channelId === channelId);
  const localCamera = useVoice((s) => s.localCamera);
  const localScreen = useVoice((s) => s.localScreen);
  useVoice((s) => s.deviceTick);
  const remote = useVoice((s) => s.remoteStreams);
  const kinds = useVoice((s) => s.streamKinds);

  const tiles: Tile[] = [];
  for (const uid of participants) {
    let camera: MediaStream | null = null;
    const screens: MediaStream[] = [];
    if (uid === meId && connectedHere) {
      camera = localCamera;
      if (localScreen) screens.push(localScreen);
    } else {
      for (const [streamId, stream] of Object.entries(remote[uid] ?? {})) {
        if (!hasVideo(stream)) continue;
        const kind: StreamKind = kinds[uid]?.[streamId] ?? 'camera';
        if (kind === 'screen') screens.push(stream);
        else camera = stream;
      }
    }
    tiles.push({ key: `u-${uid}`, userId: uid, kind: 'user', stream: camera });
    screens.forEach((s, i) => tiles.push({ key: `s-${uid}-${i}`, userId: uid, kind: 'screen', stream: s }));
  }
  return tiles;
}

function useFullscreen(ref: React.RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onChange = () => setActive(!!ref.current && document.fullscreenElement === ref.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [ref]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void ref.current?.requestFullscreen().catch(() => toast('Não foi possível abrir em tela cheia'));
  };
  return [active, toggle] as const;
}

function TileView({
  tile,
  guildId,
  focused,
  onFocus,
  style,
}: {
  tile: Tile;
  guildId: string | null;
  focused: boolean;
  onFocus: () => void;
  style?: React.CSSProperties;
}) {
  const name = useStore((s) => nameOf(s, tile.userId, guildId));
  const state = useStore((s) => s.voiceStates[tile.userId]);
  const speaking = useVoice((s) => !!s.speaking[tile.userId]);
  const meId = useStore((s) => s.me?.id);
  const isScreen = tile.kind === 'screen';
  const isMine = tile.userId === meId;
  const streamMuted = useVoice((s) => !!s.streamMuted[tile.userId]);
  const ref = useRef<HTMLDivElement>(null);
  const [fullscreen, toggleFullscreen] = useFullscreen(ref);
  const longPress = useLongPress((x, y) => openVoiceUserMenuAt(x, y, tile.userId, guildId));
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      ref={ref}
      style={style}
      className={cx('voice-tile', speaking && !isScreen && 'speaking', focused && 'focused', isScreen && 'screen', fullscreen && 'fullscreen')}
      onClick={fullscreen ? undefined : onFocus}
      onDoubleClick={tile.stream ? toggleFullscreen : undefined}
      onContextMenu={(e) => openVoiceUserMenu(e, tile.userId, guildId)}
      {...longPress}
    >
      {tile.stream ? (
        <VideoEl stream={tile.stream} mirror={!isScreen && tile.userId === meId} contain={isScreen} />
      ) : (
        <div className={cx('voice-tile-avatar', speaking && 'speaking')}>
          <Avatar userId={tile.userId} size={72} guildId={guildId} />
        </div>
      )}
      <div className="voice-tile-label">
        {isScreen ? (
          <Monitor size={13} />
        ) : state?.self_deaf ? (
          <HeadphoneOff size={13} />
        ) : state?.self_mute || state?.suppress ? (
          <MicOff size={13} />
        ) : null}
        <span className="truncate">{isScreen ? `Tela de ${name}` : name}</span>
      </div>
      {isScreen && <span className="live-badge tile-live">Ao vivo</span>}
      <div className="voice-tile-actions">
        {isScreen && !isMine && (
          <button
            className={cx('icon-btn', streamMuted && 'danger')}
            title={streamMuted ? 'Reativar o som da transmissão' : 'Silenciar transmissão'}
            onClick={stop(() => voice.toggleStreamMute(tile.userId))}
          >
            {streamMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        )}
        {tile.stream && !fullscreen && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled && (
          <button
            className="icon-btn"
            title="Abrir em janela flutuante"
            onClick={stop(() => {
              const video = ref.current?.querySelector('video');
              void video?.requestPictureInPicture().catch(() => toast('Não foi possível abrir a janela flutuante'));
            })}
          >
            <PictureInPicture2 size={15} />
          </button>
        )}
        {tile.stream && (
          <button className="icon-btn" title={fullscreen ? 'Sair da tela cheia (Esc)' : 'Tela cheia'} onClick={stop(toggleFullscreen)}>
            {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        )}
        <button className="icon-btn" title="Opções do usuário" onClick={(e) => openVoiceUserMenu(e, tile.userId, guildId)}>
          <SlidersHorizontal size={15} />
        </button>
      </div>
    </div>
  );
}

/** Last lines spoken in the call, shown over the stage like subtitles. */
function LiveCaptions({ channelId, guildId }: { channelId: string; guildId: string | null }) {
  const entries = useStore(useShallow((s) => s.transcriptions[channelId]?.entries.slice(-2) ?? []));
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const recent = entries.filter((e) => now - e.at < 12_000);
  if (!recent.length) return null;
  return (
    <div className="live-captions">
      {recent.map((e) => (
        <div key={e.id} className="caption-line">
          <strong>{nameOf(getState(), e.user_id, guildId)}:</strong> {e.text}
        </div>
      ))}
    </div>
  );
}

function TranscribingBanner({ channelId, guildId }: { channelId: string; guildId: string | null }) {
  const t = useStore((s) => s.transcriptions[channelId]);
  const by = useStore((s) => (t?.started_by ? nameOf(s, t.started_by, guildId) : ''));
  if (!t?.active) return null;
  return (
    <div className="transcribing-banner" title="As falas de todos na chamada estão sendo convertidas em texto">
      <span className="rec-dot" /> Transcrevendo{by ? ` · iniciado por ${by}` : ''}
    </div>
  );
}

function setHideNoVideo(hideNoVideo: boolean) {
  useVoice.setState({ hideNoVideo });
  savePrefs();
}

const GRID_GAP = 14;

/**
 * Discord-style grid: every tile is 16:9, and the column count is whichever makes the tiles largest
 * in the space available. Re-measured when the stage resizes (window, side panel drag).
 */
function useGridTileSize(ref: React.RefObject<HTMLElement | null>, count: number) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !count) return;
    const measure = () => {
      const { width: W, height: H } = el.getBoundingClientRect();
      let best = 0;
      for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        const w = Math.min((W - GRID_GAP * (cols - 1)) / cols, ((H - GRID_GAP * (rows - 1)) / rows) * (16 / 9));
        best = Math.max(best, w);
      }
      best = Math.floor(Math.max(best, 0));
      setSize((s) => (s.width === best ? s : { width: best, height: Math.floor((best * 9) / 16) }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, count]);
  return size;
}

export function VoiceStage({ channel, compact = false }: { channel: Channel; compact?: boolean }) {
  const allTiles = useTiles(channel.id);
  const hideNoVideo = useVoice((s) => s.hideNoVideo);
  const tiles = hideNoVideo ? allTiles.filter((t) => t.stream) : allTiles;
  const [focus, setFocus] = useState<string | null>(null);
  const focused = tiles.find((t) => t.key === focus);
  const label = channel.type === 'voice' ? channel.name : 'esta chamada';
  const gridRef = useRef<HTMLDivElement>(null);
  const tileSize = useGridTileSize(gridRef, focused ? 0 : tiles.length);

  return (
    <div className={cx('voice-stage', focused && 'has-focus', compact && 'compact')}>
      <TranscribingBanner channelId={channel.id} guildId={channel.guild_id} />
      {allTiles.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">
            <Volume2 size={32} />
          </div>
          <h2>{label}</h2>
          <p className="muted">Ninguém está aqui ainda. Entre para começar a conversa.</p>
        </div>
      )}
      {allTiles.length > 0 && tiles.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">
            <EyeOff size={32} />
          </div>
          <h2>Ninguém com câmera ou tela</h2>
          <p className="muted">Os participantes sem vídeo estão ocultos.</p>
          <button className="btn btn-secondary" onClick={() => setHideNoVideo(false)}>
            Mostrar todos
          </button>
        </div>
      )}
      {focused ? (
        <>
          <div className="voice-focus">
            <TileView tile={focused} guildId={channel.guild_id} focused onFocus={() => setFocus(null)} />
          </div>
          <div className="voice-strip">
            {tiles
              .filter((t) => t.key !== focus)
              .map((t) => (
                <TileView key={t.key} tile={t} guildId={channel.guild_id} focused={false} onFocus={() => setFocus(t.key)} />
              ))}
          </div>
        </>
      ) : (
        tiles.length > 0 && (
          <div className="voice-grid" ref={gridRef} style={{ gap: GRID_GAP }}>
            {tiles.map((t) => (
              <TileView
                key={t.key}
                tile={t}
                guildId={channel.guild_id}
                focused={false}
                onFocus={() => setFocus(t.key)}
                style={tileSize.width ? tileSize : { visibility: 'hidden' }}
              />
            ))}
          </div>
        )
      )}
      <LiveCaptions channelId={channel.id} guildId={channel.guild_id} />
    </div>
  );
}

function ControlWithMenu({ kind, children }: { kind: 'audio' | 'video'; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="control-group">
      {children}
      <button className="control-caret" title={kind === 'audio' ? 'Dispositivos de áudio' : 'Escolher câmera'} onClick={() => setOpen(!open)}>
        <ChevronUp size={14} />
      </button>
      {open && <DeviceMenu kind={kind} onClose={() => setOpen(false)} />}
    </div>
  );
}

export function VoiceControls({ channel, floating = true }: { channel: Channel; floating?: boolean }) {
  const connected = useVoice((s) => s.channelId === channel.id);
  const selfMute = useVoice((s) => s.selfMute);
  const selfDeaf = useVoice((s) => s.selfDeaf);
  const selfVideo = useVoice((s) => s.selfVideo);
  const selfStream = useVoice((s) => s.selfStream);
  const transcriptOpen = useVoice((s) => s.transcriptOpen);
  const transcribing = useStore((s) => !!s.transcriptions[channel.id]?.active);
  const suppressed = useStore((s) => !!(s.me && s.voiceStates[s.me.id]?.suppress));
  const pttKey = useVoice((s) => (s.pttEnabled ? s.pttKey : ''));
  const pttActive = useVoice((s) => s.pttActive);
  const ptt = pttKey ? { key: pttKey, active: pttActive } : null;
  const canStream = has(channel.permissions, P.STREAM);
  const canConnect = has(channel.permissions, P.CONNECT);

  if (!connected) {
    return (
      <div className={cx('voice-controls', floating && 'floating')}>
        <button className="btn btn-success" disabled={!canConnect} onClick={() => void voice.join(channel.guild_id, channel.id)}>
          {canConnect ? (channel.type === 'voice' ? 'Entrar na voz' : 'Entrar na chamada') : 'Sem permissão para conectar'}
        </button>
      </div>
    );
  }

  function toggleTranscription() {
    void voice.setTranscription(!transcribing);
    if (!transcribing) useVoice.setState({ transcriptOpen: true });
  }

  return (
    <div className={cx('voice-controls', floating && 'floating')}>
      <ControlWithMenu kind="audio">
        <button
          className={cx('control-btn', (selfMute || suppressed) && 'off', ptt?.active && !selfMute && 'talking')}
          title={
            suppressed
              ? 'Você não tem permissão para falar aqui'
              : selfMute
                ? 'Ativar microfone'
                : ptt
                  ? `Apertar para falar: segure ${keyLabel(ptt.key)} (clique para silenciar)`
                  : 'Silenciar'
          }
          onClick={() => voice.setMute(!selfMute)}
        >
          {selfMute || suppressed ? <MicOff size={19} /> : <Mic size={19} />}
        </button>
      </ControlWithMenu>
      <button className={cx('control-btn', selfDeaf && 'off')} title={selfDeaf ? 'Ativar áudio' : 'Ensurdecer'} onClick={() => voice.setDeaf(!selfDeaf)}>
        {selfDeaf ? <HeadphoneOff size={19} /> : <Headphones size={19} />}
      </button>
      {canStream && (
        <>
          <ControlWithMenu kind="video">
            <button className={cx('control-btn', selfVideo && 'on')} title={selfVideo ? 'Desligar câmera' : 'Ligar câmera'} onClick={() => void voice.toggleCamera()}>
              {selfVideo ? <Video size={19} /> : <VideoOff size={19} />}
            </button>
          </ControlWithMenu>
          <button className={cx('control-btn', selfStream && 'on')} title={selfStream ? 'Opções da transmissão' : 'Compartilhar tela'} onClick={onScreenShareClick}>
            {selfStream ? <MonitorOff size={19} /> : <Monitor size={19} />}
          </button>
        </>
      )}
      {transcriptionAvailable() && (
        <button
          className={cx('control-btn', transcribing && 'rec')}
          title={transcribing ? 'Parar transcrição' : 'Transcrever a chamada'}
          onClick={toggleTranscription}
        >
          <Captions size={19} />
        </button>
      )}
      {transcriptionAvailable() && (
        <button
          className={cx('control-btn', transcriptOpen && 'on')}
          title="Ver transcrição"
          onClick={() => useVoice.setState({ transcriptOpen: !transcriptOpen })}
        >
          <ScrollText size={19} />
        </button>
      )}
      <span className="control-divider" />
      <button className="control-btn hangup" title="Desconectar" onClick={() => voice.leave()}>
        <PhoneOff size={19} />
      </button>
    </div>
  );
}

function formatClock(ts: number) {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function downloadTranscript(channel: Channel, startedAt: number, entries: TranscriptEntry[]) {
  const s = getState();
  const title = channelLabel(s, channel);
  const lines = entries.map((e) => `[${formatClock(e.at)}] ${nameOf(s, e.user_id, channel.guild_id)}: ${e.text}`);
  const date = new Date(startedAt).toLocaleString('pt-BR');
  const blob = new Blob([`Transcrição — ${title}\nIniciada em ${date}\n\n${lines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `transcricao-${title.replace(/[^\p{L}\p{N}]+/gu, '-')}-${new Date(startedAt).toISOString().slice(0, 10)}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function formatDuration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`;
}

function useAutoScroll(dep: number) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [dep]);
  return ref;
}

function LiveTranscript({ channel }: { channel: Channel }) {
  const t = useStore((s) => s.transcriptions[channel.id]);
  const entries = t?.entries ?? [];
  const inCall = useVoice((s) => s.channelId === channel.id);
  const listRef = useAutoScroll(entries.length);
  return (
    <>
      {entries.length > 0 && (
        <div className="transcript-toolbar">
          <span className="small muted">{entries.length} falas</span>
          <button className="btn btn-secondary small" onClick={() => downloadTranscript(channel, t?.started_at ?? Date.now(), entries)}>
            <Download size={14} /> Baixar .txt
          </button>
        </div>
      )}
      <div className="transcript-list scroll" ref={listRef}>
        {!entries.length && (
          <div className="transcript-empty">
            <Captions size={28} />
            {t?.active ? (
              <p>Ouvindo… As falas aparecem aqui alguns segundos depois de cada frase.</p>
            ) : (
              <>
                <p>
                  Transforme a conversa em texto, com o nome de quem falou. O áudio é processado no seu servidor e a transcrição fica salva neste canal (aba
                  “Salvas”), visível para quem pode ver o canal.
                </p>
                {inCall && (
                  <button className="btn btn-primary small" onClick={() => void voice.setTranscription(true)}>
                    Iniciar transcrição
                  </button>
                )}
              </>
            )}
          </div>
        )}
        {entries.map((e) => (
          <TranscriptLine key={e.id} userId={e.user_id} guildId={channel.guild_id} at={e.at} text={e.text} />
        ))}
      </div>
    </>
  );
}

function SavedList({ channel, onOpen }: { channel: Channel; onOpen: (id: string) => void }) {
  const [items, setItems] = useState<SavedTranscript[] | null>(null);
  // Refresh when a live session starts or ends.
  const liveKey = useStore((s) => `${s.transcriptions[channel.id]?.active}-${s.transcriptions[channel.id]?.entries.length ?? 0}`);
  useEffect(() => {
    api<SavedTranscript[]>(`/channels/${channel.id}/transcripts`)
      .then(setItems)
      .catch((e: Error) => toast(e.message));
  }, [channel.id, liveKey]);

  if (!items) return <div className="center pad"><Spinner /></div>;
  if (!items.length) {
    return (
      <div className="transcript-empty">
        <ScrollText size={28} />
        <p>Nenhuma transcrição salva neste canal ainda. Elas aparecem aqui assim que alguém transcreve uma chamada.</p>
      </div>
    );
  }
  return (
    <div className="transcript-list scroll">
      {items.map((t) => (
        <SavedCard key={t.id} t={t} guildId={channel.guild_id} onOpen={() => onOpen(t.id)} />
      ))}
    </div>
  );
}

function SavedCard({ t, guildId, onOpen }: { t: SavedTranscript; guildId: string | null; onOpen: () => void }) {
  const names = useStore((s) => t.speaker_ids.map((id) => nameOf(s, id, guildId)).join(', '));
  const date = new Date(t.started_at).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <button className="saved-card" onClick={onOpen}>
      <div className="row gap-8">
        <strong>{date}</strong>
        {t.active ? <span className="live-badge">Em andamento</span> : <span className="small muted">{formatDuration((t.ended_at ?? Date.now()) - t.started_at)}</span>}
      </div>
      <div className="saved-card-meta">
        <span className="avatar-stack">
          {t.speaker_ids.slice(0, 4).map((id) => (
            <Avatar key={id} userId={id} size={20} guildId={guildId} />
          ))}
        </span>
        <span className="small muted truncate">
          {t.entry_count} falas · {names}
        </span>
      </div>
    </button>
  );
}

function SavedDetail({ channel, id, onBack }: { channel: Channel; id: string; onBack: () => void }) {
  const [t, setT] = useState<SavedTranscript | null>(null);
  const meId = useStore((s) => s.me?.id);
  const listRef = useAutoScroll(t?.entries?.length ?? 0);
  useEffect(() => {
    api<SavedTranscript>(`/transcripts/${id}`)
      .then(setT)
      .catch((e: Error) => toast(e.message));
  }, [id]);

  const canDelete = !!t && (t.started_by === meId || (!!channel.guild_id && has(channel.permissions, P.MANAGE_MESSAGES)));
  const remove = () =>
    openModal({
      type: 'confirm',
      title: 'Excluir transcrição',
      body: 'A transcrição será apagada para todos. Isso não pode ser desfeito.',
      confirmLabel: 'Excluir',
      onConfirm: async () => {
        await api(`/transcripts/${id}`, { method: 'DELETE' });
        closeModal();
        onBack();
      },
    });

  return (
    <>
      <div className="transcript-toolbar">
        <button className="icon-btn" title="Voltar" onClick={onBack}>
          <ArrowLeft size={17} />
        </button>
        <span className="small muted grow truncate">{t ? new Date(t.started_at).toLocaleString('pt-BR') : ''}</span>
        <button className="icon-btn" title="Baixar .txt" disabled={!t?.entries?.length} onClick={() => t && downloadTranscript(channel, t.started_at, t.entries ?? [])}>
          <Download size={17} />
        </button>
        {canDelete && (
          <button className="icon-btn danger" title="Excluir" onClick={remove}>
            <Trash2 size={17} />
          </button>
        )}
      </div>
      <div className="transcript-list scroll" ref={listRef}>
        {!t && (
          <div className="center pad">
            <Spinner />
          </div>
        )}
        {t?.entries?.map((e) => <TranscriptLine key={e.id} userId={e.user_id} guildId={channel.guild_id} at={e.at} text={e.text} />)}
      </div>
    </>
  );
}

export function TranscriptPanel({ channel }: { channel: Channel }) {
  const active = useStore((s) => !!s.transcriptions[channel.id]?.active);
  const inCall = useVoice((s) => s.channelId === channel.id);
  const [tab, setTab] = useState<'live' | 'saved'>(inCall || active ? 'live' : 'saved');
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <aside className="side-panel transcript-panel">
      <div className="popout-header">
        <div className="segmented">
          <button className={cx(tab === 'live' && 'active')} onClick={() => setTab('live')}>
            {active && <span className="rec-dot" />} Ao vivo
          </button>
          <button
            className={cx(tab === 'saved' && 'active')}
            onClick={() => {
              setTab('saved');
              setOpenId(null);
            }}
          >
            Salvas
          </button>
        </div>
        <button className="icon-btn" title="Fechar" onClick={() => useVoice.setState({ transcriptOpen: false })}>
          <X size={17} />
        </button>
      </div>
      {tab === 'live' ? (
        <LiveTranscript channel={channel} />
      ) : openId ? (
        <SavedDetail channel={channel} id={openId} onBack={() => setOpenId(null)} />
      ) : (
        <SavedList channel={channel} onOpen={setOpenId} />
      )}
    </aside>
  );
}

function TranscriptLine({ userId, guildId, at, text }: { userId: string; guildId: string | null; at: number; text: string }) {
  const name = useStore((s) => nameOf(s, userId, guildId));
  return (
    <div className="transcript-line">
      <Avatar userId={userId} size={28} guildId={guildId} />
      <div className="transcript-text">
        <div className="row gap-8">
          <strong>{name}</strong>
          <span className="small muted">{formatClock(at)}</span>
        </div>
        <p>{text}</p>
      </div>
    </div>
  );
}

/** Text chat of the voice channel, shown beside the stage like Discord's. */
function VoiceChatPanel({ channel }: { channel: Channel }) {
  return (
    <aside className="side-panel voice-chat">
      <MessageList channel={channel} />
      <Composer channel={channel} />
      <TypingIndicator channel={channel} />
    </aside>
  );
}

/** "1080p 30FPS · AO VIVO" next to the channel name while we share our screen here. */
function StreamBadge({ channelId }: { channelId: string }) {
  const live = useVoice((s) => s.selfStream && s.channelId === channelId);
  const quality = useVoice((s) => s.streamQuality);
  if (!live) return null;
  return (
    <span className="stream-badge" title="Qualidade da sua transmissão">
      {STREAM_QUALITIES[quality].short} <strong>AO VIVO</strong>
    </span>
  );
}

export function VoiceView({ channel }: { channel: Channel }) {
  const count = useParticipants(channel.id).length;
  const transcriptOpen = useVoice((s) => s.transcriptOpen);
  const chatOpen = useVoice((s) => s.chatOpen);
  const hideNoVideo = useVoice((s) => s.hideNoVideo);
  const unread = useStore((s) => isUnread(s, channel));
  return (
    <div className="voice-view">
      <header className="chat-header voice-header">
        <MobileBack />
        <Volume2 size={20} className="muted" />
        <h3>{channel.name}</h3>
        <span className="small muted">{count === 1 ? '1 na sala' : `${count} na sala`}</span>
        <StreamBadge channelId={channel.id} />
        <div className="chat-header-actions">
          <button
            className={cx('icon-btn', hideNoVideo && 'active')}
            title={hideNoVideo ? 'Mostrar todos os participantes' : 'Ocultar participantes sem vídeo'}
            onClick={() => setHideNoVideo(!hideNoVideo)}
          >
            {hideNoVideo ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
          <button
            className={cx('icon-btn', chatOpen && !transcriptOpen && 'active', unread && !chatOpen && 'has-unread')}
            title="Chat de texto da sala"
            onClick={() => useVoice.setState({ chatOpen: !(chatOpen && !transcriptOpen), transcriptOpen: false })}
          >
            <MessageSquare size={20} />
          </button>
          <button
            className={cx('icon-btn', transcriptOpen && 'active')}
            title="Transcrições"
            onClick={() => useVoice.setState({ transcriptOpen: !transcriptOpen, chatOpen: false })}
          >
            <ScrollText size={20} />
          </button>
        </div>
      </header>
      <div className="voice-body">
        <div className="voice-main">
          <VoiceStage channel={channel} />
          <VoiceControls channel={channel} />
        </div>
        {(transcriptOpen || chatOpen) && (
          <ResizablePanel storageKey="concord.voicePanelWidth">
            {transcriptOpen ? <TranscriptPanel channel={channel} /> : <VoiceChatPanel channel={channel} />}
          </ResizablePanel>
        )}
      </div>
    </div>
  );
}
