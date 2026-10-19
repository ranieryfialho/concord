import { DEFAULT_EVERYONE_PERMISSIONS, q } from './db.js';
import type { ChannelRow, GuildRow } from './models.js';
import { HttpError } from './util.js';

// Permission bits. Mirrored in client/src/permissions.ts.
export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  MANAGE_MESSAGES: 1 << 2,
  ATTACH_FILES: 1 << 3,
  ADD_REACTIONS: 1 << 4,
  CONNECT: 1 << 5,
  SPEAK: 1 << 6,
  STREAM: 1 << 7,
  MANAGE_CHANNELS: 1 << 8,
  MANAGE_ROLES: 1 << 9,
  MANAGE_GUILD: 1 << 10,
  KICK_MEMBERS: 1 << 11,
  CREATE_INVITE: 1 << 12,
  MANAGE_NICKNAMES: 1 << 13,
  CREATE_THREADS: 1 << 14,
  ADMINISTRATOR: 1 << 15,
} as const;

export const ALL_PERMISSIONS = (P.ADMINISTRATOR << 1) - 1;
export const DEFAULT_EVERYONE = DEFAULT_EVERYONE_PERMISSIONS;
export const DM_PERMISSIONS =
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS | P.CONNECT | P.SPEAK | P.STREAM;

export const MESSAGEABLE = new Set(['text', 'dm', 'group_dm', 'thread']);

export function has(perms: number, bit: number): boolean {
  return (perms & bit) === bit;
}

export interface RoleRow {
  id: string;
  guild_id: string;
  name: string;
  color: number | null;
  permissions: number;
  position: number;
  hoist: number;
  created_at: number;
}

export interface OverwriteRow {
  channel_id: string;
  role_id: string;
  allow: number;
  deny: number;
}

/** Everything needed to resolve permissions in one guild, loaded once per request/fan-out. */
export class GuildContext {
  readonly roles = new Map<string, RoleRow>();
  readonly memberRoles = new Map<string, string[]>();
  readonly channels = new Map<string, ChannelRow>();
  private readonly overwrites = new Map<string, OverwriteRow[]>();

  constructor(readonly guild: GuildRow) {
    for (const r of q.all<RoleRow>('SELECT * FROM roles WHERE guild_id = ? ORDER BY position', guild.id)) this.roles.set(r.id, r);
    for (const m of q.all<{ user_id: string }>('SELECT user_id FROM members WHERE guild_id = ?', guild.id)) this.memberRoles.set(m.user_id, []);
    for (const mr of q.all<{ user_id: string; role_id: string }>('SELECT user_id, role_id FROM member_roles WHERE guild_id = ?', guild.id)) {
      this.memberRoles.get(mr.user_id)?.push(mr.role_id);
    }
    for (const c of q.all<ChannelRow>('SELECT * FROM channels WHERE guild_id = ?', guild.id)) this.channels.set(c.id, c);
    for (const o of q.all<OverwriteRow>(
      'SELECT o.* FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = ?',
      guild.id,
    )) {
      const list = this.overwrites.get(o.channel_id) ?? [];
      list.push(o);
      this.overwrites.set(o.channel_id, list);
    }
  }

  isMember(userId: string): boolean {
    return this.memberRoles.has(userId);
  }

  memberIds(): string[] {
    return [...this.memberRoles.keys()];
  }

  base(userId: string): number {
    if (!this.isMember(userId)) return 0;
    if (this.guild.owner_id === userId) return ALL_PERMISSIONS;
    let perms = this.roles.get(this.guild.id)?.permissions ?? 0;
    for (const id of this.memberRoles.get(userId) ?? []) perms |= this.roles.get(id)?.permissions ?? 0;
    return perms & P.ADMINISTRATOR ? ALL_PERMISSIONS : perms;
  }

  /** Position of the member's highest role; the owner outranks everyone. */
  highest(userId: string): number {
    if (this.guild.owner_id === userId) return Number.POSITIVE_INFINITY;
    let top = 0;
    for (const id of this.memberRoles.get(userId) ?? []) top = Math.max(top, this.roles.get(id)?.position ?? 0);
    return top;
  }

