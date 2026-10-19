import { Router } from 'express';
import { q, tx } from '../db.js';
import { scheduleEmbeds } from '../embeds.js';
import { type ChannelRow, type MessageRow, getMessage, getUser, serializeMessages } from '../models.js';
import {
  ALL_PERMISSIONS,
  type ChannelAccess,
  P,
  channelAudience,
  getChannel,
  guildContext,
  has,
  recipientIds,
  requireChannel,
  requireMessageable,
} from '../permissions.js';
import { limits } from '../ratelimit.js';
import { privateChannelPayload } from '../ready.js';
import { dispatch, insertSystemMessage, leaveVoice, leaveVoiceWhere, voiceStates } from '../realtime.js';
import { dispatchChannel, resyncGuild } from '../sync.js';
import { originalName, publicUrl, removeUpload, uploadFiles, uploadImage } from '../uploads.js';
import { HttpError, optionalText, snowflake, text } from '../util.js';
import { channelName } from './guilds.js';
import { MAX_GROUP_SIZE, areFriends, sharePresences } from './users.js';

export const channelsRouter = Router();

const MAX_CONTENT = 4000;

function markRead(userId: string, channelId: string, messageId: string) {
  q.run(
    `INSERT INTO read_states (user_id, channel_id, last_read_id) VALUES (?, ?, ?)
     ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = MAX(COALESCE(last_read_id, ''), excluded.last_read_id)`,
    userId,
    channelId,
    messageId,
  );
}

function requireMessage(channel: ChannelRow, messageId: string): MessageRow {
  const m = q.get<MessageRow>('SELECT * FROM messages WHERE id = ? AND channel_id = ?', messageId, channel.id);
  if (!m) throw new HttpError(404, 'Mensagem não encontrada');
  return m;
}

function reload(id: string): ChannelRow {
  return getChannel(id)!;
}

/** Thread owners may rename/archive their own thread; otherwise MANAGE_CHANNELS is required. */
function canManageChannel(access: ChannelAccess, userId: string): boolean {
  if (access.channel.type === 'thread' && access.channel.owner_id === userId) return true;
  return has(access.perms, P.MANAGE_CHANNELS);
}

function isPrivate(c: ChannelRow) {
  return c.type === 'dm' || c.type === 'group_dm';
}

// ---- Channel management ----

channelsRouter.patch('/channels/:id', (req, res) => {
  const access = requireChannel(req.userId, req.params.id);
  const { channel } = access;

  if (channel.type === 'group_dm') {
    const name = optionalText(req.body?.name, 'Nome do grupo', 100);
    if (name === undefined) throw new HttpError(400, 'Nada para alterar');
    q.run('UPDATE channels SET name = ? WHERE id = ?', name, channel.id);
    const msg = insertSystemMessage(channel.id, req.userId, 'channel_name_change', name ?? '');
    dispatchChannel(reload(channel.id), 'CHANNEL_UPDATE');
    dispatch(recipientIds(channel.id), 'MESSAGE_CREATE', msg);
    res.status(204).end();
    return;
  }
  if (!channel.guild_id) throw new HttpError(400, 'DMs não podem ser editadas');
  if (!canManageChannel(access, req.userId)) throw new HttpError(403, 'Você não tem permissão para isso');

  const name = req.body?.name !== undefined ? channelName(channel.type === 'thread' ? 'thread' : channel.type, req.body.name) : channel.name;
  const topic = channel.type === 'text' ? optionalText(req.body?.topic, 'Tópico', 1024) : undefined;
  const archived = channel.type === 'thread' && typeof req.body?.archived === 'boolean' ? (req.body.archived ? 1 : 0) : channel.archived;
  q.run(
    'UPDATE channels SET name = ?, topic = CASE WHEN ? THEN ? ELSE topic END, archived = ? WHERE id = ?',
    name,
    topic !== undefined ? 1 : 0,
    topic ?? null,
    archived,
    channel.id,
  );
  dispatchChannel(reload(channel.id), 'CHANNEL_UPDATE');
  res.status(204).end();
});

channelsRouter.post('/channels/:id/icon', limits.uploads, uploadImage.single('file'), (req, res) => {
  const { channel } = requireChannel(req.userId, String(req.params.id));
  if (channel.type !== 'group_dm') throw new HttpError(400, 'Só grupos têm ícone');
  if (!req.file) throw new HttpError(400, 'Envie uma imagem PNG, JPG, GIF ou WEBP');
  q.run('UPDATE channels SET icon_url = ? WHERE id = ?', publicUrl(req.file), channel.id);
  removeUpload(channel.icon_url);
  dispatchChannel(reload(channel.id), 'CHANNEL_UPDATE');
  res.status(204).end();
});

