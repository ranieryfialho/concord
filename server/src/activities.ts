// What people are doing right now ("Jogando Code", a game, …), reported by the desktop app: games it
// detects among running processes and apps that talk to it over the Rich Presence IPC (desktop/rpc.js).
// Kept in memory per connection and dropped when that connection closes. Shown only while the user is
// visible (see presenceOf).

export const ACTIVITY_TYPES = new Set([0, 2, 3, 5]); // playing, listening, watching, competing

export interface Activity {
  type: number;
  name: string;
  details?: string;
  state?: string;
  application_id?: string;
  timestamps?: { start?: number; end?: number };
  assets?: { large_image?: string; large_text?: string; small_image?: string; small_text?: string };
}

const MAX_ACTIVITIES = 3;
const MAX_DATA_IMAGE = 24_000; // a 32–64px icon extracted from a game's executable

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().slice(0, max);
  return s || undefined;
}

function image(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  if (/^https:\/\/[^\s"'<>]+$/.test(v) && v.length <= 512) return v;
  if (/^lang:[a-z0-9]{1,10}$/.test(v)) return v; // drawn by the client: a file-type tile ("TS")
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= MAX_DATA_IMAGE) return v;
  return undefined;
}

function time(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}

function compact<T extends object>(o: T): T | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

export function sanitizeActivities(raw: unknown): Activity[] {
  if (!Array.isArray(raw)) return [];
  const out: Activity[] = [];
  for (const a of raw.slice(0, MAX_ACTIVITIES)) {
    if (!a || typeof a !== 'object') continue;
    const r = a as Record<string, unknown>;
    const name = str(r.name, 128);
    if (!name) continue;
    const ts = (r.timestamps ?? {}) as Record<string, unknown>;
    const as = (r.assets ?? {}) as Record<string, unknown>;
    out.push(
      compact({
        type: ACTIVITY_TYPES.has(r.type as number) ? (r.type as number) : 0,
        name,
        details: str(r.details, 128),
        state: str(r.state, 128),
        application_id: str(r.application_id, 32),
        timestamps: compact({ start: time(ts.start), end: time(ts.end) }),
        assets: compact({
          large_image: image(as.large_image),
          large_text: str(as.large_text, 128),
          small_image: image(as.small_image),
          small_text: str(as.small_text, 128),
        }),
      })!,
    );
  }
  return out;
}
