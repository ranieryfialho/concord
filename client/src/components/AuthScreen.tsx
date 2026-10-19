import { type FormEvent, useState } from 'react';
import { api } from '../api';

export function AuthScreen({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = mode === 'login' ? { username, password } : { username, password, display_name: displayName || undefined };
      const res = await api<{ token: string }>(`/auth/${mode}`, { body });
      onAuthenticated(res.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand-mark big">C</div>
        <h1>{mode === 'login' ? 'Boas-vindas de volta!' : 'Criar uma conta'}</h1>
        <p className="muted">{mode === 'login' ? 'Que bom te ver de novo.' : 'Converse com seus amigos e comunidades.'}</p>

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
        <label className="field">
          <span>Senha</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
            minLength={mode === 'register' ? 6 : undefined}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {mode === 'login' ? 'Entrar' : 'Continuar'}
        </button>
        <p className="muted small">
          {mode === 'login' ? 'Precisa de uma conta? ' : 'Já tem uma conta? '}
          <button
            type="button"
            className="link"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
            }}
          >
            {mode === 'login' ? 'Registre-se' : 'Entrar'}
          </button>
        </p>
      </form>
    </div>
  );
}
