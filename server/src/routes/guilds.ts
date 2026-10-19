import { Router } from 'express';
import { DEFAULT_EVERYONE_PERMISSIONS, q, tx } from '../db.js';
import { type ChannelRow, type GuildRow, type MemberRow, type MessageRow, getUser, serializeMember, serializeMessages } from '../models.js';
import {
  ALL_PERMISSIONS,
  type GuildContext,
  P,
  type RoleRow,
  channelPermissions,
  getGuild,
  getChannel,
  guildContext,
  has,
  requireGuild,
} from '../permissions.js';
import { limits } from '../ratelimit.js';
import { guildPayload } from '../ready.js';
import { dispatch, leaveVoice, leaveVoiceWhere, presenceOf, setVoiceState, voiceStates } from '../realtime.js';
import { dispatchChannel, resyncGuild } from '../sync.js';
import { publicUrl, removeUpload, uploadImage } from '../uploads.js';
import { HttpError, inviteCode, optionalText, snowflake, text } from '../util.js';

export const guildsRouter = Router();

const CHANNEL_TYPES = new Set(['text', 'voice', 'category']);

function requireGuildRow(id: string): GuildRow {
  const g = getGuild(id);
  if (!g) throw new HttpError(404, 'Servidor não encontrado');
  return g;
}

export function channelName(type: string, raw: unknown): string {
  const name = text(raw, 'Nome do canal', { max: 100 });
  if (type !== 'text') return name;
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
  if (!slug) throw new HttpError(400, 'Nome do canal inválido');
  return slug;
}

function insertChannel(guildId: string, type: string, name: string, parentId: string | null): ChannelRow {
  const id = snowflake();
  const position =
    (q.get<{ p: number | null }>("SELECT MAX(position) AS p FROM channels WHERE guild_id = ? AND type != 'thread'", guildId)?.p ?? -1) + 1;
  q.run(
    'INSERT INTO channels (id, guild_id, parent_id, type, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    guildId,
    parentId,
    type,
    name,
    position,
    Date.now(),
  );
  return q.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id)!;
}

function broadcastMember(guildId: string, userId: string) {
  const ctx = guildContext(guildId);
  const member = q.get<MemberRow>('SELECT * FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId);
  const user = getUser(userId);
  if (!ctx || !member || !user) return;
  dispatch(ctx.memberIds(), 'GUILD_MEMBER_UPDATE', serializeMember(member, user, ctx.memberRoles.get(userId) ?? []));
}

guildsRouter.post('/guilds', limits.guildCreate, (req, res) => {
  const name = text(req.body?.name, 'Nome do servidor', { min: 2, max: 100 });
  const id = snowflake();
  const now = Date.now();
  tx(() => {
    q.run('INSERT INTO guilds (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', id, name, req.userId, now);
    q.run(
      "INSERT INTO roles (id, guild_id, name, permissions, position, created_at) VALUES (?, ?, '@everyone', ?, 0, ?)",
      id,
      id,
      DEFAULT_EVERYONE_PERMISSIONS,
      now,
    );
    q.run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', id, req.userId, now);
    const textCategory = insertChannel(id, 'category', 'Canais de texto', null);
    insertChannel(id, 'text', 'geral', textCategory.id);
    const voiceCategory = insertChannel(id, 'category', 'Canais de voz', null);
    insertChannel(id, 'voice', 'Geral', voiceCategory.id);
  });
  const payload = guildPayload(requireGuildRow(id), req.userId);
  dispatch([req.userId], 'GUILD_CREATE', payload);
  res.status(201).json(payload);
});

guildsRouter.patch('/guilds/:id', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId, P.MANAGE_GUILD);
  const name = text(req.body?.name, 'Nome do servidor', { min: 2, max: 100 });
  q.run('UPDATE guilds SET name = ? WHERE id = ?', name, ctx.guild.id);
  const guild = requireGuildRow(ctx.guild.id);
  dispatch(ctx.memberIds(), 'GUILD_UPDATE', guild);
  res.json(guild);
});

guildsRouter.post('/guilds/:id/icon', limits.uploads, uploadImage.single('file'), (req, res) => {
  const ctx = requireGuild(String(req.params.id), req.userId, P.MANAGE_GUILD);
  if (!req.file) throw new HttpError(400, 'Envie uma imagem PNG, JPG, GIF ou WEBP');
  q.run('UPDATE guilds SET icon_url = ? WHERE id = ?', publicUrl(req.file), ctx.guild.id);
  removeUpload(ctx.guild.icon_url);
  const guild = requireGuildRow(ctx.guild.id);
  dispatch(ctx.memberIds(), 'GUILD_UPDATE', guild);
  res.json(guild);
});

