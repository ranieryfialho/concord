import { Router } from 'express';
import { deleteSessions, hashPassword, verifyPassword } from '../auth.js';
import { issueRecoveryCode } from '../recovery.js';
import { q, tx } from '../db.js';
import { type ChannelRow, type UserRow, getUser, privateUser, publicUser } from '../models.js';
import { limits } from '../ratelimit.js';
import { privateChannelPayload } from '../ready.js';
import { activitiesOf, broadcastPresence, dispatch, presenceAudience, presenceOf } from '../realtime.js';
import { publicUrl, removeUpload, uploadImage } from '../uploads.js';
import { HttpError, optionalText, snowflake, text } from '../util.js';

export const usersRouter = Router();

const STATUSES = new Set(['online', 'idle', 'dnd', 'invisible']);
export const MAX_GROUP_SIZE = 10;

function broadcastUser(userId: string) {
  const user = getUser(userId)!;
  dispatch([...presenceAudience(userId), userId], 'USER_UPDATE', publicUser(user));
  return user;
}

export function areFriends(a: string, b: string): boolean {
  return q.get<{ type: string }>('SELECT type FROM relationships WHERE user_id = ? AND target_id = ?', a, b)?.type === 'friend';
}

/** Makes sure everyone sharing a private channel can see each other's presence. */
export function sharePresences(userIds: string[]) {
  for (const id of userIds) {
    const u = getUser(id);
    if (!u) continue;
    dispatch(
      userIds.filter((x) => x !== id),
      'PRESENCE_UPDATE',
      { user_id: id, status: presenceOf(id, u.status), activities: activitiesOf(id, u.status) },
    );
  }
}

usersRouter.get('/users/@me', (req, res) => {
  res.json(privateUser(getUser(req.userId)!));
});

usersRouter.post('/users/@me/password', limits.password, (req, res) => {
  const current = text(req.body?.current_password, 'Senha atual', { max: 128 });
  const next = text(req.body?.new_password, 'Nova senha', { min: 6, max: 128 });
  const user = getUser(req.userId)!;
  if (!verifyPassword(current, user.password_hash)) throw new HttpError(403, 'Senha atual incorreta');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), user.id);
  deleteSessions(user.id, String(req.headers.authorization)); // sign out everywhere else
  res.status(204).end();
});

// Replaces the recovery code (also how accounts created before codes existed get one).
usersRouter.post('/users/@me/recovery-code', limits.password, (req, res) => {
  const password = text(req.body?.password, 'Senha', { max: 128 });
  if (!verifyPassword(password, getUser(req.userId)!.password_hash)) throw new HttpError(403, 'Senha incorreta');
  res.json({ recovery_code: issueRecoveryCode(req.userId) });
});

usersRouter.patch('/users/@me', (req, res) => {
  const before = getUser(req.userId)!;
  const displayName = optionalText(req.body?.display_name, 'Nome de exibição', 32);
  const customStatus = optionalText(req.body?.custom_status, 'Status personalizado', 128);
  const status = req.body?.status;
  if (status !== undefined && !STATUSES.has(status)) throw new HttpError(400, 'Status inválido');

  q.run(
    `UPDATE users SET
       display_name = CASE WHEN ? THEN ? ELSE display_name END,
       custom_status = CASE WHEN ? THEN ? ELSE custom_status END,
       status = COALESCE(?, status)
     WHERE id = ?`,
    displayName !== undefined ? 1 : 0,
    displayName ?? null,
    customStatus !== undefined ? 1 : 0,
    customStatus ?? null,
    status ?? null,
    req.userId,
  );
  const user = broadcastUser(req.userId);
  if (status && status !== before.status) broadcastPresence(req.userId);
  res.json(privateUser(user));
});

usersRouter.post('/users/@me/avatar', limits.uploads, uploadImage.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'Envie uma imagem PNG, JPG, GIF ou WEBP');
  const before = getUser(req.userId)!;
  q.run('UPDATE users SET avatar_url = ? WHERE id = ?', publicUrl(req.file), req.userId);
  removeUpload(before.avatar_url);
  res.json(privateUser(broadcastUser(req.userId)));
});

usersRouter.delete('/users/@me/avatar', (req, res) => {
  const before = getUser(req.userId)!;
  q.run('UPDATE users SET avatar_url = NULL WHERE id = ?', req.userId);
  removeUpload(before.avatar_url);
  res.json(privateUser(broadcastUser(req.userId)));
});

usersRouter.get('/users/:id', (req, res) => {
  const user = getUser(req.params.id);
  if (!user) throw new HttpError(404, 'Usuário não encontrado');
  const mutualGuilds = q
    .all<{ guild_id: string }>(
      'SELECT a.guild_id FROM members a JOIN members b ON a.guild_id = b.guild_id WHERE a.user_id = ? AND b.user_id = ?',
      req.userId,
      user.id,
    )
    .map((r) => r.guild_id);
  res.json({ ...publicUser(user), created_at: user.created_at, mutual_guild_ids: mutualGuilds });
});

// ---- Direct messages & group DMs ----

