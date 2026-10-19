import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';

interface MenuState {
  x: number;
  y: number;
  content: ReactNode;
}

const useMenu = create<{ menu: MenuState | null }>()(() => ({ menu: null }));

/** Opens a floating menu at viewport coordinates. Content closes it with closeMenu(). */
export function openMenu(x: number, y: number, content: ReactNode) {
  useMenu.setState({ menu: { x, y, content } });
}

export function closeMenu() {
  useMenu.setState({ menu: null });
}

/** Opens the menu next to an element (for buttons) instead of at the pointer. */
export function openMenuAt(el: HTMLElement, content: ReactNode) {
  const r = el.getBoundingClientRect();
  openMenu(r.left, r.bottom + 4, content);
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
      top: Math.max(8, Math.min(menu.y, window.innerHeight - height - 8)),
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
