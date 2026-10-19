import { useEffect, useRef, useState } from 'react';

const GROUPS: [string, string[]][] = [
  ['Frequentes', ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👀', '✅', '🙏']],
  [
    'Rostos',
    ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😋', '😛', '😜', '🤪', '🤗', '🤔', '🤨', '😐', '😑', '😶', '🙄', '😏', '😬', '😌', '😴', '😷', '🤒', '🤯', '🥳', '😎', '🤓', '🧐', '😕', '😟', '😮', '😲', '🥺', '😭', '😱', '😤', '😡', '🤬', '💀', '🤡', '👻'],
  ],
  ['Gestos', ['👋', '🤚', '✋', '👌', '🤌', '✌️', '🤞', '🤟', '🤘', '👈', '👉', '👆', '👇', '👍', '👎', '✊', '👊', '👏', '🙌', '🫶', '🤝', '💪', '🫡', '🙏']],
  ['Objetos', ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💯', '💥', '✨', '⭐', '🌟', '🔥', '🎉', '🎊', '🎁', '🏆', '🎮', '🎧', '🎵', '📌', '📎', '💻', '📱', '☕', '🍕', '🍔', '🍺']],
  ['Símbolos', ['✅', '❌', '⚠️', '❓', '❗', '➕', '➖', '🔴', '🟢', '🔵', '⬆️', '⬇️', '➡️', '⬅️', '🔁', '🆗', '🆕', '💤']],
];

export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', onDown));
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="emoji-picker" ref={ref} onMouseDown={(e) => e.stopPropagation()}>
      <div className="emoji-scroll scroll">
        {GROUPS.map(([title, list]) => (
          <div key={title}>
            <div className="emoji-group-title">{title}</div>
            <div className="emoji-grid">
              {list.map((e, i) => (
                <button key={`${e}${i}`} className="emoji-btn" onClick={() => onPick(e)} onMouseEnter={() => setHover(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="emoji-footer">{hover ? <span className="emoji-preview">{hover}</span> : <span className="muted small">Escolha um emoji</span>}</div>
    </div>
  );
}
