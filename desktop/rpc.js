// Rich Presence over local IPC: the protocol Discord's RPC SDKs speak, so apps built on them (e.g. the
// "Discord Rich Presence" extensions for VS Code) can show what you're doing in Concord too.
// A named pipe (Windows) or Unix socket called "discord-ipc-N"; each frame is
// [op: int32 LE][length: int32 LE][JSON]. We answer the handshake and SET_ACTIVITY, nothing else.
// SDKs connect to the first pipe that answers, starting at 0: while Discord itself runs it owns
// discord-ipc-0 and gets those apps; we take the next free number.

const { net: electronNet } = require('electron');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
const API = 'https://discord.com/api/v10';

function pipePath(i) {
  if (process.platform === 'win32') return `\\\\?\\pipe\\discord-ipc-${i}`;
  const dir = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || '/tmp';
  return path.join(dir, `discord-ipc-${i}`);
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data));
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

// ---------- Application name and images ----------
// Apps only send their client id and asset keys; the name ("Code") and the image URLs come from the
// application's public metadata.

const appCache = new Map();

async function getJson(url) {
  const res = await electronNet.fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function appInfo(clientId) {
  if (!/^\d{5,25}$/.test(clientId)) return Promise.resolve({ name: null, icon: null, assets: {} });
  if (!appCache.has(clientId)) {
    appCache.set(
      clientId,
      Promise.all([
        getJson(`${API}/applications/${clientId}/rpc`).catch(() => ({})),
        getJson(`${API}/oauth2/applications/${clientId}/assets`).catch(() => []),
      ]).then(([app, assets]) => ({
        name: typeof app.name === 'string' ? app.name : null,
        icon: typeof app.icon === 'string' ? app.icon : null,
        assets: Object.fromEntries((Array.isArray(assets) ? assets : []).map((a) => [a.name, a.id])),
      })),
    );
  }
  return appCache.get(clientId);
}

function imageUrl(clientId, key, assets) {
  if (typeof key !== 'string' || !key) return undefined;
  if (/^https:\/\//.test(key)) return key;
  if (key.startsWith('mp:')) return `https://media.discordapp.net/${key.slice(3)}`;
  const id = assets[key] ?? (/^\d+$/.test(key) ? key : null);
  return id ? `https://cdn.discordapp.com/app-assets/${clientId}/${id}.png` : undefined;
}

// SDKs send epoch milliseconds, some plugins seconds.
const ms = (t) => (typeof t === 'number' && t > 0 ? (t < 1e12 ? t * 1000 : t) : undefined);

async function toActivity(clientId, a) {
  const info = await appInfo(clientId);
  const assets = a.assets ?? {};
  const icon = info.icon ? `https://cdn.discordapp.com/app-icons/${clientId}/${info.icon}.png` : undefined;
  return {
    type: [0, 2, 3, 5].includes(a.type) ? a.type : 0,
    name: info.name || a.name || 'Aplicativo',
    details: a.details,
    state: a.state,
    application_id: clientId,
    timestamps: a.timestamps ? { start: ms(a.timestamps.start), end: ms(a.timestamps.end) } : undefined,
    assets: {
      large_image: imageUrl(clientId, assets.large_image, info.assets) ?? icon,
      large_text: assets.large_text,
      small_image: imageUrl(clientId, assets.small_image, info.assets),
      small_text: assets.small_text,
    },
  };
}

// ---------- Server ----------

const READY_USER = { id: '0', username: 'concord', discriminator: '0', global_name: 'Concord', avatar: null, bot: false, flags: 0, premium_type: 0 };

/** Starts listening; onChange(activities[]) fires whenever a connected app sets or clears its activity. */
function startRpcServer(onChange) {
  const bySocket = new Map();
  const emit = () => onChange([...bySocket.values()].filter(Boolean));

  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    let clientId = '';
    const reply = (op, data) => socket.writable && socket.write(encode(op, data));

    async function handle(op, msg) {
      if (op === OP.PING) return reply(OP.PONG, msg);
      if (op === OP.CLOSE) return socket.end();
      if (op === OP.HANDSHAKE) {
        clientId = String(msg?.client_id ?? '');
        return reply(OP.FRAME, {
          cmd: 'DISPATCH',
          evt: 'READY',
          data: { v: 1, config: { cdn_host: 'cdn.discordapp.com', api_endpoint: '//discord.com/api', environment: 'production' }, user: READY_USER },
          nonce: null,
        });
      }
      if (op !== OP.FRAME || !msg) return;
      if (msg.cmd === 'SET_ACTIVITY') {
        const a = msg.args?.activity;
        const activity = a ? await toActivity(clientId, a) : null;
        bySocket.set(socket, activity);
        emit();
        return reply(OP.FRAME, { cmd: 'SET_ACTIVITY', evt: null, data: activity, nonce: msg.nonce });
      }
      reply(OP.FRAME, { cmd: msg.cmd, evt: 'ERROR', data: { code: 4000, message: `O Concord não suporta ${msg.cmd}` }, nonce: msg.nonce });
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (len < 0 || len > 64 * 1024) return socket.destroy();
        if (buf.length < 8 + len) break;
        let msg = null;
        try {
          msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
        } catch {
          /* ignore malformed frame */
        }
        buf = buf.subarray(8 + len);
        handle(op, msg).catch((err) => console.warn('[rpc]', err));
      }
    });
    const drop = () => {
      if (bySocket.delete(socket)) emit();
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  const tryListen = (i) => {
    if (i > 9) return console.warn('[rpc] no free discord-ipc pipe');
    const p = pipePath(i);
    server.once('error', (err) => {
      server.removeAllListeners('listening');
      if (err.code !== 'EADDRINUSE') return console.warn('[rpc]', err);
      if (process.platform === 'win32') return tryListen(i + 1);
      // A Unix socket file can be left behind by a crashed app: reuse it if nobody answers.
      const probe = net.connect(p);
      probe.once('connect', () => {
        probe.destroy();
        tryListen(i + 1);
      });
      probe.once('error', () => {
        fs.rmSync(p, { force: true });
        tryListen(i);
      });
    });
    server.listen(p, () => {
      server.removeAllListeners('error');
      server.on('error', (err) => console.warn('[rpc]', err));
      console.log('[rpc] listening on', p);
    });
  };
  tryListen(0);

  return () => server.close();
}

module.exports = { startRpcServer };
