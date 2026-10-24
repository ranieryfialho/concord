import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Form field the error belongs to, so the client can show it next to that input. */
    public field?: string,
  ) {
    super(message);
  }
}

// Sortable IDs: milliseconds since 2025-01-01 shifted left + 12-bit sequence,
// zero-padded so lexicographic order matches numeric order in SQLite TEXT columns.
const EPOCH = 1735689600000;
let lastTs = 0;
let seq = 0;

export function snowflake(): string {
  let ts = Date.now();
  if (ts <= lastTs) {
    ts = lastTs;
    seq++;
    if (seq > 4095) {
      ts = ++lastTs;
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastTs = ts;
  return ((BigInt(ts - EPOCH) << 12n) | BigInt(seq)).toString().padStart(19, '0');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

export function inviteCode(): string {
  let code = '';
  for (const byte of crypto.randomBytes(8)) code += INVITE_ALPHABET[byte % INVITE_ALPHABET.length];
  return code;
}

export function text(value: unknown, field: string, opts: { min?: number; max: number; key?: string }): string {
  if (typeof value !== 'string') throw new HttpError(400, `${field} inválido`, opts.key);
  const s = value.trim();
  const min = opts.min ?? 1;
  if (s.length < min || s.length > opts.max) {
    throw new HttpError(400, `${field} deve ter entre ${min} e ${opts.max} caracteres`, opts.key);
  }
  return s;
}

export function optionalText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(400, `${field} inválido`);
  const s = value.trim();
  if (s.length > max) throw new HttpError(400, `${field} deve ter no máximo ${max} caracteres`);
  return s || null;
}