guildsRouter.delete('/guilds/:id', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  if (ctx.guild.owner_id !== req.userId) throw new HttpError(403, 'Só o dono pode excluir o servidor');
  const audience = ctx.memberIds();
  leaveVoiceWhere((s) => s.guild_id === ctx.guild.id);
  const files = q.all<{ url: string }>(
    'SELECT a.url FROM attachments a JOIN messages m ON m.id = a.message_id JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = ?',
    ctx.guild.id,
  );
  q.run('DELETE FROM guilds WHERE id = ?', ctx.guild.id);
  for (const f of files) removeUpload(f.url);
  removeUpload(ctx.guild.icon_url);
  dispatch(audience, 'GUILD_DELETE', { id: ctx.guild.id });
  res.status(204).end();
});

guildsRouter.post('/guilds/:id/transfer', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  if (ctx.guild.owner_id !== req.userId) throw new HttpError(403, 'Só o dono pode transferir o servidor');
  const target = String(req.body?.user_id ?? '');
  if (!ctx.isMember(target) || target === req.userId) throw new HttpError(400, 'Escolha outro membro do servidor');
  q.run('UPDATE guilds SET owner_id = ? WHERE id = ?', target, ctx.guild.id);
  dispatch(ctx.memberIds(), 'GUILD_UPDATE', requireGuildRow(ctx.guild.id));
  resyncGuild(ctx.guild.id, [req.userId, target]);
  res.status(204).end();
});

// ---- Members ----

function removeMember(ctx: GuildContext, userId: string) {
  q.run('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?', ctx.guild.id, userId);
  q.run('DELETE FROM members WHERE guild_id = ? AND user_id = ?', ctx.guild.id, userId);
  leaveVoiceWhere((s) => s.guild_id === ctx.guild.id && s.user_id === userId);
  dispatch([userId], 'GUILD_DELETE', { id: ctx.guild.id });
  dispatch(
    ctx.memberIds().filter((id) => id !== userId),
    'GUILD_MEMBER_REMOVE',
    { guild_id: ctx.guild.id, user_id: userId },
  );
}

guildsRouter.delete('/guilds/:id/members/@me', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  if (ctx.guild.owner_id === req.userId) throw new HttpError(400, 'O dono não pode sair. Transfira a posse ou exclua o servidor.');
  removeMember(ctx, req.userId);
  res.status(204).end();
});

guildsRouter.delete('/guilds/:id/members/:userId', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId, P.KICK_MEMBERS);
  const target = req.params.userId;
  if (!ctx.isMember(target)) throw new HttpError(404, 'Membro não encontrado');
  if (target === ctx.guild.owner_id || ctx.highest(target) >= ctx.highest(req.userId)) {
    throw new HttpError(403, 'Você não pode expulsar alguém com cargo igual ou superior ao seu');
  }
  removeMember(ctx, target);
  res.status(204).end();
});

// Voice moderation: server-mute, disconnect or move someone who is in a voice channel of this guild.
guildsRouter.patch('/guilds/:id/voice-states/:userId', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  const actor = ctx.base(req.userId);
  const target = req.params.userId;
  const state = voiceStates.get(target);
  if (!state || state.guild_id !== ctx.guild.id) throw new HttpError(404, 'Essa pessoa não está em um canal de voz deste servidor');

  const { mute, channel_id: destination } = (req.body ?? {}) as { mute?: unknown; channel_id?: unknown };
  if (mute === undefined && destination === undefined) throw new HttpError(400, 'Nada para alterar');

  if (mute !== undefined) {
    if (typeof mute !== 'boolean') throw new HttpError(400, 'Valor inválido');
    if (!has(actor, P.MUTE_MEMBERS)) throw new HttpError(403, 'Você não tem permissão para silenciar membros');
    const channel = getChannel(state.channel_id);
    const canSpeak = !!channel && has(channelPermissions(channel, target, ctx), P.SPEAK);
    setVoiceState({ ...state, server_mute: mute, suppress: mute || !canSpeak });
  }

  if (destination !== undefined) {
    if (!has(actor, P.MOVE_MEMBERS)) throw new HttpError(403, 'Você não tem permissão para mover membros');
    if (destination === null) {
      leaveVoice(target); // the client sees its own state vanish and tears the call down
    } else {
      const channel = typeof destination === 'string' ? getChannel(destination) : undefined;
      if (!channel || channel.guild_id !== ctx.guild.id || channel.type !== 'voice') throw new HttpError(404, 'Canal de voz não encontrado');
      if (!has(channelPermissions(channel, req.userId, ctx), P.CONNECT)) throw new HttpError(403, 'Você não pode entrar nesse canal');
      if (!has(channelPermissions(channel, target, ctx), P.CONNECT)) throw new HttpError(403, 'Essa pessoa não pode entrar nesse canal');
      // The target's own client performs the join (WebRTC is negotiated client-side).
      dispatch([target], 'VOICE_MOVE', { guild_id: ctx.guild.id, channel_id: channel.id, by: req.userId });
    }
  }
  res.status(204).end();
});

