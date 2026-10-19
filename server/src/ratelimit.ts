import type { Request, RequestHandler } from 'express';
import { HttpError } from './util.js';

interface Bucket {
  count: number;
  reset: number;
}

/** Fixed-window counter. In-memory, so limits are per server process. */
export class Limiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private limit: number,
    private windowMs: number,
  ) {
    setInterval(() => {
      const now = Date.now();
      for (const [key, b] of this.buckets) if (b.reset <= now) this.buckets.delete(key);
    }, Math.max(windowMs, 30_000)).unref();
  }

  /** Returns seconds to wait when over the limit, otherwise 0. */
  hit(key: string): number {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + this.windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return b.count > this.limit ? Math.ceil((b.reset - now) / 1000) : 0;
  }
}

export const byIp = (req: Request) => req.ip ?? 'unknown';
export const byUser = (req: Request) => req.userId ?? req.ip ?? 'unknown';

// Multiplies every HTTP limit; only meant for automated tests.
const SCALE = Math.max(1, Number(process.env.RATE_LIMIT_SCALE) || 1);

export function rateLimit(limit: number, windowMs: number, key: (req: Request) => string = byUser): RequestHandler {
  const limiter = new Limiter(limit * SCALE, windowMs);
  return (req, res, next) => {
    const wait = limiter.hit(key(req));
    if (wait) {
      res.setHeader('Retry-After', String(wait));
      throw new HttpError(429, `Você está fazendo isso rápido demais. Tente de novo em ${wait}s.`);
    }
    next();
  };
}

export const limits = {
  register: rateLimit(10, 60 * 60_000, byIp),
  login: rateLimit(10, 15 * 60_000, byIp),
  // Recovery codes are the only secret here, so guess attempts are capped per IP and per account.
  resetIp: rateLimit(10, 60 * 60_000, byIp),
  resetAccount: rateLimit(5, 60 * 60_000, (req) => `reset:${String(req.body?.username ?? '').toLowerCase()}`),
  password: rateLimit(10, 15 * 60_000),
  api: rateLimit(300, 60_000),
  messages: rateLimit(10, 10_000),
  uploads: rateLimit(10, 60_000),
  typing: rateLimit(10, 10_000),
  friendRequests: rateLimit(20, 60 * 60_000),
  invitesJoin: rateLimit(20, 60 * 60_000),
  guildCreate: rateLimit(10, 60 * 60_000),
  transcribe: rateLimit(120, 60_000),
};
