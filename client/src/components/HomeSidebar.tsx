import { Plus, Users } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { HOME, channelLabel, dmChannels, dmRecipient, openModal, selectChannel, useStore } from '../store';
import type { Channel } from '../types';
import { cx } from '../utils';
import { Avatar, GroupIcon } from './common';

function DMRow({ channel }: { channel: Channel }) {
  const other = useStore((s) => (channel.type === 'dm' ? dmRecipient(s, channel) : undefined));
  const name = useStore((s) => channelLabel(s, channel));
  const subtitle = useStore((s) => {
    if (channel.type === 'group_dm') return `${channel.recipient_ids?.length ?? 0} membros`;
    return other ? s.users[other]?.custom_status : null;
  });
  const active = useStore((s) => s.view.channelId === channel.id);
  const mentions = useStore((s) => s.mentionCounts[channel.id] ?? 0);
  const inCall = useStore((s) => !!s.calls[channel.id]);
  return (
    <div className={cx('dm-row', active && 'active', mentions > 0 && 'unread')} onClick={() => selectChannel(HOME, channel.id)}>
      {other ? <Avatar userId={other} size={32} status /> : <GroupIcon channel={channel} size={32} />}
      <div className="dm-row-text">
        <span className="truncate">{name}</span>
        {inCall ? <span className="small call-live">Em chamada</span> : subtitle && <span className="truncate small muted">{subtitle}</span>}
      </div>
      {mentions > 0 && <span className="badge">{mentions}</span>}
    </div>
  );
}

export function HomeSidebar() {
  const friendsActive = useStore((s) => s.view.guildId === HOME && !s.view.channelId);
  const pending = useStore((s) => Object.values(s.relationships).filter((t) => t === 'pending_in').length);
  const dms = useStore(useShallow(dmChannels));

  return (
    <div className="sidebar-content">
      <div className="sidebar-header">
        <span className="muted">Conversas</span>
      </div>
      <div className="channel-list scroll">
        <div className={cx('dm-row friends-row', friendsActive && 'active')} onClick={() => selectChannel(HOME, null)}>
          <Users size={22} />
          <span>Amigos</span>
          {pending > 0 && <span className="badge">{pending}</span>}
        </div>
        <div className="category-header static">
          <span>Mensagens diretas</span>
          <button className="icon-btn" title="Criar grupo" onClick={() => openModal({ type: 'createGroup', channelId: null })}>
            <Plus size={16} />
          </button>
        </div>
        {dms.map((c) => (
          <DMRow key={c.id} channel={c} />
        ))}
        {!dms.length && <p className="muted small pad">Abra uma conversa pelo perfil de alguém ou pela lista de amigos.</p>}
      </div>
    </div>
  );
}
