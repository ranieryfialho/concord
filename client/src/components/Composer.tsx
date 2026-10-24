import { FileText, PlusCircle, Smile, X } from 'lucide-react';
import { type ChangeEvent, type ClipboardEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { P, has } from '../permissions';
import { type State, channelLabel, getState, nameOf, sendMessage, setReplyingTo, setState, toast, useStore } from '../store';
import type { Channel } from '../types';
import { cx, formatSize } from '../utils';
import { Avatar, useIsMobile } from './common';
import { EmojiPicker } from './EmojiPicker';

const MAX_FILES = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;
const drafts = new Map<string, string>();

function mentionCandidates(s: State, channel: Channel): string[] {
  if (channel.guild_id) return Object.keys(s.members[channel.guild_id] ?? {});
  return channel.recipient_ids ?? [];
}

/** Converts typed @username tokens into <@id> mentions for people who can see the channel. */
export function textToMentions(text: string, channelId: string): string {
  const s = getState();
  const channel = s.channels[channelId];
  if (!channel) return text;
  const byName = new Map<string, string>();
  for (const id of mentionCandidates(s, channel)) {
    const u = s.users[id];
    if (u) byName.set(u.username.toLowerCase(), id);
  }
  return text.replace(/(^|\s)@([a-zA-Z0-9_.]{2,32})/g, (raw, pre: string, username: string) => {
    const id = byName.get(username.toLowerCase());
    return id ? `${pre}<@${id}>` : raw;
  });
}

let pendingFiles: ((files: File[]) => void) | null = null;
/** Lets the chat view's drag-and-drop overlay hand files to the active composer. */
export function addFilesToComposer(files: File[]) {
  pendingFiles?.(files);
}

let insertText: ((text: string) => void) | null = null;
let queuedText = '';

/** "Mencionar" in a user's menu: adds @username to the open composer (or the next one to open). */
export function mentionInComposer(username: string) {
  const text = `@${username} `;
  if (insertText) insertText(text);
  else {
    queuedText += text;
    toast('Abra um canal de texto para enviar a menção');
  }
}

export function Composer({ channel }: { channel: Channel }) {
  const [text, setText] = useState(() => drafts.get(channel.id) ?? '');
  const [files, setFiles] = useState<File[]>([]);
  const [picker, setPicker] = useState(false);
  // No autofocus on a phone: it would pop the keyboard every time a channel opens.
  const mobile = useIsMobile();
  const [caret, setCaret] = useState(0);
  const [selected, setSelected] = useState(0);
  const replying = useStore((s) => s.replyingTo[channel.id] ?? null);
  const replyName = useStore((s) => (replying ? nameOf(s, replying.author.id, channel.guild_id) : ''));
  const label = useStore((s) => channelLabel(s, channel));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    pendingFiles = (incoming) => addFiles(incoming);
    return () => {
      pendingFiles = null;
    };
  });

  useEffect(() => {
    insertText = (incoming) => {
      setText((prev) => {
        const next = prev && !/\s$/.test(prev) ? `${prev} ${incoming}` : prev + incoming;
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.setSelectionRange(next.length, next.length);
          setCaret(next.length);
        });
        return next;
      });
    };
    if (queuedText) {
      insertText(queuedText);
      queuedText = '';
    }
    return () => {
      insertText = null;
    };
  }, [channel.id]);

  useEffect(() => {
    drafts.set(channel.id, text);
  }, [channel.id, text]);

  useEffect(() => {
    if (replying) inputRef.current?.focus();
  }, [replying]);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.5)}px`;
  }, [text]);

  // ---- @mention autocomplete ----
  const query = useMemo(() => {
    const m = /(^|\s)@([\w.]{0,32})$/.exec(text.slice(0, caret));
    return m ? m[2].toLowerCase() : null;
  }, [text, caret]);

  const suggestions = useStore((s) => {
    if (query === null) return '';
    return mentionCandidates(s, channel)
      .filter((id) => {
        const u = s.users[id];
        if (!u) return false;
        const nick = channel.guild_id ? s.members[channel.guild_id]?.[id]?.nickname : null;
        return [u.username, u.display_name, nick].some((n) => n?.toLowerCase().startsWith(query));
      })
      .slice(0, 8)
      .join(',');
  });
  const suggestionIds = suggestions ? suggestions.split(',') : [];

  function applySuggestion(userId: string) {
    const user = getState().users[userId];
    if (!user) return;
    const before = text.slice(0, caret).replace(/@[\w.]*$/, `@${user.username} `);
    const next = before + text.slice(caret);
    setText(next);
    setCaret(before.length);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(before.length, before.length);
    });
  }

  function addFiles(incoming: File[]) {
    if (!has(channel.permissions, P.ATTACH_FILES)) {
      toast('Você não pode enviar arquivos neste canal');
      return;
    }
    const ok = incoming.filter((f) => f.size <= MAX_FILE_SIZE);
    if (ok.length < incoming.length) toast('Arquivos acima de 25 MB foram ignorados');
    setFiles((prev) => {
      const next = [...prev, ...ok];
      if (next.length > MAX_FILES) toast(`Máximo de ${MAX_FILES} arquivos por mensagem`);
      return next.slice(0, MAX_FILES);
    });
    inputRef.current?.focus();
  }

  function onChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    setCaret(e.target.selectionStart);
    setSelected(0);
    const now = Date.now();
    if (e.target.value && now - lastTyping.current > 8000) {
      lastTyping.current = now;
      api(`/channels/${channel.id}/typing`, { method: 'POST' }).catch(() => {});
    }
  }

  async function submit() {
    const content = textToMentions(text.trim(), channel.id);
    if (!content && !files.length) return;
    const sending = files;
    const replyTo = replying?.id ?? null;
    setText('');
    setFiles([]);
    setReplyingTo(channel.id, null);
    lastTyping.current = 0;
    try {
      await sendMessage(channel.id, content, sending, replyTo);
    } catch (e) {
      toast((e as Error).message);
      setText(text);
      setFiles(sending);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestionIds.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setSelected((selected + delta + suggestionIds.length) % suggestionIds.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggestionIds[selected] ?? suggestionIds[0]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
      return;
    }
    if (e.key === 'Escape' && replying) {
      setReplyingTo(channel.id, null);
      return;
    }
    if (e.key === 'ArrowUp' && !text) {
      const me = getState().me?.id;
      const mine = [...(getState().messages[channel.id]?.items ?? [])].reverse().find((m) => m.author.id === me);
      if (mine) {
        e.preventDefault();
        setState({ editingId: mine.id });
      }
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (e.clipboardData.files.length) {
      e.preventDefault();
      addFiles([...e.clipboardData.files]);
    }
  }

  function insertEmoji(emoji: string) {
    const el = inputRef.current;
    const pos = el?.selectionStart ?? text.length;
    const next = text.slice(0, pos) + emoji + text.slice(pos);
    setText(next);
    setPicker(false);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(pos + emoji.length, pos + emoji.length);
    });
  }

  const placeholder =
    channel.type === 'dm'
      ? `Conversar com @${label}`
      : channel.type === 'text'
        ? `Conversar em #${label}`
        : `Conversar em ${label}`;

  if (!has(channel.permissions, P.SEND_MESSAGES)) {
    return (
      <div className="composer-wrap">
        <div className="composer composer-disabled">Você não tem permissão para enviar mensagens neste canal.</div>
      </div>
    );
  }
  const canAttach = has(channel.permissions, P.ATTACH_FILES);

  return (
    <div className="composer-wrap">
      {suggestionIds.length > 0 && (
        <div className="autocomplete">
          <div className="autocomplete-title">Membros</div>
          {suggestionIds.map((id, i) => (
            <MentionOption key={id} userId={id} guildId={channel.guild_id} active={i === selected} onPick={() => applySuggestion(id)} />
          ))}
        </div>
      )}
      {replying && (
        <div className="reply-bar">
          <span>
            Respondendo a <strong>{replyName}</strong>
          </span>
          <button className="icon-btn" onClick={() => setReplyingTo(channel.id, null)} aria-label="Cancelar resposta">
            <X size={16} />
          </button>
        </div>
      )}
      <div className={cx('composer', replying && 'with-reply')}>
        {files.length > 0 && (
          <div className="file-previews">
            {files.map((f, i) => (
              <FilePreview key={`${f.name}-${i}`} file={f} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        <div className="composer-row">
          {canAttach && (
            <button className="icon-btn composer-attach" onClick={() => fileRef.current?.click()} title="Enviar arquivo">
              <PlusCircle size={22} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <textarea
            ref={inputRef}
            className="composer-input"
            value={text}
            placeholder={placeholder}
            rows={1}
            maxLength={4000}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onPaste={onPaste}
            autoFocus={!mobile}
          />
          <button className="icon-btn" onClick={() => setPicker(!picker)} title="Emoji">
            <Smile size={22} />
          </button>
        </div>
        {picker && (
          <div className="composer-picker">
            <EmojiPicker onPick={insertEmoji} onClose={() => setPicker(false)} />
          </div>
        )}
      </div>
    </div>
  );
}

function MentionOption({ userId, guildId, active, onPick }: { userId: string; guildId: string | null; active: boolean; onPick: () => void }) {
  const name = useStore((s) => nameOf(s, userId, guildId));
  const username = useStore((s) => s.users[userId]?.username);
  return (
    <button className={cx('autocomplete-item', active && 'active')} onMouseDown={(e) => e.preventDefault()} onClick={onPick}>
      <Avatar userId={userId} size={24} status guildId={guildId} />
      <span>{name}</span>
      <span className="muted small">{username}</span>
    </button>
  );
}

function FilePreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [url] = useState(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null));
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <div className="file-preview">
      <button className="file-preview-remove" onClick={onRemove} aria-label="Remover">
        <X size={14} />
      </button>
      {url ? <img src={url} alt="" /> : <FileText size={40} />}
      <span className="truncate small">{file.name}</span>
      <span className="small muted">{formatSize(file.size)}</span>
    </div>
  );
}
