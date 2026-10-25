// "Jogando X": every few seconds, match running processes against a list of known games plus the
// programs the user registered in Configurações → Atividade. The game's icon comes from its executable.

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

/**
 * Polls for a running game. getCustom() returns the user's registered programs ([{ exe, name }]);
 * onChange(activity | null) fires when the detected game changes.
 */
function startGameDetection(getCustom, onChange) {
  let current = null; // { exe, activity }
  async function scan() {
    const custom = new Map(getCustom().map((g) => [g.exe.toLowerCase(), g.name]));
    const procs = await processes();
    const hit = procs.find((p) => custom.has(p.exe) || known.has(p.exe));
    if (!hit) {
      if (current) onChange((current = null));
      return;
    }
    if (current?.exe === hit.exe) return;
    const name = custom.get(hit.exe) ?? known.get(hit.exe);
    current = { exe: hit.exe, activity: { type: 0, name, timestamps: { start: Date.now() } } };
    onChange(current.activity);
    const icon = await iconOf(hit);
    if (icon && current?.exe === hit.exe) {
      current.activity = { ...current.activity, assets: { large_image: icon } };
      onChange(current.activity);
    }
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
