import { Download, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { installDesktopUpdate, restartToUpdate, snoozeUpdate, useDesktopUpdate, useUpdate } from '../update';
import { useVoice } from '../voice';

/** "A new version is out" bar at the top of the app. */
export function UpdateBanner() {
  const available = useUpdate((s) => !!s.available && s.snoozedUntil < Date.now());
  const inCall = useVoice((s) => !!s.channelId);
  if (!available) return <DesktopUpdateBanner />;
  return (
    <div className="update-banner" role="status">
      <RefreshCw size={16} />
      <span>
        Uma nova versão do Concord está disponível.{inCall && ' Reiniciar vai tirar você da chamada por alguns segundos.'}
      </span>
      <button className="btn small btn-light" onClick={restartToUpdate}>
        Reiniciar agora
      </button>
      <button className="icon-btn" title="Depois" onClick={snoozeUpdate}>
        <X size={16} />
      </button>
    </div>
  );
}

/** The desktop app itself: downloading, ready to install, or (old shells) a link to the download page. */
function DesktopUpdateBanner() {
  const { status, version, percent } = useDesktopUpdate();
  const [hidden, setHidden] = useState<string | null>(null);
  if (status === 'idle' || hidden === status) return null;
  return (
    <div className="update-banner" role="status">
      <Download size={16} />
      <span>
        {status === 'downloading' && `Baixando a versão ${version} do Concord… ${percent}%`}
        {status === 'ready' && `A versão ${version} do Concord está pronta. O app vai fechar, instalar e abrir de novo.`}
        {status === 'manual' && `O Concord para desktop precisa ser atualizado para a versão ${version}.`}
      </span>
      {status !== 'downloading' && (
        <button className="btn small btn-light" onClick={installDesktopUpdate}>
          {status === 'ready' ? 'Reiniciar e atualizar' : 'Baixar atualização'}
        </button>
      )}
      <button className="icon-btn" title="Depois" onClick={() => setHidden(status)}>
        <X size={16} />
      </button>
    </div>
  );
}