function existingDm(a: string, b: string): ChannelRow | undefined {
  return q.get<ChannelRow>(
    `SELECT c.* FROM channels c
     JOIN dm_recipients x ON x.channel_id = c.id AND x.user_id = ?
     JOIN dm_recipients y ON y.channel_id = c.id AND y.user_id = ?
     WHERE c.type = 'dm'`,
    a,
    b,
  );
}

usersRouter.post('/users/@me/channels', (req, res) => {
  const raw: unknown[] = Array.isArray(req.body?.recipient_ids) ? req.body.recipient_ids : [req.body?.recipient_id];
  const others = [...new Set(raw.map(String).filter((id) => id && id !== req.userId))];
  if (!others.length) throw new HttpError(400, 'Escolha pelo menos uma pessoa');
  for (const id of others) if (!getUser(id)) throw new HttpError(404, 'Usuário não encontrado');

  const isGroup = Array.isArray(req.body?.recipient_ids) && others.length > 1;
  if (!isGroup) {
    const existing = existingDm(req.userId, others[0]);
    if (existing) {
      res.json(privateChannelPayload(existing));
      return;
    }
  } else {
    if (others.length + 1 > MAX_GROUP_SIZE) throw new HttpError(400, `Grupos têm no máximo ${MAX_GROUP_SIZE} pessoas`);
    for (const id of others) if (!areFriends(req.userId, id)) throw new HttpError(403, 'Você só pode adicionar amigos a um grupo');
  }

  const id = snowflake();
  const members = [req.userId, ...others];
  tx(() => {
    q.run(
      'INSERT INTO channels (id, type, owner_id, created_at) VALUES (?, ?, ?, ?)',
      id,
      isGroup ? 'group_dm' : 'dm',
      isGroup ? req.userId : null,
      Date.now(),
    );
    for (const uid of members) q.run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', id, uid);
  });
  const channel = privateChannelPayload(q.get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id)!);
  dispatch(members, 'CHANNEL_CREATE', channel);
  sharePresences(members);
  res.status(201).json(channel);
});

// ---- Friends ----

function relationshipPayload(type: string, user: UserRow) {
  return { type, user: publicUser(user) };
}

function notifyRelationship(a: UserRow, b: UserRow) {
  for (const [self, other] of [
    [a, b],
    [b, a],
  ] as const) {
    const rel = q.get<{ type: string }>('SELECT type FROM relationships WHERE user_id = ? AND target_id = ?', self.id, other.id);
    if (rel) {
      dispatch([self.id], 'RELATIONSHIP_ADD', relationshipPayload(rel.type, other));
      dispatch([self.id], 'PRESENCE_UPDATE', {
        user_id: other.id,
        status: presenceOf(other.id, other.status),
        activities: activitiesOf(other.id, other.status),
      });
    } else {
      dispatch([self.id], 'RELATIONSHIP_REMOVE', { id: other.id });
    }
  }
}

function setRelationship(userId: string, targetId: string, type: string) {
  q.run(
    `INSERT INTO relationships (user_id, target_id, type, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, target_id) DO UPDATE SET type = excluded.type`,
    userId,
    targetId,
    type,
    Date.now(),
  );
}

usersRouter.post('/users/@me/relationships', limits.friendRequests, (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const target = q.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  if (!target) throw new HttpError(404, 'Nenhum usuário com esse nome. Confira a grafia.');
  if (target.id === req.userId) throw new HttpError(400, 'Você não pode adicionar a si mesmo');

  const mine = q.get<{ type: string }>('SELECT type FROM relationships WHERE user_id = ? AND target_id = ?', req.userId, target.id);
  if (mine?.type === 'friend') throw new HttpError(409, 'Vocês já são amigos');

  tx(() => {
    if (mine?.type === 'pending_in') {
      setRelationship(req.userId, target.id, 'friend');
      setRelationship(target.id, req.userId, 'friend');
    } else {
      setRelationship(req.userId, target.id, 'pending_out');
      setRelationship(target.id, req.userId, 'pending_in');
    }
  });
  notifyRelationship(getUser(req.userId)!, target);
  res.status(204).end();
});

usersRouter.put('/users/@me/relationships/:id', (req, res) => {
  const target = getUser(req.params.id);
  const mine = q.get<{ type: string }>('SELECT type FROM relationships WHERE user_id = ? AND target_id = ?', req.userId, req.params.id);
  if (!target || mine?.type !== 'pending_in') throw new HttpError(404, 'Pedido de amizade não encontrado');
  tx(() => {
    setRelationship(req.userId, target.id, 'friend');
    setRelationship(target.id, req.userId, 'friend');
  });
  notifyRelationship(getUser(req.userId)!, target);
  res.status(204).end();
});

usersRouter.delete('/users/@me/relationships/:id', (req, res) => {
  const target = getUser(req.params.id);
  if (!target) throw new HttpError(404, 'Usuário não encontrado');
  q.run(
    'DELETE FROM relationships WHERE (user_id = ? AND target_id = ?) OR (user_id = ? AND target_id = ?)',
    req.userId,
    target.id,
    target.id,
    req.userId,
  );
  notifyRelationship(getUser(req.userId)!, target);
  res.status(204).end();
});
