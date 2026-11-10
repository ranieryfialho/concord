import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.CONCORD_DATA_DIR ?? path.join(import.meta.dirname, '..', 'data'));
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'concord.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'online',
  custom_status TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_url TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  nickname TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  guild_id TEXT REFERENCES guilds(id) ON DELETE CASCADE,
  parent_id TEXT,
  type TEXT NOT NULL,
  name TEXT,
  topic TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channels_guild ON channels(guild_id);

CREATE TABLE IF NOT EXISTS dm_recipients (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_recipients_user ON dm_recipients(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL DEFAULT '',
  reply_to_id TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  edited_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_channel ON messages(channel_id, id);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  url TEXT NOT NULL,
  content_type TEXT,
  size INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  creator_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relationships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, target_id)
);

CREATE TABLE IF NOT EXISTS read_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id TEXT,
  PRIMARY KEY (user_id, channel_id)
);
`);

const cache = new Map<string, StatementSync>();

function stmt(sql: string): StatementSync {
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export const q = {
  get: <T>(sql: string, ...params: SQLInputValue[]) => stmt(sql).get(...params) as T | undefined,
  all: <T>(sql: string, ...params: SQLInputValue[]) => stmt(sql).all(...params) as T[],
  run: (sql: string, ...params: SQLInputValue[]) => stmt(sql).run(...params),
};

/** For queries with a variable-length IN (...) list; not cached. */
export function qAll<T>(sql: string, params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

let txDepth = 0;
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn();
  txDepth++;
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    txDepth--;
  }
}

// ---------- Migrations (PRAGMA user_version) ----------

// Kept in sync with permissions.ts (duplicated to avoid an import cycle at startup).
const VIEW = 1, SEND = 2, ATTACH = 8, REACT = 16, CONNECT = 32, SPEAK = 64, STREAM = 128, INVITE = 4096, THREADS = 16384, ADMIN = 32768;
export const DEFAULT_EVERYONE_PERMISSIONS = VIEW | SEND | ATTACH | REACT | CONNECT | SPEAK | STREAM | INVITE | THREADS;

function migrateTo2() {
  db.exec(`
    ALTER TABLE channels ADD COLUMN owner_id TEXT;
    ALTER TABLE channels ADD COLUMN icon_url TEXT;
    ALTER TABLE channels ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE channels ADD COLUMN starter_message_id TEXT;
    ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'default';

    CREATE INDEX IF NOT EXISTS channels_parent ON channels(parent_id);

    CREATE TABLE roles (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color INTEGER,
      permissions INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      hoist INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX roles_guild ON roles(guild_id);

    CREATE TABLE member_roles (
      guild_id TEXT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      PRIMARY KEY (guild_id, user_id, role_id)
    );

    CREATE TABLE channel_overwrites (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      allow INTEGER NOT NULL DEFAULT 0,
      deny INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (channel_id, role_id)
    );

    CREATE TABLE embeds (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      type TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      site_name TEXT,
      image_url TEXT,
      color TEXT,
      PRIMARY KEY (message_id, position)
    );
  `);

  // Old fixed roles -> @everyone role (id = guild id) + an "Admin" role for former admins.
  const now = Date.now();
  const guilds = q.all<{ id: string }>('SELECT id FROM guilds');
  for (const g of guilds) {
    q.run(
      "INSERT INTO roles (id, guild_id, name, permissions, position, created_at) VALUES (?, ?, '@everyone', ?, 0, ?)",
      g.id,
      g.id,
      DEFAULT_EVERYONE_PERMISSIONS,
      now,
    );
    const admins = q.all<{ user_id: string }>("SELECT user_id FROM members WHERE guild_id = ? AND role = 'admin'", g.id);
    if (admins.length) {
      const roleId = `${g.id}-admin`;
      q.run(
        "INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, created_at) VALUES (?, ?, 'Admin', ?, ?, 1, 1, ?)",
        roleId,
        g.id,
        0x9d93ff,
        ADMIN,
        now,
      );
      for (const a of admins) q.run('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', g.id, a.user_id, roleId);
    }
  }
}

function migrateTo3() {
  db.exec(`
    CREATE TABLE transcripts (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      started_by TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX transcripts_channel ON transcripts(channel_id, started_at);

    CREATE TABLE transcript_entries (
      transcript_id TEXT NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL,
      PRIMARY KEY (transcript_id, id)
    );
  `);
}

function migrateTo4() {
  // sha256 of the account recovery code (see recovery.ts); NULL until the user generates one.
  db.exec('ALTER TABLE users ADD COLUMN recovery_hash TEXT;');
}

function migrateTo5() {
  // Call transcription was removed; its tables go with it.
  db.exec('DROP TABLE IF EXISTS transcript_entries; DROP TABLE IF EXISTS transcripts;');
}

const MIGRATIONS: [number, () => void][] = [
  [2, migrateTo2],
  [3, migrateTo3],
  [4, migrateTo4],
  [5, migrateTo5],
];

{
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (const [version, migrate] of MIGRATIONS) {
    if (current >= version) continue;
    tx(migrate);
    db.exec(`PRAGMA user_version = ${version}`);
    console.log(`[db] migrated to v${version}`);
  }
}
