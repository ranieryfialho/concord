import { Info } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { native } from '../native';
import { RUNNING_BUILD, installDesktopUpdate, useDesktopUpdate } from '../update';

const OS_NAME: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

/** Version of the installed desktop app: from its updater, or from the user agent on 0.1.1. */
function desktopVersion(current: string): string | null {
  if (!native) return null;
  return current || /\/(\d+\.\d+\.\d+) Chrome\//.exec(navigator.userAgent)?.[1] || null;
}

/** The web app's build id starts with its build time in base 36 (see vite.config.ts). */
function buildLabel(): string {
  if (RUNNING_BUILD === 'dev') return 'desenvolvimento';
  const ms = parseInt(RUNNING_BUILD.split('-')[0], 36);
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : RUNNING_BUILD;
}

/** (i) at the bottom of the server rail: installed version and updates. */
export function AppInfoButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="rail-item app-info" ref={ref}>
      <button className={`rail-button info${open ? ' open' : ''}`} title="Sobre o Concord" onClick={() => setOpen(!open)}>
        <Info size={20} />
      </button>
      {open && <AppInfoPopover />}
    </div>
  );
}

function AppInfoPopover() {
  const { status, current, version, percent } = useDesktopUpdate();
  const installed = desktopVersion(current);
  const [checking, setChecking] = useState<'idle' | 'busy' | 'done'>('idle');

  useEffect(() => {
    if (checking !== 'busy') return;
    const t = setTimeout(() => setChecking('done'), 6000);
    return () => clearTimeout(t);
  }, [checking]);

  const canCheck = !!native?.updates?.check && status === 'idle';

  return (
    <div className="app-info-popover" role="dialog" aria-label="Sobre o Concord">
      <img src="/icon.png" alt="" className="app-info-logo" draggable={false} />
      <strong>Concord</strong>
      <dl>
        {installed ? (
          <>
            <dt>App desktop</dt>
            <dd>
              v{installed}
              {native && OS_NAME[native.platform] ? ` · ${OS_NAME[native.platform]}` : ''}
            </dd>
          </>
        ) : (
          <>
            <dt>App</dt>
            <dd>Navegador</dd>
          </>
        )}
        <dt>Versão web</dt>
        <dd>{buildLabel()}</dd>
      </dl>

      {status === 'downloading' && <p className="small muted">Baixando a versão {version}… {percent}%</p>}
      {(status === 'ready' || status === 'manual') && (
        <button className="btn btn-primary small" onClick={installDesktopUpdate}>
          {status === 'ready' ? `Reiniciar e atualizar para ${version}` : `Baixar a versão ${version}`}
        </button>
      )}
      {canCheck && (
        <button
          className="btn small"
          disabled={checking === 'busy'}
          onClick={() => {
            setChecking('busy');
            native!.updates!.check!();
          }}
        >
          {checking === 'busy' ? 'Procurando…' : 'Procurar atualizações'}
        </button>
      )}
      {canCheck && checking === 'done' && <p className="small muted">Você está na versão mais recente.</p>}
    </div>
  );
}
