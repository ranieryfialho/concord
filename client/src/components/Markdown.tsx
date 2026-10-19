import { Fragment, type ReactNode, useState } from 'react';
import { inviteCodeFromUrl, openInvite } from '../invite';
import { nameOf, openModal, useStore } from '../store';

// Discord-flavoured markdown subset rendered straight to React elements (never raw HTML).
const INLINE =
  /(`[^`\n]+`)|(\*\*[\s\S]+?\*\*)|(__[\s\S]+?__)|(\*[^*\n]+?\*)|(_[^_\n]+?_)|(~~[\s\S]+?~~)|(\|\|[\s\S]+?\|\|)|(<@\d+>)|(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

function Mention({ userId, guildId }: { userId: string; guildId: string | null }) {
  const name = useStore((s) => nameOf(s, userId, guildId));
  const isMe = useStore((s) => s.me?.id === userId);
  return (
    <span
      className={`mention${isMe ? ' me' : ''}`}
      onClick={() => openModal({ type: 'profile', userId, guildId })}
      role="button"
    >
      @{name}
    </span>
  );
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span className={`spoiler${shown ? ' shown' : ''}`} onClick={() => setShown(true)}>
      {children}
    </span>
  );
}

function inline(text: string, key: string, guildId: string | null): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(INLINE.source, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}.${m.index}`;
    if (m[1]) out.push(<code key={k} className="inline-code">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(tok.slice(2, -2), k, guildId)}</strong>);
    else if (m[3]) out.push(<u key={k}>{inline(tok.slice(2, -2), k, guildId)}</u>);
    else if (m[4] || m[5]) out.push(<em key={k}>{inline(tok.slice(1, -1), k, guildId)}</em>);
    else if (m[6]) out.push(<s key={k}>{inline(tok.slice(2, -2), k, guildId)}</s>);
    else if (m[7]) out.push(<Spoiler key={k}>{inline(tok.slice(2, -2), k, guildId)}</Spoiler>);
    else if (m[8]) out.push(<Mention key={k} userId={tok.slice(2, -1)} guildId={guildId} />);
    else if (m[9]) {
      const invite = inviteCodeFromUrl(tok);
      out.push(
        <a
          key={k}
          href={tok}
          target="_blank"
          rel="noreferrer noopener"
          onClick={
            invite
              ? (e) => {
                  e.preventDefault(); // our own invite links open inside the app
                  openInvite(invite);
                }
              : undefined
          }
        >
          {tok}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function blocks(text: string, key: string, guildId: string | null): ReactNode[] {
  const lines = text.split('\n');
  return lines.map((line, i) => {
    const k = `${key}:${i}`;
    if (line.startsWith('> ')) {
      return (
        <div key={k} className="blockquote">
          {inline(line.slice(2), k, guildId)}
        </div>
      );
    }
    const nextIsQuote = lines[i + 1]?.startsWith('> ');
    return (
      <Fragment key={k}>
        {inline(line, k, guildId)}
        {i < lines.length - 1 && !nextIsQuote ? '\n' : ''}
      </Fragment>
    );
  });
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;

export function isJumboEmoji(content: string): boolean {
  return content.length <= 40 && EMOJI_ONLY.test(content) && /\p{Extended_Pictographic}/u.test(content);
}

export function Markdown({ content, guildId }: { content: string; guildId: string | null }) {
  // split() with a capture group puts code-block bodies at odd indices.
  const parts = content.split(/```(?:[\w+-]*\n)?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <pre key={i} className="code-block">
            <code>{part.replace(/\n$/, '')}</code>
          </pre>
        ) : (
          <Fragment key={i}>{blocks(part, String(i), guildId)}</Fragment>
        ),
      )}
    </>
  );
}

/** Mentions are stored as <@id>; the composer shows them as @username. */
export function mentionsToText(content: string): string {
  const users = useStore.getState().users;
  return content.replace(/<@(\d+)>/g, (raw, id: string) => (users[id] ? `@${users[id].username}` : raw));
}
