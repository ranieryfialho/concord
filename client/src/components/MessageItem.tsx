import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Download,
  FileText,
  Hash,
  MessagesSquare,
  Pencil,
  Phone,
  Pin,
  PinOff,
  Reply,
  SmilePlus,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, type ReactNode, memo, useState } from 'react';
import { create } from 'zustand';
import { api, fileUrl } from '../api';
import { P, colorHex, has } from '../permissions';
import {
  closeModal,
  copyText,
  getState,
  memberColor,
  nameOf,
  openModal,
  selectChannel,
  setReplyingTo,
  setState,
  threadForMessage,
  toast,
  toggleReaction,
  useStore,
} from '../store';
import type { Attachment, Channel, Embed, Message } from '../types';
import { cx, formatSize, messageTime, shortTime } from '../utils';
import { useVoice, voice } from '../voice';
import { Avatar, useIsMobile } from './common';
import { textToMentions } from './Composer';
import { EmojiPicker } from './EmojiPicker';
import { Markdown, isJumboEmoji, mentionsToText } from './Markdown';

function AttachmentView({ a }: { a: Attachment }) {
  const url = fileUrl(a.url)!;
  const type = a.content_type ?? '';
  if (type.startsWith('image/')) {
    return (
      <img
        className="attachment-image"
        src={url}
        alt={a.filename}
        loading="lazy"
        onClick={() => openModal({ type: 'image', url, filename: a.filename })}
      />
    );
  }
  if (type.startsWith('video/')) return <video className="attachment-video" src={url} controls preload="metadata" />;
  if (type.startsWith('audio/')) {
    return (
      <div className="attachment-file">
        <FileText size={28} />
        <div className="attachment-file-info">
          <span className="truncate">{a.filename}</span>
          <audio src={url} controls preload="none" />
        </div>
      </div>
    );
  }
  return (
    <div className="attachment-file">
      <FileText size={28} />
      <div className="attachment-file-info">
        <a href={url} download={a.filename} target="_blank" rel="noreferrer" className="truncate">
          {a.filename}
        </a>
        <span className="small muted">{formatSize(a.size)}</span>
      </div>
      <a href={url} download={a.filename} className="icon-btn" title="Baixar">
        <Download size={18} />
      </a>
    </div>
  );
}

function EmbedView({ e }: { e: Embed }) {
  if (e.type === 'image' && e.image_url) {
    return (
      <img
        className="attachment-image"
        src={e.image_url}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onClick={() => openModal({ type: 'image', url: e.image_url!, filename: e.url })}
      />
    );
  }
  return (
    <div className="embed" style={{ borderLeftColor: e.color ?? undefined }}>
      {e.site_name && <div className="embed-site small muted">{e.site_name}</div>}
      {e.title && (
        <a className="embed-title" href={e.url} target="_blank" rel="noreferrer noopener">
          {e.title}
        </a>
      )}
      {e.description && <div className="embed-description">{e.description}</div>}
      {e.image_url && (
        <img
          className="embed-image"
          src={e.image_url}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onClick={() => openModal({ type: 'image', url: e.image_url!, filename: e.title ?? e.url })}
        />
      )}
    </div>
  );
}

function EditBox({ message, onDone }: { message: Message; onDone: () => void }) {
  const [value, setValue] = useState(() => mentionsToText(message.content));

  async function save() {
    const content = textToMentions(value.trim(), message.channel_id);
    if (!content) return;
    if (content === message.content) return onDone();
    try {
      await api(`/channels/${message.channel_id}/messages/${message.id}`, { method: 'PATCH', body: { content } });
      onDone();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') onDone();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void save();
    }
  }

  return (
    <div className="edit-box">
      <textarea value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} autoFocus rows={Math.min(10, value.split('\n').length)} />
      <span className="small muted">
        esc para <button className="link" onClick={onDone}>cancelar</button> • enter para{' '}
        <button className="link" onClick={() => void save()}>salvar</button>
      </span>
    </div>
  );
}

