// "Jogando X": every few seconds, match running processes against a list of known games plus the
// programs the user registered in Configurações → Atividade, and code editors (file and workspace
// from the window title). Icons come from the executables.

const { app } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SCAN_EVERY_MS = 15_000;

// Executable names (any OS; matched case-insensitively against the process's file name).
const KNOWN_GAMES = [
  ['League of Legends', ['league of legends.exe', 'league of legends']],
  ['VALORANT', ['valorant-win64-shipping.exe']],
  ['Counter-Strike 2', ['cs2.exe', 'cs2']],
  ['Dota 2', ['dota2.exe', 'dota2']],
  ['Fortnite', ['fortniteclient-win64-shipping.exe']],
  ['Grand Theft Auto V', ['gta5.exe', 'gta5_enhanced.exe']],
  ['Red Dead Redemption 2', ['rdr2.exe']],
  ['Rocket League', ['rocketleague.exe']],
  ['Apex Legends', ['r5apex.exe', 'r5apex_dx12.exe']],
  ['Overwatch 2', ['overwatch.exe']],
  ['Roblox', ['robloxplayerbeta.exe', 'robloxplayer']],
  ['Minecraft', ['minecraft.windows.exe', 'minecraftlauncher.exe']],
  ['ELDEN RING', ['eldenring.exe']],
  ["Baldur's Gate 3", ['bg3.exe', 'bg3_dx11.exe']],
  ['Cyberpunk 2077', ['cyberpunk2077.exe']],
  ['The Witcher 3', ['witcher3.exe']],
  ['Rainbow Six Siege', ['rainbowsix.exe', 'rainbowsix_vulkan.exe']],
  ['PUBG: BATTLEGROUNDS', ['tslgame.exe']],
  ['Dead by Daylight', ['deadbydaylight-win64-shipping.exe']],
  ['Rust', ['rustclient.exe']],
  ['Terraria', ['terraria.exe', 'terraria']],
  ['Stardew Valley', ['stardew valley.exe', 'stardewvalley', 'stardew valley']],
  ['Among Us', ['among us.exe']],
  ['Hollow Knight', ['hollow_knight.exe', 'hollow_knight.x86_64']],
  ['Palworld', ['palworld-win64-shipping.exe']],
  ['HELLDIVERS 2', ['helldivers2.exe']],
  ['Marvel Rivals', ['marvel-win64-shipping.exe']],
  ['World of Warcraft', ['wow.exe', 'world of warcraft']],
  ['Hearthstone', ['hearthstone.exe', 'hearthstone']],
  ['Diablo IV', ['diablo iv.exe']],
  ['Genshin Impact', ['genshinimpact.exe']],
  ['Honkai: Star Rail', ['starrail.exe']],
  ['Lethal Company', ['lethal company.exe']],
  ['Sea of Thieves', ['sotgame.exe']],
  ['Destiny 2', ['destiny2.exe']],
  ['Warframe', ['warframe.x64.exe']],
  ['Fall Guys', ['fallguys_client_game.exe']],
  ['Phasmophobia', ['phasmophobia.exe']],
  ['Valheim', ['valheim.exe', 'valheim.x86_64']],
  ['The Sims 4', ['ts4_x64.exe', 'the sims 4']],
  ['Black Myth: Wukong', ['b1-win64-shipping.exe']],
  ['Monster Hunter Wilds', ['monsterhunterwilds.exe']],
  ['Path of Exile 2', ['pathofexile.exe', 'pathofexile_x64.exe', 'pathofexilesteam.exe']],
  ['The Last of Us Part I', ['tlou-i.exe', 'tlou-i-l.exe']],
  ['Euro Truck Simulator 2', ['eurotrucks2.exe', 'eurotrucks2']],
  ['EA SPORTS FC 25', ['fc25.exe']],
  ['Brawlhalla', ['brawlhalla.exe']],
  ['osu!', ['osu!.exe']],
];

const known = new Map();
for (const [name, exes] of KNOWN_GAMES) for (const exe of exes) known.set(exe, name);

