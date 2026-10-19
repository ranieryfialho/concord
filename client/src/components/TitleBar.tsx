import { Copy, Minus, Square, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { native } from '../native';
import { useStore } from '../store';

/** Frameless-window title bar, only rendered inside the desktop shell. */
export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  const status = useStore((s) => s.status);

  useEffect(() => {
    if (!native) return;
    void native.window.isMaximized().then(setMaximized);
    return native.window.onMaximizeChange(setMaximized);
  }, []);

  if (!native) return null;
  return (
    <div className="titlebar">
      <span className="titlebar-title">Concord{status === 'reconnecting' ? ' · reconectando…' : ''}</span>
      <div className="titlebar-buttons">
        <button onClick={() => native!.window.minimize()} aria-label="Minimizar">
          <Minus size={14} />
        </button>
        <button onClick={() => native!.window.maximize()} aria-label="Maximizar">
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button className="close" onClick={() => native!.window.close()} aria-label="Fechar">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
