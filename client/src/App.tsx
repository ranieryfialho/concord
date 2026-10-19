import { useEffect, useState } from 'react';
import { getToken, setToken } from './api';
import { AuthScreen } from './components/AuthScreen';
import { Layout } from './components/Layout';
import { Spinner } from './components/common';
import { TitleBar } from './components/TitleBar';
import { gateway } from './gateway';
import { resetStore, useStore } from './store';

export function App() {
  const [token, setTokenState] = useState(getToken());
  const status = useStore((s) => s.status);
  const me = useStore((s) => s.me);

  useEffect(() => {
    const onLogout = () => setTokenState(null);
    window.addEventListener('concord:logout', onLogout);
    gateway.onAuthFailed = () => {
      setToken(null);
      resetStore();
      setTokenState(null);
    };
    return () => window.removeEventListener('concord:logout', onLogout);
  }, []);

  useEffect(() => {
    if (!token) return;
    gateway.connect();
    if ('Notification' in window && Notification.permission === 'default' && !window.ConcordNative) {
      void Notification.requestPermission();
    }
    return () => gateway.disconnect();
  }, [token]);

  if (!token) {
    return (
      <div className="app-root">
        <TitleBar />
        <AuthScreen
          onAuthenticated={(t) => {
            setToken(t);
            setTokenState(t);
          }}
        />
      </div>
    );
  }

  if (!me) {
    return (
      <div className="app-root">
        <TitleBar />
        <div className="loading-screen">
          <div className="brand-mark big">C</div>
          <Spinner />
          <p>{status === 'reconnecting' ? 'Reconectando ao servidor…' : 'Conectando…'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="app-root">
      <TitleBar />
      <Layout />
    </div>
  );
}
