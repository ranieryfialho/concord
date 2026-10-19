import { create } from 'zustand';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'concord.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

export const useTheme = create<{ pref: ThemePref; resolved: 'light' | 'dark' }>()(() => ({ pref: readPref(), resolved: 'light' }));

export function applyTheme() {
  const { pref } = useTheme.getState();
  const resolved = pref === 'system' ? (media.matches ? 'dark' : 'light') : pref;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#16171b' : '#eef0f4');
  useTheme.setState({ resolved });
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* ignore */
  }
  useTheme.setState({ pref });
  applyTheme();
}

export function toggleTheme() {
  setThemePref(useTheme.getState().resolved === 'dark' ? 'light' : 'dark');
}

media.addEventListener('change', () => {
  if (useTheme.getState().pref === 'system') applyTheme();
});

applyTheme();
