import {
  Archive,
  ArchiveRestore,
  AtSign,
  ChevronRight,
  Hash,
  Volume2,
  LogOut,
  MessagesSquare,
  Phone,
  Pin,
  Search,
  Upload,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react';
import { type DragEvent, type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '../api';
import { P, has } from '../permissions';
import {
  HOME,
  ackChannel,
  channelLabel,
  dmRecipient,
  getState,
  ingestMessageUsers,
  isViewing,
  loadMessages,
  nameOf,
  openModal,
  selectChannel,
  setState,
  threadsOf,
  toast,
  toggleMembers,
  useStore,
} from '../store';
import type { Channel, Message } from '../types';
import { cx, dayLabel, messageTime, sameDay } from '../utils';
import { useVoice, voice } from '../voice';
import { Avatar, GroupIcon, MobileBack, Spinner, useIsMobile } from './common';
import { Composer, addFilesToComposer } from './Composer';
import { Markdown } from './Markdown';
import { GroupMemberList, MemberList, leaveGroup } from './MemberList';
import { MessageItem } from './MessageItem';
import { VoiceControls, VoiceStage } from './VoiceView';

const GROUP_WINDOW = 7 * 60 * 1000;

export function TypingIndicator({ channel }: { channel: Channel }) {
  const typing = useStore((s) => s.typing[channel.id]);
  const meId = useStore((s) => s.me?.id);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ids = Object.entries(typing ?? {})
    .filter(([id, until]) => until > now && id !== meId)
    .map(([id]) => id);
  const names = ids.map((id) => nameOf(getState(), id, channel.guild_id));
  let text = '';
  if (names.length === 1) text = `${names[0]} está digitando…`;
  else if (names.length === 2) text = `${names[0]} e ${names[1]} estão digitando…`;
  else if (names.length > 2) text = 'Várias pessoas estão digitando…';
  return (
    <div className="typing-indicator">
      {text && (
        <>
          <span className="typing-dots">
            <i />
            <i />
            <i />
          </span>
          <span>{text}</span>
        </>
      )}
    </div>
  );
}

function ChannelIntro({ channel }: { channel: Channel }) {
  const label = useStore((s) => channelLabel(s, channel));
  const other = useStore((s) => (channel.type === 'dm' ? dmRecipient(s, channel) : undefined));
  if (other) {
    return (
      <div className="channel-intro">
        <Avatar userId={other} size={80} />
        <h1>{label}</h1>
        <p className="muted">
          Este é o começo do seu histórico de mensagens diretas com <strong>{label}</strong>.
        </p>
      </div>
    );
  }
  if (channel.type === 'group_dm') {
    return (
      <div className="channel-intro">
        <GroupIcon channel={channel} size={80} />
        <h1>{label}</h1>
        <p className="muted">Boas-vindas ao começo do grupo {label}.</p>
      </div>
    );
  }
  if (channel.type === 'thread') {
    return (
      <div className="channel-intro">
        <div className="channel-intro-icon">
          <MessagesSquare size={40} />
        </div>
        <h1>{label}</h1>
        <p className="muted">Este é o começo da thread.</p>
      </div>
    );
  }
  const voice = channel.type === 'voice';
  return (
    <div className="channel-intro">
      <div className="channel-intro-icon">{voice ? <Volume2 size={44} /> : <Hash size={44} />}</div>
      <h1>{voice ? `Chat de ${label}` : `Boas-vindas a #${label}!`}</h1>
      <p className="muted">{voice ? 'Mensagens de texto desta sala de voz.' : `Este é o começo do canal #${label}.`}</p>
    </div>
  );
}

function StarterMessage({ channel }: { channel: Channel }) {
  const parent = useStore((s) => (channel.parent_id ? s.channels[channel.parent_id] : undefined));
  const starter = useStore((s) =>
    channel.starter_message_id && channel.parent_id
      ? s.messages[channel.parent_id]?.items.find((m) => m.id === channel.starter_message_id)
      : undefined,
  );
  const [fetched, setFetched] = useState<Message | null>(null);
  useEffect(() => {
    if (starter || !channel.starter_message_id || !channel.parent_id) return;
    // Load the parent page that contains the starter message.
    api<Message[]>(`/channels/${channel.parent_id}/messages?limit=1&before=${(BigInt(channel.starter_message_id) + 1n).toString().padStart(19, '0')}`)
      .then((list) => {
        ingestMessageUsers(list);
        if (list[0]?.id === channel.starter_message_id) setFetched(list[0]);
      })
      .catch(() => {});
  }, [starter, channel.starter_message_id, channel.parent_id]);
  const message = starter ?? fetched;
  if (!message || !parent) return null;
  return (
    <div className="thread-starter">
      <MessageItem message={message} grouped={false} channel={parent} />
    </div>
  );
}

export function MessageList({ channel }: { channel: Channel }) {
  const bucket = useStore((s) => s.messages[channel.id]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const prevHeight = useRef(0);
  const prevFirst = useRef<string | undefined>(undefined);
  // Snapshot of the read marker when the channel was opened, for the "new messages" divider.
  const [unreadAfter] = useState(() => {
    const s = getState();
    const read = s.readStates[channel.id];
    const last = s.channels[channel.id]?.last_message_id;
    return read && last && last > read ? read : null;
  });

  useEffect(() => {
    loadMessages(channel.id).catch((e: Error) => toast(e.message));
  }, [channel.id]);

  const items = bucket?.items ?? [];
  const firstId = items[0]?.id;
  const lastId = items[items.length - 1]?.id;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prevFirst.current && firstId !== prevFirst.current && el.scrollHeight !== prevHeight.current && !atBottom.current) {
      // Older page prepended: keep the viewport anchored.
      el.scrollTop += el.scrollHeight - prevHeight.current;
    } else if (atBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirst.current = firstId;
    prevHeight.current = el.scrollHeight;
  }, [firstId, lastId, items.length]);

  useEffect(() => {
    if (bucket?.loaded && isViewing(channel.id)) ackChannel(channel.id);
  }, [bucket?.loaded, lastId, channel.id]);

  // Images load after layout; keep pinned to the bottom when they do.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onLoad = () => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      prevHeight.current = el.scrollHeight;
    };
    el.addEventListener('load', onLoad, true);
    return () => el.removeEventListener('load', onLoad, true);
  }, []);

  function onScroll() {
    const el = scrollRef.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    prevHeight.current = el.scrollHeight;
    if (el.scrollTop < 300 && bucket?.hasMore && !bucket.loading) {
      loadMessages(channel.id, true).catch(() => {});
    }
  }

  return (
    <div className="message-scroller scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="message-list">
        {bucket?.loaded && !bucket.hasMore && (
          <>
            <ChannelIntro channel={channel} />
            {channel.type === 'thread' && <StarterMessage channel={channel} />}
          </>
        )}
        {(!bucket?.loaded || bucket.loading) && (
          <div className="center pad">
            <Spinner />
          </div>
        )}
        {items.map((m, i) => {
          const prev = items[i - 1];
          const newDay = !prev || !sameDay(prev.created_at, m.created_at);
          const showUnread = unreadAfter && m.id > unreadAfter && (!prev || prev.id <= unreadAfter);
          const grouped =
            !!prev &&
            !newDay &&
            !showUnread &&
            !m.reply_to_id &&
            m.type === 'default' &&
            prev.type === 'default' &&
            prev.author.id === m.author.id &&
            m.created_at - prev.created_at < GROUP_WINDOW;
          return (
            <div key={m.id}>
              {newDay && (
                <div className="divider">
                  <span>{dayLabel(m.created_at)}</span>
                </div>
              )}
              {showUnread && (
                <div className="divider unread">
                  <span>Novas</span>
                </div>
              )}
              <MessageItem message={m} grouped={grouped} channel={channel} />
            </div>
          );
        })}
        <div className="message-list-spacer" />
      </div>
    </div>
  );
}