const run = (file, args) =>
  new Promise((resolve) => execFile(file, args, { windowsHide: true, maxBuffer: 16 << 20 }, (err, out) => resolve(err ? '' : out)));

function csvRow(line) {
  return [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
}

/** Running processes: { exe (lower-case file name), pid, path?, title? }. */
async function processes({ withTitles = false } = {}) {
  if (process.platform === 'win32') {
    const out = await run('tasklist', withTitles ? ['/v', '/fo', 'csv', '/nh'] : ['/fo', 'csv', '/nh']);
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const c = csvRow(line);
        // No window: "N/A", or localized ("N/D" in pt-BR).
        const title = withTitles && c[8] && !/^N\/.$/.test(c[8]) ? c[8] : undefined;
        return { exe: (c[0] ?? '').toLowerCase(), name: c[0], pid: Number(c[1]), title };
      });
  }
  if (process.platform === 'darwin') {
    const out = await run('ps', ['-axo', 'pid=,comm=']);
    return out
      .split('\n')
      .map((l) => /^\s*(\d+)\s+(.+)$/.exec(l))
      .filter(Boolean)
      .map(([, pid, p]) => ({ exe: path.basename(p).toLowerCase(), name: path.basename(p), pid: Number(pid), path: p }));
  }
  // Linux: the executable, or argv[0] for games run through Wine/Proton ("Z:\…\Game.exe").
  const list = [];
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      const argv0 = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')[0];
      if (!argv0) continue;
      const base = argv0.split(/[\\/]/).pop();
      let exePath;
      try {
        exePath = fs.readlinkSync(`/proc/${pid}/exe`);
      } catch {
        /* not ours */
      }
      list.push({ exe: base.toLowerCase(), name: base, pid: Number(pid), path: exePath });
    } catch {
      /* exited meanwhile */
    }
  }
  return list;
}

