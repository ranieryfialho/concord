import crypto from 'node:crypto';
import { q } from './db.js';
import { sha256 } from './util.js';

// No e-mail on this server, so account recovery relies on a code shown once at sign-up.
// 20 symbols from a 32-letter alphabet (no 0/O/1/I) = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCode(): string {
  const chars = Array.from(crypto.randomBytes(20), (b) => ALPHABET[b % ALPHABET.length]);
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join('')).join('-');
}

const normalize = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Stores a fresh code for the user and returns it (the only time it is ever visible). */
export function issueRecoveryCode(userId: string): string {
  const code = generateRecoveryCode();
  q.run('UPDATE users SET recovery_hash = ? WHERE id = ?', sha256(normalize(code)), userId);
  return code;
}

export function recoveryCodeMatches(stored: string | null, code: string): boolean {
  const actual = Buffer.from(sha256(normalize(code)));
  const expected = Buffer.from(stored ?? '0'.repeat(64));
  return crypto.timingSafeEqual(actual, expected) && stored !== null;
}