channelsRouter.delete('/channels/:id', (req, res) => {
  const access = requireChannel(req.userId, req.params.id);
  const { channel } = access;
  if (!channel.guild_id) throw new HttpError(400, 'Para sair de um grupo, use "Sair do grupo"');
  if (!canManageChannel(access, req.userId)) throw new HttpError(403, 'Você não tem permissão para isso');

  const ctx = guildContext(channel.guild_id)!;
  const threads = q.all<ChannelRow>("SELECT * FROM channels WHERE parent_id = ? AND type = 'thread'", channel.id);
  const doomed = [channel.id, ...threads.map((t) => t.id)];
  const files = q.all<{ url: string }>(
    `SELECT a.url FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id IN (${doomed.map(() => '?').join(',')})`,
    ...doomed,
  );
  leaveVoiceWhere((s) => s.channel_id === channel.id);
  tx(() => {
    for (const id of doomed) q.run('DELETE FROM channels WHERE id = ?', id);
    q.run('UPDATE channels SET parent_id = NULL WHERE parent_id = ?', channel.id);
  });
  for (const f of files) removeUpload(f.url);
  for (const id of doomed) dispatch(ctx.memberIds(), 'CHANNEL_DELETE', { id, guild_id: channel.guild_id });
  // Children of a deleted category lose the category's permissions; resync visibility.
  if (channel.type === 'category') resyncGuild(channel.guild_id);
  res.status(204).end();
});

// ---- Permission overwrites ----

