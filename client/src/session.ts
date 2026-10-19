import { api, setToken } from './api';
import { gateway } from './gateway';
import { resetStore } from './store';
import { voice } from './voice';

export function logout() {
  voice.leave();
  api('/auth/logout', { method: 'POST' }).catch(() => {});
  gateway.disconnect();
  setToken(null);
  resetStore();
  window.dispatchEvent(new Event('concord:logout'));
}
