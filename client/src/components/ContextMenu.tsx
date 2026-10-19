import { Check, ChevronRight } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

interface MenuState {
  x: number;
  y: number;
  content: ReactNode;
  /** y is where the menu's bottom edge goes (menus opened from a bar at the bottom). */
  above?: boolean;
}

const useMenu = create<{ menu: MenuState | null }>()(() => ({ menu: null }));

/** Opens a floating menu at viewport coordinates. Content closes it with closeMenu(). */
export function openMenu(x: number, y: number, content: ReactNode, above = false) {
  useMenu.setState({ menu: { x, y, content, above } });
}

export function closeMenu() {
  useMenu.setState({ menu: null });
}

/** Opens the menu next to an element (for buttons) instead of at the pointer. */
export function openMenuAt(el: HTMLElement, content: ReactNode, placement: 'below' | 'above' = 'below') {
  const r = el.getBoundingClientRect();
  if (placement === 'above') openMenu(r.left, r.top - 6, content, true);
  else openMenu(r.left, r.bottom + 4, content);
}

export function ContextMenuHost() {
  const menu = useMenu((s) => s.menu);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Keep the menu inside the window once its size is known.
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const { width, height } = ref.current.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(menu.x, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(menu.above ? menu.y - height : menu.y, window.innerHeight - height - 8)),
    });
  }, [menu]);

  useLayoutEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeMenu();
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('resize', closeMenu);
    };
  }, [menu]);

  if (!menu) return null;
  return (
    <div
      ref={ref}
      className="context-menu"
      style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.content}
    </div>
  );
}

// ---------- Building blocks for menu contents ----------

export function MenuItem(props: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button className={`context-menu-item${props.danger ? ' danger' : ''}`} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}

/** Menu row with a checkbox on the right (Discord-style toggles). */
export function CheckItem(props: { label: string; checked: boolean; onChange: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      className={`context-menu-item${props.danger ? ' danger' : ''}`}
      role="menuitemcheckbox"
      aria-checked={props.checked}
      onClick={props.onChange}
      disabled={props.disabled}
    >
      {props.label}
      <span className={`menu-check push-right${props.checked ? ' on' : ''}`}>{props.checked && <Check size={12} strokeWidth={3} />}</span>
    </button>
  );
}

/** Row that opens a flyout to the side on hover (or click, for touch). */
export function SubMenu({ label, children, disabled }: { label: string; children: ReactNode; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [left, setLeft] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const flyRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !rowRef.current || !flyRef.current) return;
    const row = rowRef.current.getBoundingClientRect();
    const fly = flyRef.current.getBoundingClientRect();
    setLeft(row.right + fly.width + 8 > window.innerWidth);
    // Keep the flyout inside the window vertically.
    const overflow = row.top + fly.height + 8 - window.innerHeight;
    flyRef.current.style.top = `${overflow > 0 ? -6 - overflow : -6}px`;
  }, [open]);

  return (
    <div className="context-sub" ref={rowRef} onMouseEnter={() => !disabled && setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className="context-menu-item" disabled={disabled} onClick={() => setOpen(!open)}>
        {label} <ChevronRight size={14} className="push-right" />
      </button>
      {open && (
        <div className={`context-menu context-submenu${left ? ' left' : ''}`} ref={flyRef}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuSep() {
  return <div className="context-menu-sep" />;
}
