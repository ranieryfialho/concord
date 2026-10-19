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

const WEBAPP_URL = process.env.CONCORD_URL || 'http://localhost:3001';
const WEBAPP_ORIGIN = new URL(WEBAPP_URL).origin;
const SETTINGS_KEYS = new Set(['MINIMIZE_TO_TRAY', 'START_MINIMIZED']);

let mainWindow = null;
let splashWindow = null;
let tray = null;
let quitting = false;
let pendingScreenSource = null;
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

// ---------- Icons drawn at runtime (no binary assets in the repo) ----------

function circleIcon(size, [r, g, b], letter = false) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const radius = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, radius - d));
      let pr = r, pg = g, pb = b;
      if (letter) {
        // A ring that reads as a "C" at tray size.
        const ring = d > size * 0.2 && d < size * 0.33 && !(x > c && Math.abs(y - c) < size * 0.12);
        if (ring) pr = pg = pb = 255;
      }
      const i = (y * size + x) * 4;
      buf[i] = pb; // BGRA
      buf[i + 1] = pg;
      buf[i + 2] = pr;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

const appIcon = () => circleIcon(64, [109, 93, 252], true);
const badgeIcon = () => circleIcon(16, [236, 66, 69]);

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
  tray = new Tray(appIcon().resize({ width: 16, height: 16 }));
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
  });

  ipcMain.handle('screen:sources', async (e) => {
    if (!fromApp(e)) return [];
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    return sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
  });
  ipcMain.on('screen:select', (e, id) => {
    if (fromApp(e)) pendingScreenSource = String(id);
  });
}

function configureSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback) => callback(isOwnUrl(wc.getURL()) && allowed.has(permission)));
  ses.setPermissionCheckHandler((wc, permission) => !!wc && isOwnUrl(wc.getURL()) && allowed.has(permission));

  // getDisplayMedia() in the renderer resolves to the source chosen in our picker.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    const chosen = sources.find((s) => s.id === pendingScreenSource) ?? sources[0];
    pendingScreenSource = null;
    if (!chosen) return callback({});
    callback({ video: chosen, audio: process.platform === 'win32' ? 'loopback' : undefined });
  });
}

// ---------- Lifecycle ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.setAppUserModelId('app.concord.desktop');

  app.whenReady().then(() => {
    loadSettings();
    configureSession();
    registerIpc();
    createSplash();
    createMainWindow();
    createTray();
  });

  app.on('before-quit', () => (quitting = true));
  app.on('activate', showMain);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
