import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { connections } from './realtime.js';

// Which web-client build this server is serving. Vite writes client/dist/version.json on every build
// (see client/vite.config.ts). Clients compare it with the build they are running: READY carries it on
// connect, and APP_UPDATE is pushed when the files change under a running server (a deploy that swaps
// client/dist without restarting). Either way the client offers a "restart to update" button.

export const CLIENT_DIST = path.resolve(import.meta.dirname, '..', '..', 'client', 'dist');
const VERSION_FILE = path.join(CLIENT_DIST, 'version.json');

function readBuild(): string | null {
  try {
    const build = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))?.build;
    return typeof build === 'string' ? build : null;
  } catch {
    return null;
  }
}

let current = readBuild();

export function clientBuild(): string | null {
  return current;
}

setInterval(() => {
  const next = readBuild();
  if (!next || next === current) return;
  current = next;
  const payload = JSON.stringify({ op: 'dispatch', t: 'APP_UPDATE', d: { build: next } });
  for (const conns of connections.values()) {
    for (const conn of conns) if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(payload);
  }
}, 30_000).unref();
