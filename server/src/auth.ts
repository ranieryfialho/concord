import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { q } from './db.js';
import type { UserRow } from './models.js';
import { HttpError, randomToken, sha256 } from './util.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
    }
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Drops every session of the user, except `keepToken` when given. */
export function deleteSessions(userId: string, keepToken?: string) {
  if (keepToken) q.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', userId, sha256(keepToken));
  else q.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function createSession(userId: string): string {
  const token = randomToken();
  q.run('INSERT INTO sessions (token_hash, user_id, created_at) VALUES (?, ?, ?)', sha256(token), userId, Date.now());
  return token;
}

export function deleteSession(token: string) {
  q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function userFromToken(token: unknown): UserRow | undefined {
  if (typeof token !== 'string' || !token) return undefined;
  return q.get<UserRow>(
    'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    sha256(token),
  );
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const user = userFromToken(req.headers.authorization);
  if (!user) throw new HttpError(401, 'Sessão inválida, entre novamente');
  req.userId = user.id;
  next();
};