guildsRouter.patch('/guilds/:id/members/:userId', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  const targetId = req.params.userId === '@me' ? req.userId : req.params.userId;
  if (!ctx.isMember(targetId)) throw new HttpError(404, 'Membro não encontrado');
  const nickname = optionalText(req.body?.nickname, 'Apelido', 32);
  if (nickname !== undefined) {
    if (targetId !== req.userId) {
      if (!has(ctx.base(req.userId), P.MANAGE_NICKNAMES)) throw new HttpError(403, 'Você não pode alterar esse apelido');
      if (targetId === ctx.guild.owner_id || ctx.highest(targetId) >= ctx.highest(req.userId)) {
        throw new HttpError(403, 'Você não pode alterar o apelido de alguém com cargo igual ou superior');
      }
    }
    q.run('UPDATE members SET nickname = ? WHERE guild_id = ? AND user_id = ?', nickname, ctx.guild.id, targetId);
  }
  broadcastMember(ctx.guild.id, targetId);
  res.status(204).end();
});

// ---- Roles ----

function parseColor(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === '') return null;
  const n = typeof raw === 'string' ? parseInt(raw.replace('#', ''), 16) : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 0xffffff) throw new HttpError(400, 'Cor inválida');
  return n;
}

function parsePermissions(raw: unknown, ctx: GuildContext, actorId: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > ALL_PERMISSIONS) throw new HttpError(400, 'Permissões inválidas');
  const actor = ctx.base(actorId);
  if (actor !== ALL_PERMISSIONS && (n & ~actor) !== 0) throw new HttpError(403, 'Você não pode conceder permissões que não tem');
  return n;
}

function requireManageableRole(ctx: GuildContext, actorId: string, roleId: string): RoleRow {
  if (!has(ctx.base(actorId), P.MANAGE_ROLES)) throw new HttpError(403, 'Você não tem permissão para gerenciar cargos');
  const role = ctx.roles.get(roleId);
  if (!role) throw new HttpError(404, 'Cargo não encontrado');
  if (role.id !== ctx.guild.id && role.position >= ctx.highest(actorId)) {
    throw new HttpError(403, 'Você só pode gerenciar cargos abaixo do seu cargo mais alto');
  }
  return role;
}

guildsRouter.post('/guilds/:id/roles', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId, P.MANAGE_ROLES);
  if (ctx.roles.size >= 50) throw new HttpError(400, 'Limite de 50 cargos atingido');
  const name = req.body?.name !== undefined ? text(req.body.name, 'Nome do cargo', { max: 100 }) : 'novo cargo';
  const color = parseColor(req.body?.color) ?? null;
  const permissions = parsePermissions(req.body?.permissions, ctx, req.userId) ?? 0;
  const id = snowflake();
  tx(() => {
    // New roles go to the bottom (just above @everyone).
    q.run('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1', ctx.guild.id);
    q.run(
      'INSERT INTO roles (id, guild_id, name, color, permissions, position, hoist, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)',
      id,
      ctx.guild.id,
      name,
      color,
      permissions,
      req.body?.hoist ? 1 : 0,
      Date.now(),
    );
  });
  resyncGuild(ctx.guild.id);
  res.status(201).json({ id });
});

guildsRouter.patch('/guilds/:id/roles/:roleId', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  const role = requireManageableRole(ctx, req.userId, req.params.roleId);
  const isEveryone = role.id === ctx.guild.id;
  const name = !isEveryone && req.body?.name !== undefined ? text(req.body.name, 'Nome do cargo', { max: 100 }) : role.name;
  const color = isEveryone ? null : parseColor(req.body?.color);
  const permissions = parsePermissions(req.body?.permissions, ctx, req.userId);
  const hoist = !isEveryone && typeof req.body?.hoist === 'boolean' ? (req.body.hoist ? 1 : 0) : role.hoist;
  q.run(
    'UPDATE roles SET name = ?, color = ?, permissions = ?, hoist = ? WHERE id = ?',
    name,
    color === undefined ? role.color : color,
    permissions ?? role.permissions,
    hoist,
    role.id,
  );
  resyncGuild(ctx.guild.id);
  res.status(204).end();
});

guildsRouter.post('/guilds/:id/roles/:roleId/move', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  const role = requireManageableRole(ctx, req.userId, req.params.roleId);
  if (role.id === ctx.guild.id) throw new HttpError(400, '@everyone fica sempre por último');
  const direction = req.body?.direction === 'up' ? 1 : -1;
  const neighbor = [...ctx.roles.values()].find((r) => r.position === role.position + direction);
  if (!neighbor || neighbor.id === ctx.guild.id) {
    res.status(204).end();
    return;
  }
  if (direction === 1 && neighbor.position >= ctx.highest(req.userId)) {
    throw new HttpError(403, 'Você não pode mover um cargo acima do seu');
  }
  tx(() => {
    q.run('UPDATE roles SET position = ? WHERE id = ?', neighbor.position, role.id);
    q.run('UPDATE roles SET position = ? WHERE id = ?', role.position, neighbor.id);
  });
  resyncGuild(ctx.guild.id);
  res.status(204).end();
});

