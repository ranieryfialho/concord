import {
  ChevronUp,
  Coffee,
  Eye,
  EyeOff,
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
  SlidersHorizontal,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { P, has } from '../permissions';
import { isUnread, nameOf, toast, useStore } from '../store';
import type { Channel } from '../types';
import { cx } from '../utils';
import { STREAM_QUALITIES, type StreamKind, savePrefs, useVoice, voice } from '../voice';
import { Avatar, MobileBack, ResizablePanel, useLongPress } from './common';
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
  /** Screens only: which of the person's shares this is, when they share more than one. */
  screen?: { index: number; of: number };
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
  const localScreens = useVoice((s) => s.localScreens);
  useVoice((s) => s.deviceTick);
  const remote = useVoice((s) => s.remoteStreams);
  const kinds = useVoice((s) => s.streamKinds);

  const tiles: Tile[] = [];
  for (const uid of participants) {
    let camera: MediaStream | null = null;
    const screens: MediaStream[] = [];
    if (uid === meId && connectedHere) {
      camera = localCamera;
      screens.push(...localScreens);
    } else {
      for (const [streamId, stream] of Object.entries(remote[uid] ?? {})) {
        if (!hasVideo(stream)) continue;
        const kind: StreamKind = kinds[uid]?.[streamId] ?? 'camera';
        if (kind === 'screen') screens.push(stream);
        else camera = stream;
      }
    }
    tiles.push({ key: `u-${uid}`, userId: uid, kind: 'user', stream: camera });
    screens.forEach((s, i) => tiles.push({ key: `s-${uid}-${s.id}`, userId: uid, kind: 'screen', stream: s, screen: { index: i, of: screens.length } }));
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
        <span className="truncate">{isScreen ? `Tela de ${name}${tile.screen && tile.screen.of > 1 ? ` (${tile.screen.index + 1})` : ''}` : name}</span>
        {!isScreen && state?.self_afk && <span className="afk-badge">AFK</span>}
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
  const selfAfk = useVoice((s) => s.selfAfk);
  const selfVideo = useVoice((s) => s.selfVideo);
  const selfStream = useVoice((s) => s.selfStream);
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
      <button className={cx('control-btn', selfAfk && 'afk')} title={selfAfk ? 'Voltar do AFK' : 'Ficar AFK'} onClick={() => voice.setAfk(!selfAfk)}>
        <Coffee size={19} />
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
      <span className="control-divider" />
      <button className="control-btn hangup" title="Desconectar" onClick={() => voice.leave()}>
        <PhoneOff size={19} />
      </button>
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
            className={cx('icon-btn', chatOpen && 'active', unread && !chatOpen && 'has-unread')}
            title="Chat de texto da sala"
            onClick={() => useVoice.setState({ chatOpen: !chatOpen })}
          >
            <MessageSquare size={20} />
          </button>
        </div>
      </header>
      <div className="voice-body">
        <div className="voice-main">
          <VoiceStage channel={channel} />
          <VoiceControls channel={channel} />
        </div>
        {chatOpen && (
          <ResizablePanel storageKey="concord.voicePanelWidth">
            <VoiceChatPanel channel={channel} />
          </ResizablePanel>
        )}
      </div>
    </div>
  );
}