channelsRouter.put('/channels/:id/permissions/:roleId', (req, res) => {
  const access = requireChannel(req.userId, req.params.id, P.MANAGE_CHANNELS);
  const { channel } = access;
  if (!channel.guild_id || channel.type === 'thread') throw new HttpError(400, 'Este canal não tem permissões próprias');
  const ctx = access.ctx!;
  if (!has(ctx.base(req.userId), P.MANAGE_ROLES)) throw new HttpError(403, 'Você precisa de "Gerenciar cargos"');
  const role = ctx.roles.get(req.params.roleId);
  if (!role) throw new HttpError(404, 'Cargo não encontrado');
  const allow = Number(req.body?.allow ?? 0);
  const deny = Number(req.body?.deny ?? 0);
  for (const n of [allow, deny]) if (!Number.isInteger(n) || n < 0 || n > ALL_PERMISSIONS) throw new HttpError(400, 'Permissões inválidas');
  const actor = ctx.base(req.userId);
  if (actor !== ALL_PERMISSIONS && ((allow | deny) & ~actor) !== 0) throw new HttpError(403, 'Você não pode alterar permissões que não tem');

  // A channel that was synced to its category starts from the category's overwrites.
  tx(() => {
    if (!ctx.ownOverwrites(channel.id).length && channel.parent_id) {
      for (const o of ctx.ownOverwrites(channel.parent_id)) {
        q.run('INSERT INTO channel_overwrites (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)', channel.id, o.role_id, o.allow, o.deny);
      }
    }
    q.run(
      `INSERT INTO channel_overwrites (channel_id, role_id, allow, deny) VALUES (?, ?, ?, ?)
       ON CONFLICT (channel_id, role_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
      channel.id,
      role.id,
      allow & ~deny,
      deny,
    );
  });
  resyncGuild(channel.guild_id);
  res.status(204).end();
});

channelsRouter.delete('/channels/:id/permissions/:roleId', (req, res) => {
  const access = requireChannel(req.userId, req.params.id, P.MANAGE_CHANNELS);
  const { channel } = access;
  if (!channel.guild_id) throw new HttpError(400, 'Este canal não tem permissões próprias');
  if (!has(access.ctx!.base(req.userId), P.MANAGE_ROLES)) throw new HttpError(403, 'Você precisa de "Gerenciar cargos"');
  q.run('DELETE FROM channel_overwrites WHERE channel_id = ? AND role_id = ?', channel.id, req.params.roleId);
  resyncGuild(channel.guild_id);
  res.status(204).end();
});

channelsRouter.get('/channels/:id/permissions', (req, res) => {
  const access = requireChannel(req.userId, req.params.id, P.MANAGE_CHANNELS);
  if (!access.ctx) throw new HttpError(400, 'Este canal não tem permissões próprias');
  const own = access.ctx.ownOverwrites(access.channel.id);
  res.json({ synced: !own.length && !!access.channel.parent_id, overwrites: access.ctx.overwritesFor(access.channel) });
});

// ---- Group DM recipients ----

channelsRouter.put('/channels/:id/recipients/:userId', (req, res) => {
  const { channel } = requireChannel(req.userId, req.params.id);
  if (channel.type !== 'group_dm') throw new HttpError(400, 'Só é possível adicionar pessoas a grupos');
  const target = getUser(req.params.userId);
  if (!target) throw new HttpError(404, 'Usuário não encontrado');
  const current = recipientIds(channel.id);
  if (current.includes(target.id)) {
    res.status(204).end();
    return;
  }
  if (!areFriends(req.userId, target.id)) throw new HttpError(403, 'Você só pode adicionar amigos ao grupo');
  if (current.length >= MAX_GROUP_SIZE) throw new HttpError(400, `Grupos têm no máximo ${MAX_GROUP_SIZE} pessoas`);
  q.run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', channel.id, target.id);
  const msg = insertSystemMessage(channel.id, req.userId, 'recipient_add', target.id);
  dispatchChannel(reload(channel.id), 'CHANNEL_UPDATE');
  dispatch([target.id], 'CHANNEL_CREATE', privateChannelPayload(reload(channel.id)));
  dispatch(recipientIds(channel.id), 'MESSAGE_CREATE', msg);
  sharePresences(recipientIds(channel.id));
  res.status(204).end();
});

channelsRouter.delete('/channels/:id/recipients/:userId', (req, res) => {
  const { channel } = requireChannel(req.userId, req.params.id);
  if (channel.type !== 'group_dm') throw new HttpError(400, 'Este canal não é um grupo');
  const targetId = req.params.userId === '@me' ? req.userId : req.params.userId;
  if (targetId !== req.userId && channel.owner_id !== req.userId) throw new HttpError(403, 'Só o dono do grupo pode remover pessoas');
  if (!recipientIds(channel.id).includes(targetId)) throw new HttpError(404, 'Essa pessoa não está no grupo');

  q.run('DELETE FROM dm_recipients WHERE channel_id = ? AND user_id = ?', channel.id, targetId);
  if (voiceStates.get(targetId)?.channel_id === channel.id) leaveVoice(targetId);
  dispatch([targetId], 'CHANNEL_DELETE', { id: channel.id, guild_id: null });

  const remaining = recipientIds(channel.id);
  if (!remaining.length) {
    q.run('DELETE FROM channels WHERE id = ?', channel.id);
  } else {
    if (channel.owner_id === targetId) q.run('UPDATE channels SET owner_id = ? WHERE id = ?', remaining[0], channel.id);
    const msg = insertSystemMessage(channel.id, req.userId, 'recipient_remove', targetId);
    dispatchChannel(reload(channel.id), 'CHANNEL_UPDATE');
    dispatch(remaining, 'MESSAGE_CREATE', msg);
  }
  res.status(204).end();
});

// ---- Threads ----

channelsRouter.post('/channels/:id/threads', (req, res) => {
  const { channel: parent } = requireChannel(req.userId, req.params.id, P.CREATE_THREADS);
  if (parent.type !== 'text') throw new HttpError(400, 'Threads só podem ser criadas em canais de texto');
  const name = text(req.body?.name, 'Nome da thread', { max: 100 });
  const messageId = typeof req.body?.message_id === 'string' ? req.body.message_id : null;
  if (messageId) {
    const starter = requireMessage(parent, messageId);
    if (q.get("SELECT 1 FROM channels WHERE type = 'thread' AND starter_message_id = ?", starter.id)) {
      throw new HttpError(409, 'Essa mensagem já tem uma thread');
    }
  }
  const id = snowflake();
  q.run(
    "INSERT INTO channels (id, guild_id, parent_id, type, name, owner_id, starter_message_id, created_at) VALUES (?, ?, ?, 'thread', ?, ?, ?, ?)",
    id,
    parent.guild_id,
    parent.id,
    name,
    req.userId,
    messageId,
    Date.now(),
  );
  const thread = reload(id);
  dispatchChannel(thread, 'CHANNEL_CREATE');
  if (!messageId) {
    const ctx = guildContext(parent.guild_id!)!;
    dispatch(channelAudience(parent, ctx), 'MESSAGE_CREATE', insertSystemMessage(parent.id, req.userId, 'thread_created', id));
  } else {
    // Starter message gains a thread chip: let clients re-render it.
    dispatch(channelAudience(parent), 'MESSAGE_UPDATE', getMessage(messageId));
  }
  res.status(201).json({ id });
});

// ---- Messages ----

channelsRouter.get('/channels/:id/messages', (req, res) => {
  const { channel } = requireMessageable(req.userId, req.params.id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = typeof req.query.before === 'string' ? req.query.before : null;
  const rows = before
    ? q.all<MessageRow>('SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?', channel.id, before, limit)
    : q.all<MessageRow>('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?', channel.id, limit);
  res.json(serializeMessages(rows.reverse()));
});

channelsRouter.post('/channels/:id/messages', limits.messages, uploadFiles.array('files', 10), (req, res) => {
  const { channel, perms, ctx } = requireMessageable(req.userId, String(req.params.id), P.SEND_MESSAGES);
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length && !has(perms, P.ATTACH_FILES)) throw new HttpError(403, 'Você não pode enviar arquivos neste canal');
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (content.length > MAX_CONTENT) throw new HttpError(400, `Mensagens podem ter até ${MAX_CONTENT} caracteres`);
  if (!content && !files.length) throw new HttpError(400, 'A mensagem está vazia');

  let replyTo: string | null = typeof req.body?.reply_to_id === 'string' ? req.body.reply_to_id : null;
  if (replyTo && !q.get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', replyTo, channel.id)) replyTo = null;

  const id = snowflake();
  tx(() => {
    q.run(
      'INSERT INTO messages (id, channel_id, author_id, content, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      channel.id,
      req.userId,
      content,
      replyTo,
      Date.now(),
    );
    for (const f of files) {
      q.run(
        'INSERT INTO attachments (id, message_id, filename, url, content_type, size) VALUES (?, ?, ?, ?, ?, ?)',
        snowflake(),
        id,
        originalName(f),
        publicUrl(f),
        f.mimetype || null,
        f.size,
      );
    }
    markRead(req.userId, channel.id, id);
    if (channel.type === 'thread' && channel.archived) q.run('UPDATE channels SET archived = 0 WHERE id = ?', channel.id);
  });

  if (channel.type === 'thread') dispatchChannel(reload(channel.id), 'CHANNEL_UPDATE'); // message count / unarchive
  const message = getMessage(id)!;
  dispatch(channelAudience(channel, ctx), 'MESSAGE_CREATE', message);
  scheduleEmbeds({ id, channel_id: channel.id, content });
  res.status(201).json(message);
});

channelsRouter.patch('/channels/:id/messages/:messageId', (req, res) => {
  const { channel, ctx } = requireMessageable(req.userId, req.params.id);
  const message = requireMessage(channel, req.params.messageId);
  if (message.author_id !== req.userId || message.type !== 'default') throw new HttpError(403, 'Você só pode editar suas mensagens');
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) throw new HttpError(400, 'A mensagem está vazia');
  if (content.length > MAX_CONTENT) throw new HttpError(400, `Mensagens podem ter até ${MAX_CONTENT} caracteres`);
  q.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', content, Date.now(), message.id);
  const updated = getMessage(message.id)!;
  dispatch(channelAudience(channel, ctx), 'MESSAGE_UPDATE', updated);
  scheduleEmbeds({ id: message.id, channel_id: channel.id, content });
  res.json(updated);
});

channelsRouter.delete('/channels/:id/messages/:messageId', (req, res) => {
  const { channel, perms, ctx } = requireMessageable(req.userId, req.params.id);
  const message = requireMessage(channel, req.params.messageId);
  const moderator = !!channel.guild_id && has(perms, P.MANAGE_MESSAGES);
  if (message.author_id !== req.userId && !moderator) throw new HttpError(403, 'Você não pode excluir essa mensagem');
  const files = q.all<{ url: string }>('SELECT url FROM attachments WHERE message_id = ?', message.id);
  q.run('DELETE FROM messages WHERE id = ?', message.id);
  for (const f of files) removeUpload(f.url);
  dispatch(channelAudience(channel, ctx), 'MESSAGE_DELETE', { id: message.id, channel_id: channel.id });
  res.status(204).end();
});

// ---- Reactions ----

function reactionEmoji(raw: string): string {
  const emoji = raw.trim();
  if (!emoji || [...emoji].length > 16) throw new HttpError(400, 'Emoji inválido');
  return emoji;
}

channelsRouter.put('/channels/:id/messages/:messageId/reactions/:emoji', (req, res) => {
  const { channel, perms, ctx } = requireMessageable(req.userId, req.params.id);
  const message = requireMessage(channel, req.params.messageId);
  const emoji = reactionEmoji(req.params.emoji);
  const exists = !!q.get('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?', message.id, emoji);
  // Joining an existing reaction is always allowed; adding a new one needs ADD_REACTIONS.
  if (!exists && !has(perms, P.ADD_REACTIONS)) throw new HttpError(403, 'Você não pode adicionar reações aqui');
  const result = q.run(
    'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
    message.id,
    req.userId,
    emoji,
    Date.now(),
  );
  if (result.changes) {
    dispatch(channelAudience(channel, ctx), 'MESSAGE_REACTION_ADD', {
      channel_id: channel.id,
      message_id: message.id,
      user_id: req.userId,
      emoji,
    });
  }
  res.status(204).end();
});

channelsRouter.delete('/channels/:id/messages/:messageId/reactions/:emoji', (req, res) => {
  const { channel, ctx } = requireMessageable(req.userId, req.params.id);
  const message = requireMessage(channel, req.params.messageId);
  const emoji = reactionEmoji(req.params.emoji);
  const result = q.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', message.id, req.userId, emoji);
  if (result.changes) {
    dispatch(channelAudience(channel, ctx), 'MESSAGE_REACTION_REMOVE', {
      channel_id: channel.id,
      message_id: message.id,
      user_id: req.userId,
      emoji,
    });
  }
  res.status(204).end();
});

// ---- Pins ----

channelsRouter.get('/channels/:id/pins', (req, res) => {
  const { channel } = requireMessageable(req.userId, req.params.id);
  const rows = q.all<MessageRow>('SELECT * FROM messages WHERE channel_id = ? AND pinned = 1 ORDER BY id DESC', channel.id);
  res.json(serializeMessages(rows));
});

function setPinned(req: { userId: string; params: Record<string, string> }, pinned: boolean) {
  const { channel, perms, ctx } = requireMessageable(req.userId, req.params.id);
  if (!isPrivate(channel) && !has(perms, P.MANAGE_MESSAGES)) throw new HttpError(403, 'Você não pode fixar mensagens aqui');
  const message = requireMessage(channel, req.params.messageId);
  q.run('UPDATE messages SET pinned = ? WHERE id = ?', pinned ? 1 : 0, message.id);
  dispatch(channelAudience(channel, ctx), 'MESSAGE_UPDATE', getMessage(message.id));
}

channelsRouter.put('/channels/:id/pins/:messageId', (req, res) => {
  setPinned(req, true);
  res.status(204).end();
});

channelsRouter.delete('/channels/:id/pins/:messageId', (req, res) => {
  setPinned(req, false);
  res.status(204).end();
});

// ---- Typing, read state & search ----

channelsRouter.post('/channels/:id/typing', limits.typing, (req, res) => {
  const { channel, ctx } = requireMessageable(req.userId, String(req.params.id), P.SEND_MESSAGES);
  const audience = channelAudience(channel, ctx).filter((id) => id !== req.userId);
  dispatch(audience, 'TYPING_START', { channel_id: channel.id, user_id: req.userId, timestamp: Date.now() });
  res.status(204).end();
});

channelsRouter.post('/channels/:id/ack', (req, res) => {
  const { channel } = requireMessageable(req.userId, req.params.id);
  const messageId = String(req.body?.message_id ?? '');
  if (!messageId) throw new HttpError(400, 'message_id é obrigatório');
  markRead(req.userId, channel.id, messageId);
  dispatch([req.userId], 'MESSAGE_ACK', { channel_id: channel.id, message_id: messageId });
  res.status(204).end();
});

channelsRouter.get('/channels/:id/messages/search', (req, res) => {
  const { channel } = requireMessageable(req.userId, req.params.id);
  const query = String(req.query.q ?? '').trim();
  if (!query) {
    res.json([]);
    return;
  }
  const like = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = q.all<MessageRow>(
    "SELECT * FROM messages WHERE channel_id = ? AND type = 'default' AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50",
    channel.id,
    like,
  );
  res.json(serializeMessages(rows));
});
