import { Gamepad2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ACTIVITY_VERB } from '../activity';
import { useStore } from '../store';
import type { Activity } from '../types';

const NONE: Activity[] = [];

export function useActivities(userId: string): Activity[] {
  return useStore(useShallow((s) => (s.presences[userId] && s.presences[userId] !== 'offline' ? (s.activities[userId] ?? NONE) : NONE)));
}

function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function Elapsed({ start, end }: { start?: number; end?: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (end) return <span className="activity-time">restam {clock(end - now)}</span>;
  if (!start) return null;
  return (
    <span className="activity-time">
      <Gamepad2 size={14} /> {clock(now - start)}
    </span>
  );
}

// "lang:ts" images (code editors, see desktop/games.js): a tile with the file type, in its usual color.
const LANG: Record<string, [string, string, string?]> = {
  ts: ['TS', '#3178c6'],
  tsx: ['TSX', '#3178c6'],
  mts: ['TS', '#3178c6'],
  js: ['JS', '#f0db4f', '#1b1c20'],
  jsx: ['JSX', '#f0db4f', '#1b1c20'],
  mjs: ['JS', '#f0db4f', '#1b1c20'],
  cjs: ['JS', '#f0db4f', '#1b1c20'],
  py: ['PY', '#3776ab'],
  json: ['{ }', '#5b5f6a'],
  md: ['MD', '#4b5563'],
  css: ['CSS', '#663399'],
  scss: ['SCSS', '#c6538c'],
  html: ['HTML', '#e34f26'],
  vue: ['VUE', '#41b883'],
  svelte: ['SV', '#ff3e00'],
  go: ['GO', '#00add8'],
  rs: ['RS', '#b7410e'],
  java: ['JAVA', '#e76f00'],
  kt: ['KT', '#7f52ff'],
  cs: ['C#', '#239120'],
  c: ['C', '#5c6bc0'],
  h: ['H', '#5c6bc0'],
  cpp: ['C++', '#00599c'],
  php: ['PHP', '#777bb4'],
  rb: ['RB', '#cc342d'],
  swift: ['SW', '#f05138'],
  dart: ['DART', '#0175c2'],
  sh: ['SH', '#2e3440'],
  ps1: ['PS', '#012456'],
  sql: ['SQL', '#e38c00'],
  yml: ['YML', '#cb171e'],
  yaml: ['YML', '#cb171e'],
};

function LangTile({ ext }: { ext: string }) {
  const [label, bg, fg = 'white'] = LANG[ext] ?? [ext.slice(0, 4).toUpperCase(), '#4b5563'];
  return (
    <span className="lang-tile" style={{ background: bg, color: fg, fontSize: label.length > 2 ? 15 : 22 }}>
      {label}
    </span>
  );
}

/** An app's image, falling back to a gamepad when the URL doesn't load. */
function Art({ src, title }: { src?: string; title?: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src?.startsWith('lang:')) return <LangTile ext={src.slice(5)} />;
  if (!src || broken) return <Gamepad2 size={32} />;
  return <img src={src} alt="" title={title} draggable={false} onError={() => setBroken(true)} />;
}

/** "Jogando" cards in the profile, like the screenshot of Code with file, workspace and timer. */
export function ActivityCards({ userId }: { userId: string }) {
  const activities = useActivities(userId);
  if (!activities.length) return null;
  return (
    <>
      {activities.map((a, i) => (
        <div key={`${a.application_id ?? a.name}-${i}`} className="activity-card">
          <h4>{ACTIVITY_VERB[a.type] ?? 'Jogando'}</h4>
          <div className="activity-body">
            <div className="activity-art" title={a.assets?.large_text}>
              <Art src={a.assets?.large_image} title={a.assets?.large_text} />
              {a.assets?.small_image && <img className="activity-small" src={a.assets.small_image} alt="" title={a.assets.small_text} draggable={false} />}
            </div>
            <div className="activity-text">
              <strong className="truncate">{a.name}</strong>
              {a.details && <span className="truncate">{a.details}</span>}
              {a.state && <span className="truncate">{a.state}</span>}
              <Elapsed start={a.timestamps?.start} end={a.timestamps?.end} />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

/** One line under a name in the member list: "Jogando Code". */
export function ActivityLine({ userId }: { userId: string }) {
  const first = useActivities(userId)[0];
  if (!first) return null;
  return (
    <span className="truncate small muted activity-line">
      {ACTIVITY_VERB[first.type] ?? 'Jogando'} <strong>{first.name}</strong>
    </span>
  );
}