async function exePath(proc) {
  if (proc.path) return proc.path;
  if (process.platform !== 'win32') return null;
  const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${proc.pid}).Path`]);
  return out.trim() || null;
}

async function iconOf(proc) {
  try {
    let p = await exePath(proc);
    if (!p) return undefined;
    if (process.platform === 'darwin') p = p.replace(/(\.app)\/.*$/, '$1'); // the bundle carries the icon
    const img = await app.getFileIcon(p, { size: 'large' });
    return img.isEmpty() ? undefined : img.resize({ width: 32, height: 32, quality: 'best' }).toDataURL();
  } catch {
    return undefined;
  }
}

// Code editors, recognized without any plugin (Rich Presence plugins talk to Discord whenever it is
// open): the window title says which file and workspace are open.
const EDITORS = [
  { name: 'Visual Studio Code', exes: ['code.exe', 'code'], bundle: 'Visual Studio Code.app' },
  { name: 'Cursor', exes: ['cursor.exe', 'cursor'], bundle: 'Cursor.app' },
  { name: 'Windsurf', exes: ['windsurf.exe', 'windsurf'], bundle: 'Windsurf.app' },
  { name: 'Antigravity', exes: ['antigravity.exe', 'antigravity'], bundle: 'Antigravity.app' },
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Titles of open windows: on Windows those of one program, on Linux all of them (needs wmctrl). */
async function windowTitles(proc) {
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/v', '/fo', 'csv', '/nh', '/fi', `IMAGENAME eq ${proc.name}`]);
    return out
      .split(/\r?\n/)
      .map((l) => csvRow(l)[8])
      .filter((t) => t && !/^N\/.$/.test(t));
  }
  if (process.platform === 'linux') {
    const out = await run('wmctrl', ['-l']);
    return out.split('\n').map((l) => l.split(/\s+/).slice(3).join(' ')).filter(Boolean);
  }
  return [];
}

/** "● voice.ts - concord - Visual Studio Code" → { file: 'voice.ts', workspace: 'concord' }. */
function parseEditorTitle(title, appName) {
  const suffix = new RegExp(`\\s[-—]\\s${escapeRe(appName)}(\\s\\[.*\\])?$`);
  if (!suffix.test(title)) return null;
  const parts = title.replace(suffix, '').replace(/^[●•]\s*/, '').split(/\s[-—]\s/);
  if (parts.length >= 2) return { file: parts[0], workspace: parts[1] };
  return /\.\w+$/.test(parts[0]) ? { file: parts[0] } : { workspace: parts[0] };
}

async function editorActivity(editor, proc, since, icon) {
  const titles = await windowTitles(proc);
  const info = titles.map((t) => parseEditorTitle(t, editor.name)).find(Boolean) ?? {};
  // Like the Rich Presence plugins: the file's language as the big image, the editor in the corner.
  const ext = /\.([a-z0-9]{1,10})$/i.exec(info.file ?? '')?.[1]?.toLowerCase();
  return {
    type: 0,
    name: editor.name,
    details: info.workspace ? `No ${info.workspace}` : undefined,
    state: info.file ? `Editando ${info.file}` : undefined,
    timestamps: { start: since },
    assets: ext
      ? { large_image: `lang:${ext}`, large_text: info.file, small_image: icon, small_text: editor.name }
      : { large_image: icon, large_text: editor.name },
  };
}

/**
 * Polls for a running game and code editor. getCustom() returns the user's registered programs
 * ([{ exe, name }]); onChange(kind, activity | null) fires when the "game" or "editor" activity changes.
 */
function startGameDetection(getCustom, onChange) {
  let current = null; // { exe, activity }
  let editor = null; // { exe, since, icon, json }

  async function scanGame(procs) {
    const custom = new Map(getCustom().map((g) => [g.exe.toLowerCase(), g.name]));
    const hit = procs.find((p) => custom.has(p.exe) || known.has(p.exe));
    if (!hit) {
      if (current) onChange('game', (current = null));
      return;
    }
    if (current?.exe === hit.exe) return;
    const name = custom.get(hit.exe) ?? known.get(hit.exe);
    current = { exe: hit.exe, activity: { type: 0, name, timestamps: { start: Date.now() } } };
    onChange('game', current.activity);
    const icon = await iconOf(hit);
    if (icon && current?.exe === hit.exe) {
      current.activity = { ...current.activity, assets: { large_image: icon } };
      onChange('game', current.activity);
    }
  }

  async function scanEditor(procs) {
    let def = null;
    const hit = procs.find((p) => (def = EDITORS.find((e) => e.exes.includes(p.exe) || p.path?.includes(`/${e.bundle}/`))));
    if (!hit) {
      if (editor) onChange('editor', (editor = null));
      return;
    }
    if (editor?.exe !== hit.exe) editor = { exe: hit.exe, since: Date.now(), icon: await iconOf(hit), json: '' };
    const activity = await editorActivity(def, hit, editor.since, editor.icon);
    const json = JSON.stringify(activity);
    if (json !== editor.json) {
      editor.json = json;
      onChange('editor', activity);
    }
  }

  async function scan() {
    const procs = await processes();
    await scanGame(procs);
    await scanEditor(procs);
  }
  const tick = () => scan().catch((err) => console.warn('[games]', err));
  tick();
  const timer = setInterval(tick, SCAN_EVERY_MS);
  return { rescan: tick, stop: () => clearInterval(timer) };
}

const IGNORED = new Set(['explorer.exe', 'concord.exe', 'electron.exe', 'textinputhost.exe', 'applicationframehost.exe', 'systemsettings.exe', 'shellexperiencehost.exe', 'searchhost.exe', 'startmenuexperiencehost.exe']);

/** Programs with a window (Windows) or any process (elsewhere), for "Adicionar jogo". */
async function runningPrograms() {
  const procs = await processes({ withTitles: true });
  const seen = new Map();
  for (const p of procs) {
    if (!p.exe || IGNORED.has(p.exe) || seen.has(p.exe)) continue;
    if (process.platform === 'win32' && !p.title) continue;
    if (process.platform !== 'win32' && !p.path?.includes('/Applications/') && !p.path?.includes('/home/')) continue;
    seen.set(p.exe, { exe: p.exe, name: p.title || p.name.replace(/\.exe$/i, ''), known: known.get(p.exe) ?? null });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { startGameDetection, runningPrograms };