guildsRouter.delete('/guilds/:id/roles/:roleId', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  const role = requireManageableRole(ctx, req.userId, req.params.roleId);
  if (role.id === ctx.guild.id) throw new HttpError(400, '@everyone não pode ser excluído');
  tx(() => {
    q.run('DELETE FROM roles WHERE id = ?', role.id);
    q.run('UPDATE roles SET position = position - 1 WHERE guild_id = ? AND position > ?', ctx.guild.id, role.position);
  });
  resyncGuild(ctx.guild.id);
  res.status(204).end();
});

function setMemberRole(req: { userId: string; params: Record<string, string> }, add: boolean) {
  const ctx = requireGuild(req.params.id, req.userId);
  const role = requireManageableRole(ctx, req.userId, req.params.roleId);
  if (role.id === ctx.guild.id) throw new HttpError(400, 'Todos já têm @everyone');
  const target = req.params.userId;
  if (!ctx.isMember(target)) throw new HttpError(404, 'Membro não encontrado');
  if (add) q.run('INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', ctx.guild.id, target, role.id);
  else q.run('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?', ctx.guild.id, target, role.id);
  resyncGuild(ctx.guild.id, [target]);
  broadcastMember(ctx.guild.id, target);
}

guildsRouter.put('/guilds/:id/members/:userId/roles/:roleId', (req, res) => {
  setMemberRole(req, true);
  res.status(204).end();
});

guildsRouter.delete('/guilds/:id/members/:userId/roles/:roleId', (req, res) => {
  setMemberRole(req, false);
  res.status(204).end();
});

// ---- Channels ----

guildsRouter.post('/guilds/:id/channels', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId, P.MANAGE_CHANNELS);
  const type = String(req.body?.type ?? 'text');
  if (!CHANNEL_TYPES.has(type)) throw new HttpError(400, 'Tipo de canal inválido');
  const name = channelName(type, req.body?.name);
  let parentId: string | null = typeof req.body?.parent_id === 'string' ? req.body.parent_id : null;
  if (parentId && (type === 'category' || ctx.channels.get(parentId)?.type !== 'category')) parentId = null;
  const channel = insertChannel(ctx.guild.id, type, name, parentId);
  dispatchChannel(channel, 'CHANNEL_CREATE');
  res.status(201).json({ id: channel.id });
});

// ---- Invites ----

guildsRouter.post('/guilds/:id/invites', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId, P.CREATE_INVITE);
  const maxUses = Number(req.body?.max_uses) || null;
  const maxAge = Number(req.body?.max_age) || null; // seconds
  const code = inviteCode();
  const expiresAt = maxAge ? Date.now() + maxAge * 1000 : null;
  q.run(
    'INSERT INTO invites (code, guild_id, creator_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    code,
    ctx.guild.id,
    req.userId,
    maxUses,
    expiresAt,
    Date.now(),
  );
  res.status(201).json({ code, guild_id: ctx.guild.id, max_uses: maxUses, expires_at: expiresAt });
});

// ---- Search ----

guildsRouter.get('/guilds/:id/messages/search', (req, res) => {
  const ctx = requireGuild(req.params.id, req.userId);
  const query = String(req.query.q ?? '').trim();
  if (!query) {
    res.json([]);
    return;
  }
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = q.all<MessageRow>(
    `SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
     WHERE c.guild_id = ? AND m.type = 'default' AND m.content LIKE ? ESCAPE '\\'
     ORDER BY m.id DESC LIMIT 200`,
    ctx.guild.id,
    like,
  );
  const visible = rows.filter((m) => {
    const c = ctx.channels.get(m.channel_id);
    return c && ctx.channel(c, req.userId) & P.VIEW_CHANNEL;
  });
  res.json(serializeMessages(visible.slice(0, 50)));
});

// Used by the invite join route.
export function joinGuild(guildId: string, userId: string) {
  q.run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', guildId, userId, Date.now());
  const ctx = guildContext(guildId)!;
  const user = getUser(userId)!;
  const payload = guildPayload(ctx.guild, userId, ctx);
  dispatch([userId], 'GUILD_CREATE', payload);
  const member = q.get<MemberRow>('SELECT * FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId)!;
  dispatch(
    ctx.memberIds().filter((id) => id !== userId),
    'GUILD_MEMBER_ADD',
    { ...serializeMember(member, user, []), status: presenceOf(user.id, user.status) },
  );
  return payload;
}
