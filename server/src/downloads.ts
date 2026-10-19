import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';

// Desktop installers are published by .github/workflows/desktop.yml into DOWNLOADS_DIR.
// File names follow `Concord-<version>-<os>-<arch>.<ext>` (see desktop/package.json "artifactName");
// electron-builder spells the Linux arch x86_64 (AppImage) and amd64 (deb).
export const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR ?? '/downloads');

const FILE = /^Concord-(\d+\.\d+\.\d+)-(win|mac|linux)-(x64|arm64|x86_64|amd64)\.(exe|dmg|AppImage|deb)$/;
const OS_LABEL = { win: 'Windows', mac: 'macOS', linux: 'Linux' } as const;
const OS_ORDER = ['win', 'mac', 'linux'] as const;
const ARCH_LABEL = { x64: 'Intel / 64-bit', x86_64: '64-bit', amd64: '64-bit (Debian/Ubuntu)', arm64: 'Apple Silicon / ARM64' } as const;

type Build = { name: string; version: string; os: keyof typeof OS_LABEL; arch: keyof typeof ARCH_LABEL; ext: string; size: number };

const versionKey = (v: string) => v.split('.').reduce((n, p) => n * 1000 + Number(p), 0);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const formatSize = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(0)} MB`;

/** Newest build per (os, arch, ext). */
function latestBuilds(): Build[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(DOWNLOADS_DIR);
  } catch {
    return [];
  }
  const best = new Map<string, Build>();
  for (const name of names) {
    const m = FILE.exec(name);
    if (!m) continue;
    const [, version, os, arch, ext] = m as unknown as [string, string, Build['os'], Build['arch'], string];
    const key = `${os}/${arch}/${ext}`;
    const current = best.get(key);
    if (current && versionKey(current.version) >= versionKey(version)) continue;
    best.set(key, { name, version, os, arch, ext, size: fs.statSync(path.join(DOWNLOADS_DIR, name)).size });
  }
  return [...best.values()].sort(
    (a, b) => OS_ORDER.indexOf(a.os) - OS_ORDER.indexOf(b.os) || a.arch.localeCompare(b.arch) || a.ext.localeCompare(b.ext),
  );
}

function page(builds: Build[]): string {
  const sections = OS_ORDER.map((os) => {
    const items = builds.filter((b) => b.os === os);
    if (!items.length) return '';
    const rows = items
      .map(
        (b) =>
          `<a class="dl" href="/downloads/${encodeURIComponent(b.name)}" download>` +
          `<span><strong>${esc(b.ext === 'AppImage' ? 'AppImage' : `.${b.ext}`)}</strong> · ${ARCH_LABEL[b.arch]}</span>` +
          `<span class="meta">v${esc(b.version)} · ${formatSize(b.size)}</span></a>`,
      )
      .join('');
    return `<section><h2>${OS_LABEL[os]}</h2>${rows}</section>`;
  }).join('');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Baixar o Concord</title>
<style>
:root{color-scheme:light dark;--bg:#eceef2;--card:#fff;--text:#1d2230;--muted:#667085;--accent:#5865f2;--line:#d9dde5}
@media(prefers-color-scheme:dark){:root{--bg:#1b1d24;--card:#262932;--text:#eceef4;--muted:#9aa1b2;--line:#363a46}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
main{max-width:560px;margin:0 auto;padding:48px 16px}
h1{font-size:28px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 28px}
section{background:var(--card);border-radius:12px;padding:16px;margin-bottom:16px}
h2{font-size:16px;margin:0 0 8px}
.dl{display:flex;justify-content:space-between;gap:12px;padding:10px 12px;border-radius:8px;color:inherit;text-decoration:none;border:1px solid var(--line);margin-top:8px}
.dl:hover{border-color:var(--accent)}.meta{color:var(--muted);font-size:14px;white-space:nowrap}
.note{color:var(--muted);font-size:14px}a.back{color:var(--accent)}
</style></head><body><main>
<h1>Baixar o Concord</h1>
<p class="sub">Aplicativo para desktop. Prefere o navegador? <a class="back" href="/">Abra o Concord na web</a>.</p>
${sections || '<section><p>Nenhuma versão publicada ainda.</p></section>'}
<p class="note">O instalador ainda não é assinado: o Windows (SmartScreen) e o macOS (Gatekeeper) podem avisar sobre "desenvolvedor desconhecido".
No Windows, clique em "Mais informações" → "Executar assim mesmo". No macOS, clique com o botão direito no app → "Abrir".
No Linux, torne o AppImage executável (<code>chmod +x</code>).</p>
</main></body></html>`;
}

export const downloadsRouter = Router();

downloadsRouter.get('/download', (_req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'");
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(page(latestBuilds()));
});

// Only files matching the installer naming scheme are served.
downloadsRouter.use(
  '/downloads',
  (req, res, next) => (FILE.test(decodeURIComponent(req.path.slice(1))) ? next() : res.status(404).end()),
  express.static(DOWNLOADS_DIR, {
    index: false,
    setHeaders(res) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Disposition', 'attachment');
    },
  }),
);
