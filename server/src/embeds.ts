import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { q, tx } from './db.js';
import { type MessageRow, getMessage } from './models.js';
import { channelAudience, getChannel } from './permissions.js';
import { dispatch } from './realtime.js';

// Link previews are fetched server-side, so every request is guarded against SSRF:
// only http(s) on default ports, no private/loopback/link-local targets (checked on
// every DNS answer and every redirect hop), small bodies and short timeouts.

const ENABLED = process.env.CONCORD_EMBEDS !== '0';
const MAX_URLS = 3;
const MAX_BODY = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const CACHE_TTL = 60 * 60_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; ConcordBot/1.0; link preview)';

export interface Embed {
  type: 'link' | 'image';
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_url: string | null;
  color: string | null;
}

export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(addr)) {
    return addr === '::' || addr === '::1' || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(addr);
  }
  return true;
}

// Custom DNS lookup that refuses to connect to internal addresses.
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(new Error('blocked address'), '', 4);
    }
    if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

type Fetched = { kind: 'image'; url: string } | { kind: 'html'; url: string; html: string };

function fetchUrl(raw: string, depth = 0): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return reject(new Error('bad url'));
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return reject(new Error('bad protocol'));
    if (url.port && url.port !== '80' && url.port !== '443') return reject(new Error('bad port'));
    if (url.username || url.password) return reject(new Error('credentials in url'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isPrivateAddress(host)) return reject(new Error('blocked address'));

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,image/*;q=0.8,*/*;q=0.1',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (depth >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
          return resolve(fetchUrl(new URL(res.headers.location, url).toString(), depth + 1));
        }
        if (status !== 200) {
          res.resume();
          return reject(new Error(`status ${status}`));
        }
        const type = String(res.headers['content-type'] ?? '').toLowerCase();
        if (type.startsWith('image/') && !type.includes('svg')) {
          res.destroy();
          return resolve({ kind: 'image', url: url.toString() });
        }
        if (!type.includes('html')) {
          res.destroy();
          return reject(new Error('not html'));
        }
        const charset = /charset=([\w-]+)/.exec(type)?.[1] ?? 'utf-8';
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          let html: string;
          try {
            html = new TextDecoder(charset).decode(Buffer.concat(chunks));
          } catch {
            html = Buffer.concat(chunks).toString('utf8');
          }
          resolve({ kind: 'html', url: url.toString(), html });
        };
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          chunks.push(chunk);
          if (size >= MAX_BODY) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('close', finish);
        res.on('error', (e) => (done ? undefined : reject(e)));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function clean(s: string | undefined, max: number): string | null {
  if (!s) return null;
  const text = decodeEntities(s).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function absoluteHttps(raw: string | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()), base);
    if (u.protocol === 'http:') u.protocol = 'https:'; // the client only loads https images
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseHtml(html: string, url: string): Embed | null {
  const head = html.slice(0, MAX_BODY);
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      attrs.set(m[1].toLowerCase(), m[3] ?? m[4] ?? m[5] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name') ?? '').toLowerCase();
    const content = attrs.get('content');
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = clean(meta.get('og:title') ?? meta.get('twitter:title') ?? titleTag, 256);
  const description = clean(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description'), 350);
  const image = absoluteHttps(meta.get('og:image') ?? meta.get('og:image:url') ?? meta.get('twitter:image'), url);
  if (!title && !image) return null;
  const color = meta.get('theme-color');
  return {
    type: 'link',
    url,
    title,
    description,
    site_name: clean(meta.get('og:site_name'), 100) ?? new URL(url).hostname.replace(/^www\./, ''),
    image_url: image,
    color: color && /^#[0-9a-f]{3,8}$/i.test(color.trim()) ? color.trim() : null,
  };
}

const cache = new Map<string, { at: number; embed: Embed | null }>();

async function embedFor(url: string): Promise<Embed | null> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.embed;
  let embed: Embed | null = null;
  try {
    const result = await fetchUrl(url);
    embed =
      result.kind === 'image'
        ? { type: 'image', url, title: null, description: null, site_name: null, image_url: absoluteHttps(result.url, result.url), color: null }
        : parseHtml(result.html, result.url);
    if (embed?.type === 'image' && !embed.image_url) embed = null;
  } catch {
    embed = null;
  }
  if (cache.size > 1000) cache.delete(cache.keys().next().value!);
  cache.set(url, { at: Date.now(), embed });
  return embed;
}

/** URLs worth previewing: not inside code, not wrapped in <...> (Discord's "suppress embed" syntax). */
export function extractUrls(content: string): string[] {
  const stripped = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const urls: string[] = [];
  for (const m of stripped.matchAll(/(<)?(https?:\/\/[^\s<>]+[^\s<>.,:;"')\]!?])(>)?/g)) {
    if (m[1] && m[3]) continue;
    if (!urls.includes(m[2])) urls.push(m[2]);
    if (urls.length >= MAX_URLS) break;
  }
  return urls;
}

/** Fetches previews in the background and pushes a MESSAGE_UPDATE when they're ready. */
export function scheduleEmbeds(message: Pick<MessageRow, 'id' | 'channel_id' | 'content'>) {
  if (!ENABLED) return;
  const urls = extractUrls(message.content);
  const hadEmbeds = !!q.get('SELECT 1 FROM embeds WHERE message_id = ?', message.id);
  if (!urls.length && !hadEmbeds) return;
  void (async () => {
    const embeds = (await Promise.all(urls.map(embedFor))).filter((e): e is Embed => !!e);
    const current = q.get<{ content: string }>('SELECT content FROM messages WHERE id = ?', message.id);
    if (!current || current.content !== message.content) return; // edited or deleted meanwhile
    tx(() => {
      q.run('DELETE FROM embeds WHERE message_id = ?', message.id);
      embeds.forEach((e, i) =>
        q.run(
          'INSERT INTO embeds (message_id, position, type, url, title, description, site_name, image_url, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          message.id,
          i,
          e.type,
          e.url,
          e.title,
          e.description,
          e.site_name,
          e.image_url,
          e.color,
        ),
      );
    });
    if (!embeds.length && !hadEmbeds) return;
    const channel = getChannel(message.channel_id);
    const updated = getMessage(message.id);
    if (channel && updated) dispatch(channelAudience(channel), 'MESSAGE_UPDATE', updated);
  })();
}
