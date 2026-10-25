// Concord desktop shell. Same split as the Discord client: a thin Electron host
// (splash, window chrome, tray, notifications, persisted window state) that loads
// the web app and exposes a small native bridge through preload.js.

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  desktopCapturer,
  ipcMain,
  nativeImage,
  session,
  shell,
} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { initUpdater, installUpdate, updateState } = require('./updater');
const { startGameDetection, runningPrograms } = require('./games');
const { setOverlayMembers, setOverlayVisible } = require('./overlay');
const { startRpcServer } = require('./rpc');

// Installed builds talk to production; `npm run desktop` in the repo keeps using the local server.
const WEBAPP_URL = process.env.CONCORD_URL || (app.isPackaged ? 'https://concord.rafiweb.com.br' : 'http://localhost:3001');
const WEBAPP_ORIGIN = new URL(WEBAPP_URL).origin;
const SETTINGS_KEYS = new Set(['MINIMIZE_TO_TRAY', 'START_MINIMIZED', 'SHARE_ACTIVITY', 'OVERLAY']);

let mainWindow = null;
let splashWindow = null;
let tray = null;
let quitting = false;
let pendingScreenSource = null;
let gameActivity = null;
let editorActivity = null;
let rpcActivities = [];
let games = null;

/** Native Wayland session: screen capture goes through the desktop portal (PipeWire), with its own picker. */
function waylandCapture() {
  return process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland' && app.commandLine.getSwitchValue('ozone-platform') !== 'x11';
}
let settings = {};

// ---------- Settings (window bounds, tray behaviour) ----------

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    settings = {};
  }
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch (err) {
      console.error('Failed to save settings', err);
    }
  }, 300);
}

// ---------- Icons ----------
// icon.png (1024px) is the window/tray icon; electron-builder also turns it into the .ico/.icns/Linux sizes.

function circleIcon(size, [r, g, b]) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, radius - d));
      const i = (y * size + x) * 4;
      buf[i] = b; // BGRA
      buf[i + 1] = g;
      buf[i + 2] = r;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

let iconCache = null;
const appIcon = () => (iconCache ??= nativeImage.createFromPath(path.join(__dirname, 'icon.png')));
const badgeIcon = () => circleIcon(16, [236, 66, 69]);

// ---------- Activity ("Jogando …") and the voice overlay ----------

function currentActivities() {
  if (settings.SHARE_ACTIVITY === false) return [];
  // A Rich Presence plugin in the editor says more than its window title: keep only the plugin's.
  const editor = editorActivity && !rpcActivities.some((a) => a.name === editorActivity.name) ? editorActivity : null;
  return [gameActivity, editor, ...rpcActivities].filter(Boolean);
}

function pushActivity() {
  mainWindow?.webContents.send('activity:update', currentActivities());
  updateOverlay();
}

// Like Discord's, the overlay is for games: only while one is detected and Concord isn't in front.
function updateOverlay() {
  setOverlayVisible(settings.OVERLAY !== false && !!gameActivity && !mainWindow?.isFocused());
}

const customGames = () => (Array.isArray(settings.GAMES) ? settings.GAMES : []);

