import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  HeadphoneOff,
  LogOut,
  MessagesSquare,
  MicOff,
  Plus,
  Settings,
  UserPlus,
  Volume2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { P, has } from '../permissions';
import {
  HOME,
  canGuild,
  closeModal,
  isUnread,
  nameOf,
  openModal,
  selectChannel,
  selectGuild,
  sortedGuildChannels,
  threadsOf,
  useStore,
} from '../store';
import type { Channel } from '../types';
import { cx } from '../utils';
import { useVoice, voice } from '../voice';
import { openVoiceUserMenu, openVoiceUserMenuAt } from './VoiceUserMenu';
import { ActivityIcon } from './Activity';
import { Avatar, useLongPress } from './common';

const COLLAPSE_KEY = 'concord.collapsed';

function loadCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

function VoiceMembers({ channel }: { channel: Channel }) {
  const states = useStore(useShallow((s) => Object.values(s.voiceStates).filter((v) => v.channel_id === channel.id)));
  const speaking = useVoice((s) => s.speaking);
  if (!states.length) return null;
  return (
    <div className="voice-members">
      {states.map((v) => (
        <VoiceMemberRow
          key={v.user_id}
          userId={v.user_id}
          guildId={channel.guild_id}
          speaking={!!speaking[v.user_id]}
          mute={v.self_mute || v.suppress}
          deaf={v.self_deaf}
          afk={v.self_afk}
          live={v.self_stream}
        />
      ))}
    </div>
  );
}

function VoiceMemberRow(props: { userId: string; guildId: string | null; speaking: boolean; mute: boolean; deaf: boolean; afk: boolean; live: boolean }) {
  const name = useStore((s) => nameOf(s, props.userId, props.guildId));
  const longPress = useLongPress((x, y) => openVoiceUserMenuAt(x, y, props.userId, props.guildId));
  return (
    <div
      className="voice-member"
      onClick={() => openModal({ type: 'profile', userId: props.userId, guildId: props.guildId })}
      onContextMenu={(e) => openVoiceUserMenu(e, props.userId, props.guildId)}
      {...longPress}
    >
      <Avatar userId={props.userId} size={24} speaking={props.speaking} guildId={props.guildId} />
      <span className="voice-member-label">
        <span className="voice-member-name">{name}</span>
        {props.afk && <span className="afk-badge">AFK</span>}
      </span>
      <ActivityIcon userId={props.userId} />
      {props.live && <span className="live-badge">Ao vivo</span>}
      {props.mute && !props.deaf && <MicOff size={14} className="muted-icon" />}
      {props.deaf && <HeadphoneOff size={14} className="muted-icon" />}
    </div>
  );
}

function ThreadRows({ parent }: { parent: Channel }) {
  const threads = useStore(useShallow((s) => threadsOf(s, parent.id)));
  const activeId = useStore((s) => s.view.channelId);
  const unread = useStore(useShallow((s) => threads.map((t) => isUnread(s, t))));
  if (!threads.length) return null;
  return (
    <div className="thread-rows">
      {threads.map((t, i) => (
        <div
          key={t.id}
          className={cx('thread-row', activeId === t.id && 'active', unread[i] && activeId !== t.id && 'unread')}
          onClick={() => selectChannel(parent.guild_id!, t.id)}
        >
          <span className="thread-spine" />
          <span className="truncate">{t.name}</span>
        </div>
      ))}
    </div>
  );
}

function ChannelRow({ channel }: { channel: Channel }) {
  const active = useStore((s) => s.view.channelId === channel.id);
  const unread = useStore((s) => isUnread(s, channel));
  const mentions = useStore((s) => s.mentionCounts[channel.id] ?? 0);
  const connected = useVoice((s) => s.channelId === channel.id);
  const canInvite = has(channel.permissions, P.CREATE_INVITE);
  const canManage = has(channel.permissions, P.MANAGE_CHANNELS);
  const Icon = channel.type === 'voice' ? Volume2 : Hash;

  function open() {
    if (channel.type === 'voice' && !connected) {
      if (!has(channel.permissions, P.CONNECT)) {
        selectChannel(channel.guild_id!, channel.id);
        return;
      }
      void voice.join(channel.guild_id, channel.id);
    }
    selectChannel(channel.guild_id!, channel.id);
  }

  return (
    <>
      <div
        className={cx('channel-row', active && 'active', unread && !active && 'unread', connected && 'connected')}
        onClick={open}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && open()}
      >
        {unread && !active && <span className="unread-pill" />}
        <Icon size={18} className="channel-icon" />
        <span className="channel-name">{channel.name}</span>
        <span className="channel-actions">
          {canInvite && (
            <button
              className="icon-btn"
              title="Criar convite"
              onClick={(e) => {
                e.stopPropagation();
                openModal({ type: 'invite', guildId: channel.guild_id! });
              }}
            >
              <UserPlus size={14} />
            </button>
          )}
          {canManage && (
            <button
              className="icon-btn"
              title="Editar canal"
              onClick={(e) => {
                e.stopPropagation();
                openModal({ type: 'channelSettings', channelId: channel.id });
              }}
            >
              <Settings size={14} />
            </button>
          )}
        </span>
        {mentions > 0 && <span className="badge">{mentions}</span>}
      </div>
      {channel.type === 'voice' && <VoiceMembers channel={channel} />}
      {channel.type === 'text' && <ThreadRows parent={channel} />}
    </>
  );
}

