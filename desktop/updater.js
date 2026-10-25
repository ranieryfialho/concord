// Desktop self-update. Windows (NSIS) and Linux (AppImage/deb) use electron-updater against the generic
// feed the server exposes at /downloads (latest*.yml, published with the installers by
// .github/workflows/desktop.yml). macOS builds are unsigned, which Squirrel.Mac refuses, so there we
// download the .dmg ourselves and swap the .app in place once the app has quit.
// The web app shows the progress and the "restart to update" button (see client/src/update.ts).

const { app, net, shell, Notification } = require('electron');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 30 * 60_000;

/** idle → downloading → ready; "manual" when it can't update itself and the user must use /download. */
let state = { status: 'idle', current: app.getVersion(), version: null, percent: 0 };
let notify = () => {};
let installFn = null;
let checkNow = () => {};

function set(patch) {
  const wasReady = state.status === 'ready';
  state = { ...state, ...patch };
  notify(state);
  if (!wasReady && state.status === 'ready' && Notification.isSupported()) {
    new Notification({ title: 'Atualização do Concord pronta', body: `A versão ${state.version} será instalada ao reiniciar o app.` }).show();
  }
}

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function failed(err) {
  console.warn('[update]', err);
  // A known newer version we couldn't fetch or install: send the user to the download page instead.
  set({ status: state.version ? 'manual' : 'idle' });
}

function electronUpdater(origin) {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.setFeedURL({ provider: 'generic', url: `${origin}/downloads` });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // "Depois" still updates on the next quit
  autoUpdater.on('update-available', (info) => set({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ percent: Math.floor(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => set({ status: 'ready', version: info.version, percent: 100 }));
  autoUpdater.on('error', failed);
  installFn = () => autoUpdater.quitAndInstall(true, true); // silent installer, reopen the app afterwards
  return () => autoUpdater.checkForUpdates().catch(failed);
}

async function download(url, dest) {
  const res = await net.fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} em ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!out.write(chunk)) await once(out, 'drain');
    const percent = total ? Math.floor((got / total) * 100) : 0;
    if (percent !== state.percent) set({ percent });
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
}

// Runs after the app quits: mount the dmg, replace the .app (rolling back on failure) and reopen it.
const MAC_SWAP = `
pid=$1; dmg=$2; app=$3
while kill -0 "$pid" 2>/dev/null; do sleep 0.5; done
mnt=$(mktemp -d)
hdiutil attach -nobrowse -noverify -mountpoint "$mnt" "$dmg" >/dev/null || { open "$dmg"; exit 1; }
src=$(ls -d "$mnt"/*.app | head -n 1)
rm -rf "$app.old"
if mv "$app" "$app.old" && ditto "$src" "$app"; then rm -rf "$app.old"; else rm -rf "$app"; mv "$app.old" "$app"; fi
hdiutil detach "$mnt" -quiet
xattr -dr com.apple.quarantine "$app" 2>/dev/null
rm -f "$dmg"
open "$app"
`;

function macUpdater(origin) {
  const appBundle = path.resolve(process.execPath, '../../..'); // …/Concord.app/Contents/MacOS/Concord
  return async () => {
    try {
      const { builds } = await (await net.fetch(`${origin}/api/desktop/latest`)).json();
      const build = builds.find((b) => b.os === 'mac' && b.arch === process.arch && b.ext === 'dmg');
      if (!build || !newer(build.version, state.current)) return;
      set({ status: 'downloading', version: build.version, percent: 0 });
      const dmg = path.join(os.tmpdir(), build.name);
      await download(`${origin}${build.url}`, dmg);
      let writable = true;
      try {
        fs.accessSync(path.dirname(appBundle), fs.constants.W_OK);
      } catch {
        writable = false;
      }
      installFn = writable
        ? () => {
            spawn('/bin/sh', ['-c', MAC_SWAP, 'sh', String(process.pid), dmg, appBundle], { detached: true, stdio: 'ignore' }).unref();
            app.quit();
          }
        : () => {
            // No permission to replace the app: open the dmg so the user drags it to Applications.
            void shell.openPath(dmg);
            app.quit();
          };
      set({ status: 'ready', percent: 100 });
    } catch (err) {
      failed(err);
    }
  };
}

function initUpdater({ origin, onState }) {
  notify = onState;
  if (!app.isPackaged) return;
  const check = process.platform === 'darwin' ? macUpdater(origin) : electronUpdater(origin);
  const tick = () => {
    if (state.status === 'idle') void check();
  };
  checkNow = tick;
  setTimeout(tick, FIRST_CHECK_MS);
  setInterval(tick, CHECK_EVERY_MS);
}

module.exports = {
  initUpdater,
  updateState: () => state,
  installUpdate: () => installFn?.(),
  checkForUpdate: () => checkNow(),
};
