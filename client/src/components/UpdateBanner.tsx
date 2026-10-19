import { RefreshCw, X } from 'lucide-react';
import { restartToUpdate, snoozeUpdate, useUpdate } from '../update';
import { useVoice } from '../voice';

/** "A new version is out" bar at the top of the app. */
export function UpdateBanner() {
  const available = useUpdate((s) => !!s.available && s.snoozedUntil < Date.now());
  const inCall = useVoice((s) => !!s.channelId);
  if (!available) return null;
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