function GuildMenu({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const canInvite = useStore((s) => canGuild(s, guildId, P.CREATE_INVITE));
  const canSettings = useStore((s) => canGuild(s, guildId, P.MANAGE_GUILD) || canGuild(s, guildId, P.MANAGE_ROLES) || canGuild(s, guildId, P.KICK_MEMBERS));
  const canChannels = useStore((s) => canGuild(s, guildId, P.MANAGE_CHANNELS));
  const isOwner = useStore((s) => s.guilds[guildId]?.owner_id === s.me?.id);
  const name = useStore((s) => s.guilds[guildId]?.name);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', onDown));
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  function act(fn: () => void) {
    onClose();
    fn();
  }

  return (
    <div className="dropdown guild-menu" ref={ref}>
      {canInvite && (
        <button className="dropdown-item accent" onClick={() => act(() => openModal({ type: 'invite', guildId }))}>
          Convidar pessoas <UserPlus size={16} />
        </button>
      )}
      {canSettings && (
        <button className="dropdown-item" onClick={() => act(() => openModal({ type: 'guildSettings', guildId }))}>
          Configurações do servidor <Settings size={16} />
        </button>
      )}
      {canChannels && (
        <>
          <button
            className="dropdown-item"
            onClick={() => act(() => openModal({ type: 'createChannel', guildId, parentId: null, channelType: 'text' }))}
          >
            Criar canal <Plus size={16} />
          </button>
          <button
            className="dropdown-item"
            onClick={() => act(() => openModal({ type: 'createChannel', guildId, parentId: null, channelType: 'category' }))}
          >
            Criar categoria <FolderPlus size={16} />
          </button>
        </>
      )}
      <button className="dropdown-item" onClick={() => act(() => openModal({ type: 'userSettings' }))}>
        Editar meu perfil <MessagesSquare size={16} />
      </button>
      {!isOwner && (
        <>
          <div className="dropdown-separator" />
          <button
            className="dropdown-item danger"
            onClick={() =>
              act(() =>
                openModal({
                  type: 'confirm',
                  title: `Sair de '${name}'`,
                  body: 'Tem certeza? Você só poderá voltar com um novo convite.',
                  confirmLabel: 'Sair do servidor',
                  onConfirm: async () => {
                    await api(`/guilds/${guildId}/members/@me`, { method: 'DELETE' });
                    closeModal();
                    selectGuild(HOME);
                  },
                }),
              )
            }
          >
            Sair do servidor <LogOut size={16} />
          </button>
        </>
      )}
    </div>
  );
}

export function GuildSidebar({ guildId }: { guildId: string }) {
  const guild = useStore((s) => s.guilds[guildId]);
  const channels = useStore(useShallow((s) => sortedGuildChannels(s, guildId)));
  const canChannels = useStore((s) => canGuild(s, guildId, P.MANAGE_CHANNELS));
  const activeId = useStore((s) => s.view.channelId);
  const activeParent = useStore((s) => (s.view.channelId ? s.channels[s.view.channelId]?.parent_id : null));
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  function toggleCategory(id: string) {
    const next = { ...collapsed, [id]: !collapsed[id] };
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  if (!guild) return null;
  const categories = channels.filter((c) => c.type === 'category');
  const categoryIds = new Set(categories.map((c) => c.id));
  // Channels whose category is hidden from this member are shown at the top level.
  const loose = channels.filter((c) => c.type !== 'category' && (!c.parent_id || !categoryIds.has(c.parent_id)));

  return (
    <div className="sidebar-content">
      <button className={cx('sidebar-header guild-header', menuOpen && 'open')} onClick={() => setMenuOpen(!menuOpen)}>
        <span className="truncate">{guild.name}</span>
        {menuOpen ? <X size={18} /> : <ChevronDown size={18} />}
      </button>
      {menuOpen && <GuildMenu guildId={guildId} onClose={() => setMenuOpen(false)} />}
      <div className="channel-list scroll">
        {loose.map((c) => (
          <ChannelRow key={c.id} channel={c} />
        ))}
        {categories.map((cat) => {
          const children = channels.filter((c) => c.parent_id === cat.id);
          const isCollapsed = collapsed[cat.id];
          return (
            <div key={cat.id} className="category">
              <div className="category-header" onClick={() => toggleCategory(cat.id)}>
                {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <span className="truncate">{cat.name}</span>
                {canChannels && (
                  <button
                    className="icon-btn"
                    title="Criar canal"
                    onClick={(e) => {
                      e.stopPropagation();
                      openModal({ type: 'createChannel', guildId, parentId: cat.id, channelType: 'text' });
                    }}
                  >
                    <Plus size={16} />
                  </button>
                )}
                {has(cat.permissions, P.MANAGE_CHANNELS) && (
                  <button
                    className="icon-btn"
                    title="Editar categoria"
                    onClick={(e) => {
                      e.stopPropagation();
                      openModal({ type: 'channelSettings', channelId: cat.id });
                    }}
                  >
                    <Settings size={13} />
                  </button>
                )}
              </div>
              {children
                .filter((c) => !isCollapsed || c.id === activeId || c.id === activeParent)
                .map((c) => (
                  <ChannelRow key={c.id} channel={c} />
                ))}
            </div>
          );
        })}
        {!channels.length && <p className="muted small pad">Nenhum canal ainda.</p>}
      </div>
    </div>
  );
}
