// System audio for screen sharing on Linux (PulseAudio / PipeWire via pipewire-pulse).
// Electron has no loopback capture there, so while a share is live we build this graph:
//
//   other apps ─► concord_share (null sink) ─┬─► loopback ─► real output (you still hear everything)
//                                            └─► concord_share_src (remap source, what the web app captures)
//   Concord's own output ───────────────────────► real output (kept out, so the call's voices aren't re-sent)
//
// Everything is undone by stop(), on quit, and swept at the next start if the app crashed.

const { app } = require('electron');
const { execFile, execFileSync, spawn } = require('node:child_process');

const SINK = 'concord_share';
const SOURCE = 'concord_share_src';
const SOURCE_LABEL = 'ConcordShareSource';

let state = null; // { realSink, modules: number[], watcher, timer }

const pactl = (...args) =>
  new Promise((resolve, reject) =>
    execFile('pactl', args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))),
  );

function ownPids() {
  const pids = new Set([process.pid]);
  for (const m of app.getAppMetrics()) pids.add(m.pid);
  return pids;
}

async function sinkInputs() {
  try {
    return JSON.parse(await pactl('--format=json', 'list', 'sink-inputs'));
  } catch {
    return [];
  }
}

/** Keeps Concord's streams on the real output and everyone else's on the capture sink. */
async function route() {
  if (!state) return;
  const own = ownPids();
  const captureSink = await pactl('list', 'short', 'sinks').then((t) => t.split('\n').find((l) => l.split('\t')[1] === SINK)?.split('\t')[0]);
  if (!captureSink) return;
  for (const input of await sinkInputs()) {
    if (input.properties?.['module-stream-restore.id'] === 'sink-input-by-media-role:filter') continue;
    if (input.owner_module != null && state.modules.includes(Number(input.owner_module))) continue; // our loopback
    const pid = Number(input.properties?.['application.process.id']);
    const mine = own.has(pid);
    const onCapture = String(input.sink) === String(captureSink);
    try {
      if (mine && onCapture) await pactl('move-sink-input', String(input.index), state.realSink);
      else if (!mine && !onCapture) await pactl('move-sink-input', String(input.index), SINK);
    } catch {
      /* the stream ended meanwhile */
    }
  }
}

/** Unloads leftovers from a previous run that never got to clean up. */
async function sweep() {
  try {
    const modules = (await pactl('list', 'short', 'modules')).split('\n');
    for (const line of modules) {
      const [id, , args = ''] = line.split('\t');
      if (args.includes(SINK) || args.includes(SOURCE)) await pactl('unload-module', id).catch(() => {});
    }
  } catch {
    /* no pactl */
  }
}

async function start() {
  if (process.platform !== 'linux') return { ok: false };
  if (state) return { ok: true, label: SOURCE_LABEL };
  try {
    await sweep();
    const realSink = await pactl('get-default-sink');
    const modules = [];
    state = { realSink, modules, watcher: null, timer: null };
    modules.push(Number(await pactl('load-module', 'module-null-sink', `sink_name=${SINK}`, 'sink_properties=device.description=ConcordShare')));
    modules.push(
      Number(await pactl('load-module', 'module-remap-source', `master=${SINK}.monitor`, `source_name=${SOURCE}`, `source_properties=device.description=${SOURCE_LABEL}`)),
    );
    modules.push(
      Number(await pactl('load-module', 'module-loopback', `source=${SINK}.monitor`, `sink=${realSink}`, 'latency_msec=30', 'source_dont_move=true', 'sink_dont_move=true')),
    );
    await pactl('set-default-sink', SINK);
    await route();
    // New streams (a voice joining the call, a new tab playing) are routed as they appear.
    const watcher = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] });
    watcher.stdout.on('data', (chunk) => {
      if (!/'new' on sink-input/.test(String(chunk))) return;
      clearTimeout(state?.timer);
      if (state) state.timer = setTimeout(() => void route(), 60);
    });
    watcher.on('error', () => {});
    state.watcher = watcher;
    return { ok: true, label: SOURCE_LABEL };
  } catch (err) {
    console.warn('[linux-audio] start failed', err);
    await stop();
    return { ok: false };
  }
}

async function stop() {
  const s = state;
  if (!s) return;
  state = null;
  clearTimeout(s.timer);
  s.watcher?.kill();
  try {
    if ((await pactl('get-default-sink')) === SINK) await pactl('set-default-sink', s.realSink);
    for (const input of await sinkInputs()) {
      if (input.owner_module != null && s.modules.includes(Number(input.owner_module))) continue;
      await pactl('move-sink-input', String(input.index), s.realSink).catch(() => {});
    }
  } catch {
    /* ignore */
  }
  for (const id of [...s.modules].reverse()) await pactl('unload-module', String(id)).catch(() => {});
}

/** Synchronous variant for the quit path. */
function stopSync() {
  const s = state;
  if (!s) return;
  state = null;
  s.watcher?.kill();
  try {
    execFileSync('pactl', ['set-default-sink', s.realSink], { timeout: 3000 });
    const inputs = JSON.parse(execFileSync('pactl', ['--format=json', 'list', 'sink-inputs'], { timeout: 3000 }).toString());
    for (const i of inputs) {
      if (i.owner_module != null && s.modules.includes(Number(i.owner_module))) continue;
      try { execFileSync('pactl', ['move-sink-input', String(i.index), s.realSink], { timeout: 3000 }); } catch {}
    }
  } catch {}
  for (const id of [...s.modules].reverse()) {
    try { execFileSync('pactl', ['unload-module', String(id)], { timeout: 3000 }); } catch {}
  }
}

module.exports = { start, stop, stopSync };
