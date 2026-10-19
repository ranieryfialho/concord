import { Users, X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { fileUrl } from '../api';
import { nameOf, presenceOf, useStore } from '../store';
import type { Channel, Presence } from '../types';
import { colorFor, cx, initials } from '../utils';

export function StatusDot({ presence, size = 10 }: { presence: Presence; size?: number }) {
  return <span className={cx('status-dot', `status-${presence}`)} style={{ width: size, height: size }} />;
}

export function Avatar({
  userId,
  size = 32,
  status = false,
  speaking = false,
  guildId,
}: {
  userId: string;
  size?: number;
  status?: boolean;
  speaking?: boolean;
  guildId?: string | null;
}) {
  const user = useStore((s) => s.users[userId]);
  const name = useStore((s) => nameOf(s, userId, guildId));
  const presence = useStore((s) => presenceOf(s, userId));
  const src = fileUrl(user?.avatar_url);
  return (
    <span className={cx('avatar', speaking && 'speaking')} style={{ width: size, height: size }}>
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <span className="avatar-fallback" style={{ background: colorFor(userId), fontSize: size * 0.4 }}>
          {initials(name)}
        </span>
      )}
      {status && (
        <span className="avatar-status">
          <StatusDot presence={presence} size={Math.max(8, Math.round(size * 0.3))} />
        </span>
      )}
    </span>
  );
}

export function GuildIcon({ guildId, size = 48 }: { guildId: string; size?: number }) {
  const guild = useStore((s) => s.guilds[guildId]);
  if (!guild) return null;
  const src = fileUrl(guild.icon_url);
  return src ? (
    <img className="guild-icon-img" src={src} alt="" style={{ width: size, height: size }} draggable={false} />
  ) : (
    <span className="guild-icon-text" style={{ width: size, height: size, fontSize: size * 0.32 }}>
      {initials(guild.name)}
    </span>
  );
}

/** Group DM icon: custom image, or the first two members' avatars stacked. */
export function GroupIcon({ channel, size = 32 }: { channel: Channel; size?: number }) {
  const meId = useStore((s) => s.me?.id);
  const src = fileUrl(channel.icon_url);
  if (src) return <img className="group-icon-img" src={src} alt="" style={{ width: size, height: size }} />;
  const others = (channel.recipient_ids ?? []).filter((id) => id !== meId).slice(0, 2);
  if (others.length < 2) {
    return (
      <span className="group-icon-fallback" style={{ width: size, height: size, background: colorFor(channel.id) }}>
        <Users size={size * 0.5} />
      </span>
    );
  }
  const inner = Math.round(size * 0.68);
  return (
    <span className="group-icon-stack" style={{ width: size, height: size }}>
      <Avatar userId={others[0]} size={inner} />
      <Avatar userId={others[1]} size={inner} />
    </span>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-wide')} role="dialog" aria-modal="true">
        <button className="modal-close icon-btn" onClick={onClose} aria-label="Fechar">
          <X size={20} />
        </button>
        {title && (
          <div className="modal-header">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Carregando" />;
}
