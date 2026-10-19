import { Check, Copy, Download } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { native } from '../native';
import { copyText } from '../store';

type Mode = 'login' | 'register' | 'forgot';
interface AuthResponse {
  token: string;
  recovery_code?: string;
}

/** The recovery code is the only way back into the account without e-mail, and it is shown once. */
export function RecoveryCodeBox({ code }: { code: string }) {
  return (
    <div className="recovery-code">
      <code>{code}</code>
      <button type="button" className="btn btn-secondary" onClick={() => copyText(code, 'Código copiado')}>
        <Copy size={16} /> Copiar
      </button>
    </div>
  );
}

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // After sign-up / reset, hold the session until the user has seen the new recovery code.
  const [issued, setIssued] = useState<{ token: string; code: string } | null>(null);

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setPassword('');
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let res: AuthResponse;
      if (mode === 'login') res = await api<AuthResponse>('/auth/login', { body: { username, password } });
      else if (mode === 'register') {
        res = await api<AuthResponse>('/auth/register', { body: { username, password, display_name: displayName || undefined } });
      } else {
        res = await api<AuthResponse>('/auth/reset-password', {
          body: { username, recovery_code: recoveryCode, new_password: password },
        });
      }
      if (res.recovery_code) setIssued({ token: res.token, code: res.recovery_code });
      else onAuthenticated(res.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (issued) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="brand-mark big">C</div>
          <h1>Guarde seu código de recuperação</h1>
          <p className="muted">
            Se você esquecer a senha, este código é a única forma de recuperar a conta. Ele aparece só desta vez: anote em um lugar seguro.
          </p>
          <RecoveryCodeBox code={issued.code} />
          <button className="btn btn-primary btn-block" onClick={() => onAuthenticated(issued.token)}>
            <Check size={16} /> Guardei, continuar
          </button>
        </div>
      </div>
    );
  }

  const titles: Record<Mode, [string, string]> = {
    login: ['Boas-vindas de volta!', 'Que bom te ver de novo.'],
    register: ['Criar uma conta', 'Converse com seus amigos e comunidades.'],
    forgot: ['Recuperar a senha', 'Use o código de recuperação que você recebeu ao criar a conta.'],
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark big">C</div>
        <h1>{titles[mode][0]}</h1>
        <p className="muted">{titles[mode][1]}</p>

        <label className="field">
          <span>Nome de usuário</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required />
        </label>
        {mode === 'register' && (
          <label className="field">
            <span>Nome de exibição (opcional)</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
          </label>
        )}
        {mode === 'forgot' && (
          <label className="field">
            <span>Código de recuperação</span>
            <input
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
        )}
        <label className="field">
          <span>{mode === 'forgot' ? 'Nova senha' : 'Senha'}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'login' ? undefined : 6}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {mode === 'login' ? 'Entrar' : mode === 'register' ? 'Continuar' : 'Redefinir senha'}
        </button>
        {mode === 'login' && (
          <p className="muted small">
            <button type="button" className="link" onClick={() => switchMode('forgot')}>
              Esqueceu a senha?
            </button>
          </p>
        )}
        <p className="muted small">
          {mode === 'register' ? 'Já tem uma conta? ' : mode === 'login' ? 'Precisa de uma conta? ' : 'Lembrou a senha? '}
          <button type="button" className="link" onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Registre-se' : 'Entrar'}
          </button>
        </p>
      </form>
      {!native && (
        <a className="auth-download" href="/download">
          <Download size={16} /> Baixar o app para desktop
        </a>
      )}
    </div>
  );
}
