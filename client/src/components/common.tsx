import { ArrowLeft, Users, X } from 'lucide-react';
import {
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type TouchEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { fileUrl } from '../api';
import { nameOf, presenceOf, setState, useStore } from '../store';
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

// Keep in sync with the phone breakpoint in styles.css.
const mobileQuery = window.matchMedia('(max-width: 720px)');

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    (cb) => {
      mobileQuery.addEventListener('change', cb);
      return () => mobileQuery.removeEventListener('change', cb);
    },
    () => mobileQuery.matches,
  );
}

/** Phone layout only (hidden by CSS on wider screens): returns from the open channel to the channel list. */
export function MobileBack() {
  return (
    <button className="icon-btn mobile-only" title="Voltar" onClick={() => setState({ mobilePane: 'nav' })}>
      <ArrowLeft size={22} />
    </button>
  );
}

/**
 * Touch-and-hold handlers for elements that have a right-click menu: iOS never fires `contextmenu`.
 * A press that moves (a scroll) is not a hold, and the tap that ends a hold does not also click.
 */
/** The current time, re-rendering every second while mounted (timers). */
export function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef(0);
  const fired = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  return {
    onTouchStart(e: TouchEvent) {
      const t = e.touches[0];
      fired.current = false;
      start.current = { x: t.clientX, y: t.clientY };
      timer.current = window.setTimeout(() => {
        fired.current = true;
        onLongPress(start.current.x, start.current.y);
      }, 500);
    },
    onTouchMove(e: TouchEvent) {
      const t = e.touches[0];
      if (Math.hypot(t.clientX - start.current.x, t.clientY - start.current.y) > 10) clearTimeout(timer.current);
    },
    onTouchEnd(e: TouchEvent) {
      clearTimeout(timer.current);
      // Swallows the emulated mousedown/click, which would close the menu that just opened.
      if (fired.current) e.preventDefault();
    },
    onClickCapture(e: MouseEvent) {
      if (!fired.current) return;
      fired.current = false;
      e.stopPropagation();
    },
  };
}

/**
 * A column the user can widen or narrow by dragging its inner edge (the left edge of a right-hand
 * column, the right edge of a left-hand one). The width is remembered under `storageKey`;
 * double-clicking the edge restores the default.
 */
export function ResizablePanel({
  storageKey,
  initial = 360,
  min = 280,
  max = 760,
  side = 'right',
  children,
}: {
  side?: 'left' | 'right';
  storageKey: string;
  initial?: number;
  min?: number;
  max?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // The width the user chose; what is drawn is capped so the stage beside it keeps STAGE_MIN.
  const [preferred, setPreferred] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return saved ? Math.max(min, Math.min(saved, max)) : initial;
    } catch {
      return initial;
    }
  });
  const [available, setAvailable] = useState(Infinity);
  const width = Math.round(Math.max(min, Math.min(preferred, max, available - STAGE_MIN)));
  const latest = useRef(width);
  latest.current = width;

  useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setAvailable(parent.clientWidth));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  const save = (w: number) => {
    try {
      localStorage.setItem(storageKey, String(w));
    } catch {
      /* storage unavailable */
    }
  };

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = latest.current;
    document.body.classList.add('col-resizing');
    const dir = side === 'right' ? -1 : 1;
    const onMove = (ev: globalThis.PointerEvent) =>
      setPreferred(Math.max(min, Math.min(startWidth + dir * (ev.clientX - startX), max)));
    const onUp = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setPreferred(latest.current);
      save(latest.current);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div className={cx('resizable-panel', side)} ref={ref} style={{ width }}>
      <div
        className="resize-handle"
        role="separator"
        aria-orientation="vertical"
        title="Arraste para redimensionar (duplo clique restaura)"
        onPointerDown={onPointerDown}
        onDoubleClick={() => {
          setPreferred(initial);
          save(initial);
        }}
      />
      {children}
    </div>
  );
}

const STAGE_MIN = 420;
