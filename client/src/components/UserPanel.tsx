import {
  Coffee,
  Headphones,
  HeadphoneOff,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Moon,
  PhoneOff,
  Sun,
  Settings,
  Signal,
  Video,
  VideoOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { P, has } from '../permissions';
import { toggleTheme, useTheme } from '../theme';
import { HOME, channelLabel, nameOf, openModal, selectChannel, setState, toast, useStore } from '../store';
import type { UserStatus } from '../types';
import { PRESENCE_LABEL, cx } from '../utils';
import { useVoice, voice } from '../voice';
import { ActivityCards } from './Activity';
import { Avatar, StatusDot } from './common';
import { NoiseButton } from './NoisePopover';
import { onScreenShareClick } from './StreamMenu';

function VoiceConnection() {
  const channelId = useVoice((s) => s.channelId);
  const selfVideo = useVoice((s) => s.selfVideo);
  const selfStream = useVoice((s) => s.selfStream);
  const states = useVoice(useShallow((s) => Object.values(s.connection)));
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined));
  const where = useStore((s) => {
    if (!channel) return '';
    if (!channel.guild_id) return `Chamada · ${channelLabel(s, channel)}`;
    return `${channel.name} / ${s.guilds[channel.guild_id]?.name ?? ''}`;
  });
  if (!channelId || !channel) return null;
  const canStream = has(channel.permissions, P.STREAM);

  const connecting = states.some((s) => s === 'new' || s === 'connecting');
  const failed = states.some((s) => s === 'failed' || s === 'disconnected');
  const label = failed ? 'Problemas na conexão' : connecting ? 'Conectando…' : 'Voz conectada';

  return (
    <div className="voice-connection">
      <div className="voice-connection-top">
        <div className={cx('voice-connection-status', failed && 'bad', connecting && 'warn')}>
          <Signal size={16} />
          <div>
            <strong>{label}</strong>
            <button className="link small truncate" onClick={() => selectChannel(channel.guild_id ?? HOME, channel.id)}>
              {where}
            </button>
          </div>
        </div>
        <NoiseButton />
        <button className="icon-btn" title="Desconectar" onClick={() => voice.leave()}>
          <PhoneOff size={20} />
        </button>
      </div>
      {canStream && (
        <div className="voice-connection-actions">
          <button className={cx('btn btn-secondary', selfVideo && 'on')} title="Câmera" onClick={() => void voice.toggleCamera()}>
            {selfVideo ? <Video size={18} /> : <VideoOff size={18} />}
          </button>
          <button
            className={cx('btn btn-secondary', selfStream && 'on')}
            title={selfStream ? 'Opções da transmissão' : 'Compartilhar tela'}
            onClick={onScreenShareClick}
          >
            {selfStream ? <MonitorOff size={18} /> : <Monitor size={18} />}
          </button>
        </div>
      )}
    </div>
  );
}

const STATUSES: UserStatus[] = ['online', 'idle', 'dnd', 'invisible'];

function StatusMenu({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme((s) => s.resolved);
  const meId = useStore((s) => s.me?.id);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', onDown));
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  async function setStatus(status: UserStatus) {
    onClose();
    try {
      const me = await api<NonNullable<ReturnType<typeof useStore.getState>['me']>>('/users/@me', { method: 'PATCH', body: { status } });
      setState({ me });
    } catch (e) {
      toast((e as Error).message);
    }
  }

  return (
    <div className="dropdown status-menu" ref={ref}>
      {meId && (
        <div className="status-menu-activity">
          <ActivityCards userId={meId} />
        </div>
      )}
      {STATUSES.map((s) => (
        <button key={s} className="dropdown-item" onClick={() => void setStatus(s)}>
          <span className="row gap-8">
            <StatusDot presence={s === 'invisible' ? 'offline' : s} /> {PRESENCE_LABEL[s]}
          </span>
        </button>
      ))}
      <div className="dropdown-separator" />
      <button className="dropdown-item" onClick={toggleTheme}>
        {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
        {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button
        className="dropdown-item"
        onClick={() => {
          onClose();
          openModal({ type: 'userSettings' });
        }}
      >
        Editar perfil e status
      </button>
    </div>
  );
}

export function UserPanel() {
  const me = useStore((s) => s.me);
  const name = useStore((s) => (s.me ? nameOf(s, s.me.id) : ''));
  const selfMute = useVoice((s) => s.selfMute);
  const selfDeaf = useVoice((s) => s.selfDeaf);
  const selfAfk = useVoice((s) => s.selfAfk);
  const speaking = useVoice((s) => (me ? !!s.speaking[me.id] : false));
  const [menu, setMenu] = useState(false);
  if (!me) return null;

  return (
    <div className="user-area">
      <VoiceConnection />
      <div className="user-panel">
        <button className="user-panel-me" onClick={() => setMenu(!menu)}>
          <Avatar userId={me.id} size={32} status speaking={speaking} />
          <span className="user-panel-names">
            <strong className="truncate">{name}</strong>
            <span className="truncate small muted">{me.custom_status || PRESENCE_LABEL[me.status]}</span>
          </span>
        </button>
        {menu && <StatusMenu onClose={() => setMenu(false)} />}
        <button className={cx('icon-btn', selfMute && 'danger')} title={selfMute ? 'Ativar microfone' : 'Silenciar'} onClick={() => voice.setMute(!selfMute)}>
          {selfMute ? <MicOff size={18} /> : <Mic size={18} />}
        </button>
        <button className={cx('icon-btn', selfDeaf && 'danger')} title={selfDeaf ? 'Ativar áudio' : 'Ensurdecer'} onClick={() => voice.setDeaf(!selfDeaf)}>
          {selfDeaf ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
        </button>
        <button className={cx('icon-btn', selfAfk && 'warning')} title={selfAfk ? 'Voltar do AFK' : 'Ficar AFK'} onClick={() => voice.setAfk(!selfAfk)}>
          <Coffee size={18} />
        </button>
        <button className="icon-btn" title="Configurações de usuário" onClick={() => openModal({ type: 'userSettings' })}>
          <Settings size={18} />
        </button>
      </div>
    </div>
  );
}