// ---------- Windows ----------

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 300,
    height: 340,
    frame: false,
    resizable: false,
    center: true,
    show: !settings.START_MINIMIZED,
    backgroundColor: '#1b1c20',
    icon: appIcon(),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function setSplashStatus(text) {
  splashWindow?.webContents
    .executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)})`)
    .catch(() => {});
}

function isOwnUrl(url) {
  try {
    return new URL(url).origin === WEBAPP_ORIGIN;
  } catch {
    return false;
  }
}

function createMainWindow() {
  const bounds = settings.WINDOW_BOUNDS || {};
  mainWindow = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 760,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 500,
    frame: false,
    show: false,
    backgroundColor: '#eceef2',
    icon: appIcon(),
    title: 'Concord',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false, // keep voice running while minimized
    },
  });

  let attempts = 0;
  const load = () => mainWindow.loadURL(WEBAPP_URL);
  mainWindow.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = aborted (navigation replaced)
    attempts++;
    setSplashStatus(`Servidor indisponível em ${WEBAPP_URL}. Tentativa ${attempts}…`);
    setTimeout(load, Math.min(1000 * attempts, 5000));
  });
  mainWindow.webContents.once('did-finish-load', () => {
    splashWindow?.close();
    if (settings.IS_MAXIMIZED) mainWindow.maximize();
    if (!settings.START_MINIMIZED) mainWindow.show();
  });
  load();

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isMaximized() || mainWindow.isMinimized()) return;
    settings.WINDOW_BOUNDS = mainWindow.getBounds();
    saveSettings();
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('maximize', () => {
    settings.IS_MAXIMIZED = true;
    saveSettings();
    mainWindow.webContents.send('window:maximized', true);
  });
  mainWindow.on('unmaximize', () => {
    settings.IS_MAXIMIZED = false;
    saveSettings();
    mainWindow.webContents.send('window:maximized', false);
  });
  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  mainWindow.on('close', (e) => {
    if (!quitting && settings.MINIMIZE_TO_TRAY !== false) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.on('focus', updateOverlay);
  mainWindow.on('blur', updateOverlay);

  // Links open in the system browser; the window never navigates away from the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!isOwnUrl(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });
}

function showMain() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const traySize = process.platform === 'linux' ? 24 : 16;
  tray = new Tray(appIcon().resize({ width: traySize, height: traySize, quality: 'best' }));
  tray.setToolTip('Concord');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir Concord', click: showMain },
      { type: 'separator' },
      {
        label: 'Sair do Concord',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('click', showMain);
}

// ---------- IPC bridge (see preload.js) ----------

function fromApp(event) {
  return isOwnUrl(event.senderFrame?.url ?? '');
}

function registerIpc() {
  ipcMain.on('window:minimize', (e) => fromApp(e) && mainWindow?.minimize());
  ipcMain.on('window:maximize', (e) => {
    if (!fromApp(e) || !mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', (e) => fromApp(e) && mainWindow?.close());
  ipcMain.handle('window:isMaximized', (e) => fromApp(e) && !!mainWindow?.isMaximized());

  ipcMain.on('notify', (e, opts) => {
    if (!fromApp(e) || !Notification.isSupported()) return;
    const n = new Notification({
      title: String(opts?.title ?? 'Concord').slice(0, 120),
      body: String(opts?.body ?? '').slice(0, 300),
      icon: appIcon(),
      silent: true, // the web app plays its own sound
    });
    n.on('click', () => {
      showMain();
      mainWindow?.webContents.send('notification:click', String(opts?.id ?? ''));
    });
    n.show();
  });

  ipcMain.on('badge', (e, count) => {
    if (!fromApp(e)) return;
    const n = Math.max(0, Number(count) || 0);
    app.setBadgeCount?.(n);
    if (process.platform === 'win32') mainWindow?.setOverlayIcon(n ? badgeIcon() : null, n ? `${n} não lidas` : '');
    tray?.setToolTip(n ? `Concord — ${n} menções não lidas` : 'Concord');
  });

  ipcMain.on('flash', (e) => {
    if (fromApp(e) && mainWindow && !mainWindow.isFocused()) mainWindow.flashFrame(true);
  });

  ipcMain.handle('settings:get', (e, key) => (fromApp(e) && SETTINGS_KEYS.has(key) ? settings[key] : undefined));
  ipcMain.handle('settings:set', (e, key, value) => {
    if (!fromApp(e) || !SETTINGS_KEYS.has(key)) return;
    settings[key] = !!value;
    saveSettings();
    if (key === 'SHARE_ACTIVITY' || key === 'OVERLAY') pushActivity();
  });

  ipcMain.handle('activity:get', (e) => (fromApp(e) ? currentActivities() : []));
  ipcMain.handle('activity:running', (e) => (fromApp(e) ? runningPrograms() : []));
  ipcMain.handle('games:list', (e) => (fromApp(e) ? customGames() : []));
  ipcMain.handle('games:add', (e, game) => {
    if (!fromApp(e)) return;
    const exe = String(game?.exe ?? '').trim().toLowerCase().slice(0, 128);
    const name = String(game?.name ?? '').trim().slice(0, 128);
    if (!exe || !name) return;
    settings.GAMES = [...customGames().filter((g) => g.exe !== exe), { exe, name }];
    saveSettings();
    games?.rescan();
  });
  ipcMain.handle('games:remove', (e, exe) => {
    if (!fromApp(e)) return;
    settings.GAMES = customGames().filter((g) => g.exe !== String(exe));
    saveSettings();
    games?.rescan();
  });
  ipcMain.on('overlay:update', (e, members) => fromApp(e) && setOverlayMembers(members));

  ipcMain.handle('screen:sources', async (e) => {
    // On Wayland every getSources() opens the system's own screen picker: skip ours (an empty list tells the
    // web app to start right away) so the user picks once, in the system dialog.
    if (!fromApp(e) || waylandCapture()) return [];
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }));
  });
  ipcMain.on('screen:select', (e, id) => {
    if (fromApp(e)) pendingScreenSource = String(id);
  });

  ipcMain.handle('update:state', (e) => (fromApp(e) ? updateState() : null));
  ipcMain.on('update:install', (e) => fromApp(e) && installUpdate());
}

function configureSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(isOwnUrl(wc.getURL()) && allowed.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => !!wc && isOwnUrl(wc.getURL()) && allowed.has(permission));

  // getDisplayMedia() in the renderer resolves to the source chosen in our picker (on Wayland, in the system's).
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = sources.find((s) => s.id === pendingScreenSource) ?? sources[0];
      pendingScreenSource = null;
      if (!chosen) return callback({});
      // Computer audio only exists on Windows; elsewhere the key must be left out (undefined is rejected).
      callback(process.platform === 'win32' ? { video: chosen, audio: 'loopback' } : { video: chosen });
    } catch (err) {
      console.warn('[screen] capture failed', err);
      callback({}); // rejects getDisplayMedia instead of leaving it pending forever
    }
  });
}

// ---------- Lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  // Must equal build.appId: the NSIS shortcut carries it, and a mismatch makes the taskbar fall back to the exe icon.
  app.setAppUserModelId('br.com.rafiweb.concord');

  app.whenReady().then(() => {
    loadSettings();
    configureSession();
    registerIpc();
    createSplash();
    createMainWindow();
    createTray();
    initUpdater({ origin: WEBAPP_ORIGIN, onState: (s) => mainWindow?.webContents.send('update:state', s) });
    games = startGameDetection(customGames, (kind, activity) => {
      if (kind === 'game') gameActivity = activity;
      else editorActivity = activity;
      pushActivity();
    });
    startRpcServer((activities) => {
      rpcActivities = activities;
      pushActivity();
    });
  });

  app.on('before-quit', () => (quitting = true));
  app.on('activate', showMain);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