  /** Overwrites that apply to a channel: threads use their parent; channels without their own use the category's. */
  overwritesFor(c: ChannelRow): OverwriteRow[] {
    const target = c.type === 'thread' && c.parent_id ? (this.channels.get(c.parent_id) ?? c) : c;
    const own = this.overwrites.get(target.id);
    if (own?.length) return own;
    return target.parent_id && target.type !== 'thread' ? (this.overwrites.get(target.parent_id) ?? []) : [];
  }

  ownOverwrites(channelId: string): OverwriteRow[] {
    return this.overwrites.get(channelId) ?? [];
  }

  channel(c: ChannelRow, userId: string): number {
    const base = this.base(userId);
    if (!base) return 0;
    if (base === ALL_PERMISSIONS) return ALL_PERMISSIONS;
    const ows = this.overwritesFor(c);
    let perms = base;
    const everyone = ows.find((o) => o.role_id === this.guild.id);
    if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;
    const mine = new Set(this.memberRoles.get(userId));
    let allow = 0;
    let deny = 0;
    for (const o of ows) {
      if (!mine.has(o.role_id)) continue;
      allow |= o.allow;
      deny |= o.deny;
    }
    perms = (perms & ~deny) | allow;
    return perms & P.VIEW_CHANNEL ? perms : 0;
  }

  viewers(c: ChannelRow): string[] {
    return this.memberIds().filter((id) => this.channel(c, id) & P.VIEW_CHANNEL);
  }
}

export function getGuild(id: string): GuildRow | undefined {
  return q.get<GuildRow>('SELECT * FROM guilds WHERE id = ?', id);
}

export function guildContext(guildId: string): GuildContext | undefined {
  const guild = getGuild(guildId);
  return guild ? new GuildContext(guild) : undefined;
}

export function getChannel(id: string): ChannelRow | undefined {
  return q.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
}

export function isRecipient(channelId: string, userId: string): boolean {
  return !!q.get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', channelId, userId);
}

export function recipientIds(channelId: string): string[] {
  return q.all<{ user_id: string }>('SELECT user_id FROM dm_recipients WHERE channel_id = ?', channelId).map((r) => r.user_id);
}

export function channelPermissions(c: ChannelRow, userId: string, ctx?: GuildContext): number {
  if (!c.guild_id) return isRecipient(c.id, userId) ? DM_PERMISSIONS : 0;
  const context = ctx ?? guildContext(c.guild_id);
  return context ? context.channel(c, userId) : 0;
}

/** Members who can see a channel (DM recipients for private channels). */
export function channelAudience(c: ChannelRow, ctx?: GuildContext): string[] {
  if (!c.guild_id) return recipientIds(c.id);
  const context = ctx ?? guildContext(c.guild_id);
  return context ? context.viewers(c) : [];
}

export function requireGuild(guildId: string, userId: string, needed = 0): GuildContext {
  const ctx = guildContext(guildId);
  if (!ctx || !ctx.isMember(userId)) throw new HttpError(404, 'Servidor não encontrado');
  if (needed && !has(ctx.base(userId), needed)) throw new HttpError(403, 'Você não tem permissão para isso');
  return ctx;
}

export interface ChannelAccess {
  channel: ChannelRow;
  perms: number;
  ctx?: GuildContext;
}

export function requireChannel(userId: string, channelId: string, needed = 0): ChannelAccess {
  const channel = getChannel(channelId);
  if (!channel) throw new HttpError(404, 'Canal não encontrado');
  const ctx = channel.guild_id ? guildContext(channel.guild_id) : undefined;
  const perms = channelPermissions(channel, userId, ctx);
  if (!(perms & P.VIEW_CHANNEL)) throw new HttpError(404, 'Canal não encontrado');
  if (needed && !has(perms, needed)) throw new HttpError(403, 'Você não tem permissão para isso');
  return { channel, perms, ctx };
}

export function requireMessageable(userId: string, channelId: string, needed = 0): ChannelAccess {
  const access = requireChannel(userId, channelId, needed);
  if (!MESSAGEABLE.has(access.channel.type)) throw new HttpError(400, 'Este canal não aceita mensagens');
  return access;
}
