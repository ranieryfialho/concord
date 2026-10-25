// Voice overlay: who is in your voice channel and who is talking, drawn over the game in the corner of
// the screen. A transparent, click-through, always-on-top window (works over windowed and borderless
// games; exclusive fullscreen covers it). The web app feeds it via preload "overlay.update".

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

const WIDTH = 260;
const ROW = 34;
const MARGIN = 16;

let win = null;
let members = [];
let visible = false;

function render() {
  if (!win || win.webContents.isLoading()) return;
  win.webContents.executeJavaScript(`window.render(${JSON.stringify(members)})`).catch(() => {});
  const { x, y } = screen.getPrimaryDisplay().workArea;
  win.setBounds({ x: x + MARGIN, y: y + MARGIN, width: WIDTH, height: Math.max(1, members.length) * ROW + 12 });
}

function create() {
  win = new BrowserWindow({
    width: WIDTH,
    height: ROW,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'overlay.html'));
  win.webContents.on('did-finish-load', render);
  win.on('closed', () => (win = null));
}

function sync() {
  const show = visible && members.length > 0;
  if (show && !win) create();
  if (!win) return;
  render();
  if (show && !win.isVisible()) win.showInactive();
  if (!show && win.isVisible()) win.hide();
}

/** [{ id, name, avatar, speaking, mute, deaf }] of the voice channel you're in (empty when not in one). */
function setOverlayMembers(list) {
  members = (Array.isArray(list) ? list.slice(0, 12) : []).map((m) => ({
    name: String(m?.name ?? '').slice(0, 64),
    avatar: typeof m?.avatar === 'string' && /^(https?:|data:image\/)/.test(m.avatar) ? m.avatar : '',
    color: typeof m?.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(m.color) ? m.color : '',
    speaking: !!m?.speaking,
    mute: !!m?.mute,
    deaf: !!m?.deaf,
  }));
  sync();
}

function setOverlayVisible(v) {
  visible = !!v;
  sync();
}

module.exports = { setOverlayMembers, setOverlayVisible };