function jumpTo(messageId: string) {
  const el = document.getElementById(`msg-${messageId}`);
  if (!el) return toast('Essa mensagem é mais antiga. Role para cima para vê-la.');
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1500);
}

function ThreadChip({ thread }: { thread: Channel }) {
  return (
    <button className="thread-chip" onClick={() => selectChannel(thread.guild_id!, thread.id)}>
      <MessagesSquare size={16} />
      <strong className="truncate">{thread.name}</strong>
      <span className="muted small">
        {thread.message_count ?? 0} mensage{thread.message_count === 1 ? 'm' : 'ns'}
        {thread.archived ? ' · arquivada' : ''}
      </span>
    </button>
  );
}

function SystemMessage({ message, channel }: { message: Message; channel: Channel }) {
  const guildId = channel.guild_id;
  const author = useStore((s) => nameOf(s, message.author.id, guildId));
  const target = useStore((s) => (message.target_user ? nameOf(s, message.target_user.id, guildId) : ''));
  const thread = useStore((s) => (message.type === 'thread_created' ? s.channels[message.content] : undefined));
  const callActive = useStore((s) => message.type === 'call' && !!s.calls[channel.id]);
  const inThisCall = useVoice((s) => s.channelId === channel.id);

  let icon = <ArrowRight size={16} className="sys-icon join" />;
  let body: ReactNode = null;
  switch (message.type) {
    case 'recipient_add':
      body = (
        <>
          <strong>{author}</strong> adicionou <strong>{target}</strong> ao grupo.
        </>
      );
      break;
    case 'recipient_remove':
      icon = <ArrowLeft size={16} className="sys-icon leave" />;
      body =
        message.target_user?.id === message.author.id ? (
          <>
            <strong>{author}</strong> saiu do grupo.
          </>
        ) : (
          <>
            <strong>{author}</strong> removeu <strong>{target}</strong> do grupo.
          </>
        );
      break;
    case 'call':
      icon = <Phone size={16} className="sys-icon join" />;
      body = (
        <>
          <strong>{author}</strong> iniciou uma chamada.
          {callActive && !inThisCall && (
            <button className="link sys-action" onClick={() => void voice.join(null, channel.id)}>
              Entrar na chamada
            </button>
          )}
        </>
      );
      break;
    case 'thread_created':
      icon = <MessagesSquare size={16} className="sys-icon" />;
      body = (
        <>
          <strong>{author}</strong> iniciou uma thread:{' '}
          {thread ? (
            <button className="link" onClick={() => selectChannel(thread.guild_id!, thread.id)}>
              {thread.name}
            </button>
          ) : (
            <span className="muted">thread excluída</span>
          )}
        </>
      );
      break;
    case 'channel_name_change':
      icon = <Pencil size={14} className="sys-icon" />;
      body = message.content ? (
        <>
          <strong>{author}</strong> mudou o nome do grupo para <strong>{message.content}</strong>.
        </>
      ) : (
        <>
          <strong>{author}</strong> removeu o nome do grupo.
        </>
      );
      break;
  }
  return (
    <div id={`msg-${message.id}`} className="message system">
      <div className="message-row">
        <div className="message-gutter sys-gutter">{icon}</div>
        <div className="message-body sys-body">
          {body} <span className="message-time">{messageTime(message.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

// Touch screens have no hover: tapping a message selects it, which shows its toolbar.
const useTapped = create<{ id: string | null }>()(() => ({ id: null }));

function toggleTapped(e: MouseEvent, id: string) {
  if ((e.target as HTMLElement).closest('button, a, input, textarea, img, video, audio, .clickable, .reply-context')) return;
  useTapped.setState((s) => ({ id: s.id === id ? null : id }));
}

export const MessageItem = memo(function MessageItem({
  message,
  grouped,
  channel,
}: {
  message: Message;
  grouped: boolean;
  channel: Channel;
}) {
  if (message.type !== 'default') return <SystemMessage message={message} channel={channel} />;
  return <UserMessage message={message} grouped={grouped} channel={channel} />;
});

function UserMessage({ message, grouped, channel }: { message: Message; grouped: boolean; channel: Channel }) {
  const guildId = channel.guild_id;
  const authorId = message.author.id;
  const name = useStore((s) => nameOf(s, authorId, guildId));
  const color = useStore((s) => memberColor(s, guildId, authorId));
  const meId = useStore((s) => s.me?.id);
  const editing = useStore((s) => s.editingId === message.id);
  const thread = useStore((s) => (channel.type === 'text' ? threadForMessage(s, message.id) : undefined));
  const replyName = useStore((s) => (message.reply_to ? nameOf(s, message.reply_to.author.id, guildId) : ''));
  const [picker, setPicker] = useState(false);
  const mobile = useIsMobile();
  const tapped = useTapped((s) => s.id === message.id);

  const perms = channel.permissions;
  const isPrivate = channel.type === 'dm' || channel.type === 'group_dm';
  const isMine = authorId === meId;
  const mentionsMe = !!meId && message.content.includes(`<@${meId}>`);
  const canPin = isPrivate || has(perms, P.MANAGE_MESSAGES);
  const canDelete = isMine || (!isPrivate && has(perms, P.MANAGE_MESSAGES));
  const canReact = has(perms, P.ADD_REACTIONS);
  const canSend = has(perms, P.SEND_MESSAGES);
  const canThread = channel.type === 'text' && !thread && has(perms, P.CREATE_THREADS);

  function remove(skipConfirm: boolean) {
    const run = async () => {
      try {
        await api(`/channels/${channel.id}/messages/${message.id}`, { method: 'DELETE' });
        closeModal();
      } catch (e) {
        toast((e as Error).message);
      }
    };
    if (skipConfirm) return void run();
    openModal({
      type: 'confirm',
      title: 'Excluir mensagem',
      body: 'Tem certeza de que deseja excluir esta mensagem? (Dica: segure Shift ao clicar para pular esta confirmação.)',
      confirmLabel: 'Excluir',
      onConfirm: run,
    });
  }

  function togglePin() {
    api(`/channels/${channel.id}/pins/${message.id}`, { method: message.pinned ? 'DELETE' : 'PUT' })
      .then(() => toast(message.pinned ? 'Mensagem desafixada' : 'Mensagem fixada'))
      .catch((e: Error) => toast(e.message));
  }

  const openProfile = () => openModal({ type: 'profile', userId: authorId, guildId });

  return (
    <div
      id={`msg-${message.id}`}
      className={cx('message', grouped && 'grouped', mentionsMe && 'mentioned', editing && 'editing', picker && 'hovering', tapped && 'tapped')}
      onClick={mobile ? (e) => toggleTapped(e, message.id) : undefined}
    >
      {message.reply_to && (
        <div className="reply-context" onClick={() => jumpTo(message.reply_to!.id)}>
          <span className="reply-spine" />
          <Avatar userId={message.reply_to.author.id} size={16} guildId={guildId} />
          <strong>{replyName}</strong>
          <span className="truncate muted">
            {mentionsToText(message.reply_to.content).replace(/```[\w+-]*\n?/g, '').replace(/\s+/g, ' ').trim() || 'Clique para ver o anexo'}
          </span>
        </div>
      )}
      <div className="message-row">
        <div className="message-gutter">
          {grouped ? (
            <span className="message-hover-time">{shortTime(message.created_at)}</span>
          ) : (
            <button className="avatar-btn" onClick={openProfile}>
              <Avatar userId={authorId} size={40} guildId={guildId} />
            </button>
          )}
        </div>
        <div className="message-body">
          {!grouped && (
            <div className="message-header">
              <button className="message-author" onClick={openProfile} style={{ color: colorHex(color) }}>
                {name}
              </button>
              <span className="message-time">{messageTime(message.created_at)}</span>
              {message.pinned && <Pin size={12} className="muted" />}
            </div>
          )}
          {editing ? (
            <EditBox message={message} onDone={() => setState({ editingId: null })} />
          ) : (
            message.content && (
              <div className={cx('message-content', isJumboEmoji(message.content) && 'jumbo')}>
                <Markdown content={message.content} guildId={guildId} />
                {message.edited_at && <span className="edited">(editado)</span>}
              </div>
            )
          )}
          {message.attachments.length > 0 && (
            <div className="attachments">
              {message.attachments.map((a) => (
                <AttachmentView key={a.id} a={a} />
              ))}
            </div>
          )}
          {message.embeds.length > 0 && (
            <div className="attachments">
              {message.embeds.map((e, i) => (
                <EmbedView key={`${e.url}-${i}`} e={e} />
              ))}
            </div>
          )}
          {message.reactions.length > 0 && (
            <div className="reactions">
              {message.reactions.map((r) => (
                <button
                  key={r.emoji}
                  className={cx('reaction', meId && r.user_ids.includes(meId) && 'mine')}
                  onClick={() => toggleReaction(message, r.emoji)}
                  title={r.user_ids.map((id) => nameOf(getState(), id, guildId)).join(', ')}
                >
                  <span>{r.emoji}</span>
                  <span className="reaction-count">{r.user_ids.length}</span>
                </button>
              ))}
              {canReact && (
                <button className="reaction add" onClick={() => setPicker(true)} title="Adicionar reação">
                  <SmilePlus size={16} />
                </button>
              )}
            </div>
          )}
          {thread && <ThreadChip thread={thread} />}
        </div>
      </div>

      {!editing && (
        <div className="message-toolbar">
          {canReact &&
            ['👍', '❤️', '😂'].map((e) => (
              <button key={e} className="toolbar-btn emoji" onClick={() => toggleReaction(message, e)}>
                {e}
              </button>
            ))}
          {canReact && (
            <button className="toolbar-btn" title="Adicionar reação" onClick={() => setPicker(true)}>
              <SmilePlus size={18} />
            </button>
          )}
          {canSend && (
            <button className="toolbar-btn" title="Responder" onClick={() => setReplyingTo(channel.id, message)}>
              <Reply size={18} />
            </button>
          )}
          {canThread && (
            <button className="toolbar-btn" title="Criar thread" onClick={() => openModal({ type: 'createThread', channelId: channel.id, message })}>
              <MessagesSquare size={16} />
            </button>
          )}
          {isMine && (
            <button className="toolbar-btn" title="Editar" onClick={() => setState({ editingId: message.id })}>
              <Pencil size={16} />
            </button>
          )}
          {canPin && (
            <button className="toolbar-btn" title={message.pinned ? 'Desafixar' : 'Fixar'} onClick={togglePin}>
              {message.pinned ? <PinOff size={16} /> : <Pin size={16} />}
            </button>
          )}
          <button className="toolbar-btn" title="Copiar texto" onClick={() => copyText(mentionsToText(message.content))}>
            <Copy size={16} />
          </button>
          <button className="toolbar-btn" title="Copiar ID" onClick={() => copyText(message.id, 'ID copiado')}>
            <Hash size={16} />
          </button>
          {canDelete && (
            <button className="toolbar-btn danger" title="Excluir" onClick={(e) => remove(e.shiftKey)}>
              <Trash2 size={16} />
            </button>
          )}
        </div>
      )}
      {picker && (
        <div className="picker-anchor">
          <EmojiPicker
            onPick={(e) => {
              toggleReaction(message, e);
              setPicker(false);
            }}
            onClose={() => setPicker(false)}
          />
        </div>
      )}
    </div>
  );
}