function PinsPopout({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const [pins, setPins] = useState<Message[] | null>(null);
  useEffect(() => {
    api<Message[]>(`/channels/${channel.id}/pins`)
      .then((list) => {
        ingestMessageUsers(list);
        setPins(list);
      })
      .catch((e: Error) => toast(e.message));
  }, [channel.id]);
  return (
    <div className="popout pins-popout">
      <div className="popout-header">
        <strong>Mensagens fixadas</strong>
        <button className="icon-btn" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="popout-body scroll">
        {!pins && <Spinner />}
        {pins?.length === 0 && <p className="muted pad">Nenhuma mensagem fixada aqui ainda.</p>}
        {pins?.map((m) => <ResultCard key={m.id} message={m} guildId={channel.guild_id} />)}
      </div>
    </div>
  );
}

function ThreadsPopout({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const threads = useStore(useShallow((s) => threadsOf(s, channel.id, true)));
  const canCreate = has(channel.permissions, P.CREATE_THREADS);
  const active = threads.filter((t) => !t.archived);
  const archived = threads.filter((t) => t.archived);
  const open = (t: Channel) => {
    onClose();
    selectChannel(t.guild_id!, t.id);
  };
  return (
    <div className="popout threads-popout">
      <div className="popout-header">
        <strong>Threads</strong>
        <div className="row gap-8">
          {canCreate && (
            <button
              className="btn btn-primary small"
              onClick={() => {
                onClose();
                openModal({ type: 'createThread', channelId: channel.id, message: null });
              }}
            >
              Criar
            </button>
          )}
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="popout-body scroll">
        {!threads.length && <p className="muted pad">Nenhuma thread neste canal ainda.</p>}
        {[
          ['Ativas', active],
          ['Arquivadas', archived],
        ].map(
          ([title, list]) =>
            (list as Channel[]).length > 0 && (
              <div key={title as string}>
                <h4 className="member-section">{title as string}</h4>
                {(list as Channel[]).map((t) => (
                  <ThreadCard key={t.id} thread={t} onOpen={() => open(t)} />
                ))}
              </div>
            ),
        )}
      </div>
    </div>
  );
}

function ThreadCard({ thread, onOpen }: { thread: Channel; onOpen: () => void }) {
  const owner = useStore((s) => (thread.owner_id ? nameOf(s, thread.owner_id, thread.guild_id) : ''));
  return (
    <div className="result-card" onClick={onOpen}>
      <div className="row gap-8">
        <MessagesSquare size={16} />
        <strong className="truncate">{thread.name}</strong>
      </div>
      <div className="small muted">
        {thread.message_count ?? 0} mensagens · criada por {owner} · {messageTime(thread.created_at)}
      </div>
    </div>
  );
}

function ResultCard({ message, guildId }: { message: Message; guildId: string | null }) {
  const name = useStore((s) => nameOf(s, message.author.id, guildId));
  const channelName = useStore((s) => s.channels[message.channel_id]?.name);
  function jump() {
    const c = getState().channels[message.channel_id];
    if (!c) return;
    selectChannel(c.guild_id ?? HOME, c.id);
    setTimeout(() => {
      const el = document.getElementById(`msg-${message.id}`);
      el?.scrollIntoView({ block: 'center' });
      el?.classList.add('flash');
      setTimeout(() => el?.classList.remove('flash'), 1500);
    }, 300);
  }
  return (
    <div className="result-card" onClick={jump}>
      <div className="row gap-8">
        <Avatar userId={message.author.id} size={24} guildId={guildId} />
        <strong>{name}</strong>
        {guildId && channelName && <span className="muted small">#{channelName}</span>}
        <span className="muted small">{messageTime(message.created_at)}</span>
      </div>
      <div className="result-content">
        <Markdown content={message.content || '📎 Anexo'} guildId={guildId} />
      </div>
    </div>
  );
}

function SearchPanel({ channel, query, onClose }: { channel: Channel; query: string; onClose: () => void }) {
  const [results, setResults] = useState<Message[] | null>(null);
  useEffect(() => {
    setResults(null);
    const path = channel.guild_id
      ? `/guilds/${channel.guild_id}/messages/search?q=${encodeURIComponent(query)}`
      : `/channels/${channel.id}/messages/search?q=${encodeURIComponent(query)}`;
    api<Message[]>(path)
      .then((list) => {
        ingestMessageUsers(list);
        setResults(list);
      })
      .catch((e: Error) => toast(e.message));
  }, [channel.id, channel.guild_id, query]);
  return (
    <aside className="side-panel search-panel">
      <div className="popout-header">
        <strong>{results ? `${results.length} resultado${results.length === 1 ? '' : 's'}` : 'Buscando…'}</strong>
        <button className="icon-btn" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="popout-body scroll">
        {results?.length === 0 && <p className="muted pad">Nada encontrado para “{query}”.</p>}
        {results?.map((m) => <ResultCard key={m.id} message={m} guildId={channel.guild_id} />)}
      </div>
    </aside>
  );
}

/** Active voice call inside a DM or group, shown above the messages. */
function CallPanel({ channel }: { channel: Channel }) {
  const participants = useStore((s) => Object.values(s.voiceStates).filter((v) => v.channel_id === channel.id).length);
  const ringing = useStore(useShallow((s) => s.calls[channel.id]?.ringing ?? []));
  const connected = useVoice((s) => s.channelId === channel.id);
  const ringingNames = useStore((s) => ringing.map((id) => nameOf(s, id)).join(', '));
  if (!participants && !connected) return null;
  return (
    <div className="call-panel">
      <VoiceStage channel={channel} compact />
      {ringing.length > 0 && <div className="call-ringing small muted">Chamando {ringingNames}…</div>}
      <VoiceControls channel={channel} floating={false} />
    </div>
  );
}

function GroupTitle({ channel }: { channel: Channel }) {
  const label = useStore((s) => channelLabel(s, channel));
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    setEditing(false);
    if (value.trim() === (channel.name ?? '')) return;
    api(`/channels/${channel.id}`, { method: 'PATCH', body: { name: value.trim() || null } }).catch((err: Error) => toast(err.message));
  }
  if (editing) {
    return (
      <form onSubmit={submit} className="group-title-form">
        <input value={value} onChange={(e) => setValue(e.target.value)} autoFocus maxLength={100} onBlur={submit} placeholder="Nome do grupo" />
      </form>
    );
  }
  return (
    <h3
      className="clickable"
      title="Clique para renomear"
      onClick={() => {
        setValue(channel.name ?? '');
        setEditing(true);
      }}
    >
      {label}
    </h3>
  );
}

export function ChatView({ channel }: { channel: Channel }) {
  const label = useStore((s) => channelLabel(s, channel));
  const other = useStore((s) => (channel.type === 'dm' ? dmRecipient(s, channel) : undefined));
  const parent = useStore((s) => (channel.type === 'thread' && channel.parent_id ? s.channels[channel.parent_id] : undefined));
  const meId = useStore((s) => s.me?.id);
  const mobile = useIsMobile();
  // On a phone the member list is a drawer that starts closed, independent of the saved desktop preference.
  const showMembers = useStore((s) => (mobile ? s.membersDrawer : s.showMembers));
  const inThisCall = useVoice((s) => s.channelId === channel.id);
  const [popout, setPopout] = useState<'pins' | 'threads' | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const isPrivate = channel.type === 'dm' || channel.type === 'group_dm';
  const canManageThread = channel.type === 'thread' && (channel.owner_id === meId || has(channel.permissions, P.MANAGE_CHANNELS));

  function onDragEnter(e: DragEvent) {
    if (![...e.dataTransfer.types].includes('Files')) return;
    dragDepth.current++;
    setDragging(true);
  }
  function onDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files.length) addFilesToComposer([...e.dataTransfer.files]);
  }

  async function startCall(video: boolean) {
    if (!inThisCall) await voice.join(null, channel.id);
    if (video && !useVoice.getState().selfVideo) await voice.toggleCamera();
  }

  function setArchived(archived: boolean) {
    api(`/channels/${channel.id}`, { method: 'PATCH', body: { archived } })
      .then(() => toast(archived ? 'Thread arquivada' : 'Thread reaberta'))
      .catch((e: Error) => toast(e.message));
  }

  let titleIcon;
  if (other) titleIcon = <Avatar userId={other} size={24} status />;
  else if (channel.type === 'group_dm') titleIcon = <GroupIcon channel={channel} size={24} />;
  else if (channel.type === 'thread') titleIcon = <MessagesSquare size={22} className="muted" />;
  else if (isPrivate) titleIcon = <AtSign size={22} />;
  else titleIcon = <Hash size={22} className="muted" />;

  let sidePanel = null;
  if (search) sidePanel = <SearchPanel channel={channel} query={search} onClose={() => setSearch(null)} />;
  else if (showMembers && channel.guild_id) sidePanel = <MemberList guildId={channel.guild_id} />;
  else if (showMembers && channel.type === 'group_dm') sidePanel = <GroupMemberList channel={channel} />;

  return (
    <div className="chat" onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="chat-header">
        <MobileBack />
        {titleIcon}
        {parent && (
          <>
            <button className="breadcrumb" onClick={() => selectChannel(parent.guild_id!, parent.id)}>
              #{parent.name}
            </button>
            <ChevronRight size={16} className="muted" />
          </>
        )}
        {channel.type === 'group_dm' ? (
          <GroupTitle channel={channel} />
        ) : (
          <h3 className={cx(other && 'clickable')} onClick={() => other && openModal({ type: 'profile', userId: other, guildId: null })}>
            {label}
          </h3>
        )}
        {channel.archived && <span className="role-chip">arquivada</span>}
        {channel.topic && (
          <>
            <span className="header-divider" />
            <span className="chat-topic truncate" title={channel.topic}>
              {channel.topic}
            </span>
          </>
        )}
        <div className="chat-header-actions">
          {isPrivate && (
            <>
              <button className="icon-btn" title="Iniciar chamada de voz" onClick={() => void startCall(false)}>
                <Phone size={20} />
              </button>
              <button className="icon-btn" title="Iniciar chamada de vídeo" onClick={() => void startCall(true)}>
                <Video size={20} />
              </button>
              <button className="icon-btn" title="Adicionar amigos ao grupo" onClick={() => openModal({ type: 'createGroup', channelId: channel.id })}>
                <UserPlus size={20} />
              </button>
            </>
          )}
          {channel.type === 'text' && (
            <button className={cx('icon-btn', popout === 'threads' && 'active')} title="Threads" onClick={() => setPopout(popout === 'threads' ? null : 'threads')}>
              <MessagesSquare size={20} />
            </button>
          )}
          {canManageThread && (
            <button className="icon-btn" title={channel.archived ? 'Reabrir thread' : 'Arquivar thread'} onClick={() => setArchived(!channel.archived)}>
              {channel.archived ? <ArchiveRestore size={20} /> : <Archive size={20} />}
            </button>
          )}
          <button className={cx('icon-btn', popout === 'pins' && 'active')} title="Mensagens fixadas" onClick={() => setPopout(popout === 'pins' ? null : 'pins')}>
            <Pin size={20} />
          </button>
          {(channel.guild_id || channel.type === 'group_dm') && (
            <button
              className={cx('icon-btn', showMembers && 'active')}
              title="Lista de membros"
              onClick={mobile ? () => setState({ membersDrawer: !showMembers }) : toggleMembers}
            >
              <Users size={20} />
            </button>
          )}
          {channel.type === 'group_dm' && (
            <button className="icon-btn" title="Sair do grupo" onClick={() => leaveGroup(channel)}>
              <LogOut size={20} />
            </button>
          )}
          <form
            className="search-box"
            onSubmit={(e) => {
              e.preventDefault();
              if (searchInput.trim()) setSearch(searchInput.trim());
            }}
          >
            <input placeholder="Buscar" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
            <Search size={16} />
          </form>
        </div>
        {popout === 'pins' && <PinsPopout channel={channel} onClose={() => setPopout(null)} />}
        {popout === 'threads' && <ThreadsPopout channel={channel} onClose={() => setPopout(null)} />}
      </header>
      <div className="chat-body">
        <div className="chat-main">
          {isPrivate && <CallPanel channel={channel} />}
          <MessageList channel={channel} />
          <Composer channel={channel} />
          <TypingIndicator channel={channel} />
        </div>
        {mobile && sidePanel && (
          <div
            className="drawer-backdrop"
            onClick={() => {
              setState({ membersDrawer: false });
              setSearch(null);
            }}
          />
        )}
        {sidePanel}
      </div>
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <Upload size={40} />
            <h3>Enviar para {channel.type === 'text' ? `#${label}` : label}</h3>
            <p>Solte os arquivos para anexá-los.</p>
          </div>
        </div>
      )}
    </div>
  );
}
