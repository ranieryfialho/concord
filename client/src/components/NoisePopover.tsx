import { AudioLines } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { micSettings } from '../mic';
import { openModal } from '../store';
import { cx } from '../utils';
import { useVoice, voice } from '../voice';
import { MicMeter, useMicReader } from './MicMeter';

/** Button in the "voice connected" panel with a quick noise-suppression switch and a live mic meter. */
export function NoiseButton() {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const advanced = useVoice((s) => micSettings(s).noiseSuppression === 'advanced');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="noise-anchor" ref={ref}>
      <button
        className={cx('icon-btn', advanced && 'accent')}
        title="Supressão de ruído"
        onClick={(e) => {
          // Fixed position: the sidebar is narrower than the popover and clips overflow.
          const r = e.currentTarget.getBoundingClientRect();
          setPos({ left: Math.max(8, Math.min(r.left + r.width / 2 - 140, window.innerWidth - 288)), bottom: window.innerHeight - r.top + 10 });
          setOpen(!open);
        }}
      >
        <AudioLines size={20} />
      </button>
      {open && pos && <NoisePopover pos={pos} onClose={() => setOpen(false)} />}
    </div>
  );
}

function NoisePopover({ pos, onClose }: { pos: { left: number; bottom: number }; onClose: () => void }) {
  const advanced = useVoice((s) => micSettings(s).noiseSuppression === 'advanced');
  const read = useMicReader(null);
  return (
    <div className="noise-popover" style={pos}>
      <label className="noise-popover-head">
        <strong>Supressão de ruído</strong>
        <input type="checkbox" className="switch" checked={advanced} onChange={(e) => void voice.setNoiseSuppression(e.target.checked ? 'advanced' : 'standard')} />
      </label>
      <p className="small muted">
        Com a supressão avançada ligada, faça barulho enquanto fala (bata palmas, digite): quem está na chamada só ouve a sua voz. Ela roda no seu
        computador.
      </p>
      <strong className="small">Seu microfone agora</strong>
      <MicMeter read={read} />
      <button
        className="link small"
        onClick={() => {
          onClose();
          openModal({ type: 'userSettings', tab: 'voice' });
        }}
      >
        Mais ajustes de voz
      </button>
    </div>
  );
}
