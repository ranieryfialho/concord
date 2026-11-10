import { create } from 'zustand';
import { native, type DesktopUpdateState } from './native';
import { voice } from './voice';

// "New version available": the server tells us which client build it serves (READY.client_build, and
// APP_UPDATE when a deploy swaps the files under a running server). If it differs from the build we are
// running, the app shows a banner whose button reloads into the new version. The desktop shell loads the
// app from the server, so a reload updates it too.

declare const __BUILD_ID__: string;

export const RUNNING_BUILD = __BUILD_ID__;

interface UpdateState {
  available: string | null;
  /** Hidden with "Depois" until this time. */
  snoozedUntil: number;
}

export const useUpdate = create<UpdateState>()(() => ({ available: null, snoozedUntil: 0 }));

const SNOOZE_MS = 30 * 60_000;

export function serverBuild(build: string | null | undefined) {
  if (!build || RUNNING_BUILD === 'dev' || build === RUNNING_BUILD) return;
  useUpdate.setState({ available: build });
  // A new release was just deployed: the desktop shell may have a new installer too.
  void detectDesktopUpdate();
}

export function snoozeUpdate() {
  useUpdate.setState({ snoozedUntil: Date.now() + SNOOZE_MS });
  setTimeout(() => useUpdate.setState({ snoozedUntil: 0 }), SNOOZE_MS);
}

export function restartToUpdate() {
  voice.leave();
  location.reload();
}

// The desktop shell itself (Electron + installer) updates separately: the shell downloads the new
// installer and reports progress here (desktop/updater.js). Shells from before the updater can't, so
// they get a link to the download page when a newer installer is published.

const DESKTOP_OS: Record<string, string> = { win32: 'win', darwin: 'mac', linux: 'linux' };

export const useDesktopUpdate = create<DesktopUpdateState>()(() => ({ status: 'idle', current: '', version: null, percent: 0 }));

let directInstaller: string | null = null;

/**
 * Asks the server whether a newer installer than the running shell exists, independent of the shell's own
 * (infrequent) check. If so, the shell is told to check/download right away; until it reports progress the
 * UI shows "available" (status 'manual'), and installDesktopUpdate() starts the download.
 */
export async function detectDesktopUpdate() {
  const updates = native?.updates;
  if (!native || !updates) return;
  const s = useDesktopUpdate.getState();
  if (s.status !== 'idle') return;
  const os = DESKTOP_OS[native.platform];
  const current = s.current || /\/(\d+\.\d+\.\d+) Chrome\//.exec(navigator.userAgent)?.[1];
  if (!current) return;
  try {
    const { builds } = (await (await fetch('/api/desktop/latest')).json()) as { builds: { os: string; version: string }[] };
    const build = builds.find((b) => b.os === os && newerVersion(b.version, current));
    if (!build || useDesktopUpdate.getState().status !== 'idle') return;
    useDesktopUpdate.setState({ status: 'manual', current, version: build.version });
    updates.check?.();
  } catch {
    /* offline: the next attempt tries again */
  }
}

export function initDesktopUpdates() {
  if (!native) return;
  if (native.updates) {
    void native.updates.getState().then((s) => {
      if (s) useDesktopUpdate.setState(s);
      void detectDesktopUpdate();
    });
    native.updates.onState((s) => useDesktopUpdate.setState(s));
    return;
  }
  // Electron puts "<app>/<version>" right before "Chrome/" in its default user agent ("@concord/desktop/0.1.1 Chrome/…").
  const current = /\/(\d+\.\d+\.\d+) Chrome\//.exec(navigator.userAgent)?.[1];
  const os = DESKTOP_OS[native.platform];
  if (!current) return;
  void fetch('/api/desktop/latest')
    .then((r) => r.json())
    .then(({ builds }: { builds: { os: string; version: string; url: string }[] }) => {
      const build = builds.find((b) => b.os === os && newerVersion(b.version, current));
      if (!build) return;
      useDesktopUpdate.setState({ status: 'manual', current, version: build.version });
      // Windows has a single installer: download it straight away. Linux (deb or AppImage?) and macOS
      // (which chip?) go to the page to pick.
      if (os === 'win') directInstaller = build.url;
    })
    .catch(() => {});
}

function newerVersion(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

export function installDesktopUpdate() {
  const status = useDesktopUpdate.getState().status;
  if (status === 'ready' && native?.updates) {
    voice.leave();
    native.updates.install();
  } else if (status === 'manual' && native?.updates?.check) {
    // The shell can update itself: have it download now (progress comes back through onState).
    useDesktopUpdate.setState({ status: 'downloading', percent: 0 });
    native.updates.check();
    setTimeout(() => {
      if (useDesktopUpdate.getState().status === 'downloading' && useDesktopUpdate.getState().percent === 0) {
        window.open(directInstaller ?? '/download', '_blank'); // the shell didn't start: fall back to the page
      }
    }, 15_000);
  } else {
    window.open(directInstaller ?? '/download', '_blank'); // the desktop shell opens it in the system browser
  }
}
