import { useEffect } from 'react';
import { useVoice, voice } from '../voice';

const MOUSE_LABELS: Record<string, string> = { Mouse3: 'Botão lateral (voltar)', Mouse4: 'Botão lateral (avançar)' };

/** Readable name for a KeyboardEvent.code (or our "MouseN"). */
export function keyLabel(code: string): string {
  if (MOUSE_LABELS[code]) return MOUSE_LABELS[code];
  if (code.startsWith('Mouse')) return `Botão ${code.slice(5)} do mouse`;
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  const names: Record<string, string> = {
    Space: 'Espaço',
    Backquote: '`',
    CapsLock: 'Caps Lock',
    ShiftLeft: 'Shift esquerdo',
    ShiftRight: 'Shift direito',
    ControlLeft: 'Ctrl esquerdo',
    ControlRight: 'Ctrl direito',
    AltLeft: 'Alt',
    AltRight: 'Alt Gr',
    Tab: 'Tab',
  };
  return names[code] ?? code;
}

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/**
 * Push-to-talk listener. Works while the Concord window is focused (browser and desktop). Letter keys
 * are ignored while typing in a text box, so the shortcut doesn't eat what you type.
 */
export function PushToTalkListener() {
  const enabled = useVoice((s) => s.pttEnabled && !!s.pttKey && !!s.channelId);
  const key = useVoice((s) => s.pttKey);

  useEffect(() => {
    if (!enabled) return;
    const isChar = (e: KeyboardEvent) => e.key.length === 1;
    const down = (e: KeyboardEvent) => {
      if (e.code !== key || e.repeat) return;
      if (typingIn(e.target) && isChar(e)) return;
      voice.pushToTalk(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === key) voice.pushToTalk(false);
    };
    const mdown = (e: MouseEvent) => {
      if (`Mouse${e.button}` !== key) return;
      e.preventDefault(); // side buttons would otherwise navigate back/forward
      voice.pushToTalk(true);
    };
    const mup = (e: MouseEvent) => {
      if (`Mouse${e.button}` === key) voice.pushToTalk(false);
    };
    const release = () => voice.pushToTalk(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('mousedown', mdown);
    window.addEventListener('mouseup', mup);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('mousedown', mdown);
      window.removeEventListener('mouseup', mup);
      window.removeEventListener('blur', release);
      release();
    };
  }, [enabled, key]);

  return null;
}
