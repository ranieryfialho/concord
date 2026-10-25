// Exposes window.ConcordNative to the web app (typed in client/src/native.ts).
// Runs sandboxed: only 'electron' is requireable here.

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_event, value) => cb(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('ConcordNative', {
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizeChange: (cb) => subscribe('window:maximized', cb),
  },
  notify: (opts) => ipcRenderer.send('notify', { title: String(opts.title), body: String(opts.body), id: String(opts.id ?? '') }),
  onNotificationClick: (cb) => subscribe('notification:click', cb),
  setBadge: (count) => ipcRenderer.send('badge', Number(count) || 0),
  flashFrame: () => ipcRenderer.send('flash'),
  screen: {
    getSources: () => ipcRenderer.invoke('screen:sources'),
    select: (id) => ipcRenderer.send('screen:select', String(id)),
  },
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', String(key)),
    set: (key, value) => ipcRenderer.invoke('settings:set', String(key), value),
  },
  activity: {
    get: () => ipcRenderer.invoke('activity:get'),
    onChange: (cb) => subscribe('activity:update', cb),
    runningPrograms: () => ipcRenderer.invoke('activity:running'),
    games: {
      list: () => ipcRenderer.invoke('games:list'),
      add: (game) => ipcRenderer.invoke('games:add', { exe: String(game.exe), name: String(game.name) }),
      remove: (exe) => ipcRenderer.invoke('games:remove', String(exe)),
    },
  },
  overlay: {
    update: (members) => ipcRenderer.send('overlay:update', members),
  },
  updates: {
    getState: () => ipcRenderer.invoke('update:state'),
    onState: (cb) => subscribe('update:state', cb),
    install: () => ipcRenderer.send('update:install'),
  },
});
