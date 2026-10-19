import { placeholders, q, qAll } from './db.js';

export type ChannelType = 'text' | 'voice' | 'category' | 'dm' | 'group_dm' | 'thread';
export type MessageType = 'default' | 'recipient_add' | 'recipient_remove' | 'call' | 'thread_created' | 'channel_name_change';

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  avatar_url: string | null;
  status: string;
  custom_status: string | null;
  created_at: number;
}

export interface GuildRow {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  created_at: number;
}

export interface MemberRow {
  guild_id: string;
  user_id: string;
  nickname: string | null;
  joined_at: number;
}

export interface ChannelRow {
  id: string;
  guild_id: string | null;
  parent_id: string | null;
  type: ChannelType;
  name: string | null;
  topic: string | null;
  position: number;
  created_at: number;
  owner_id: string | null;
  icon_url: string | null;
  archived: number;
  starter_message_id: string | null;
}

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  type: MessageType;
  content: string;
  reply_to_id: string | null;
  pinned: number;
  edited_at: number | null;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  url: string;
  content_type: string | null;
  size: number;
}

export interface EmbedRow {
  message_id: string;
  position: number;
  type: 'link' | 'image';
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_url: string | null;
  color: string | null;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    custom_status: u.custom_status,
  };
}

export type PublicUser = ReturnType<typeof publicUser>;

export function privateUser(u: UserRow) {
  return { ...publicUser(u), status: u.status };
}

export function getUser(id: string): UserRow | undefined {
  return q.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
}

export function usersByIds(ids: string[]): Map<string, UserRow> {
  const map = new Map<string, UserRow>();
  if (!ids.length) return map;
  for (const r of qAll<UserRow>(`SELECT * FROM users WHERE id IN (${placeholders(ids.length)})`, ids)) map.set(r.id, r);
  return map;
}

export function serializeMember(m: MemberRow, user: UserRow, roleIds: string[]) {
  return {
    guild_id: m.guild_id,
    user: publicUser(user),
    role_ids: roleIds,
    nickname: m.nickname,
    joined_at: m.joined_at,
  };
}

export function lastMessageId(channelId: string): string | null {
  return q.get<{ id: string | null }>('SELECT MAX(id) AS id FROM messages WHERE channel_id = ?', channelId)?.id ?? null;
}

export function serializeChannel(c: ChannelRow) {
  const base = {
    id: c.id,
    guild_id: c.guild_id,
    parent_id: c.parent_id,
    type: c.type,
    name: c.name,
    topic: c.topic,
    position: c.position,
    owner_id: c.owner_id,
    icon_url: c.icon_url,
    archived: !!c.archived,
    starter_message_id: c.starter_message_id,
    created_at: c.created_at,
    last_message_id: lastMessageId(c.id),
  };
  if (c.type === 'thread') {
    const n = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', c.id)!.n;
    return { ...base, message_count: n };
  }
  if (c.type !== 'dm' && c.type !== 'group_dm') return base;
  const recipients = q
    .all<UserRow>('SELECT u.* FROM users u JOIN dm_recipients r ON r.user_id = u.id WHERE r.channel_id = ?', c.id)
    .map(publicUser);
  return { ...base, recipients };
}

export function serializeMessages(rows: MessageRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = placeholders(ids.length);

  const attachments = qAll<AttachmentRow>(`SELECT * FROM attachments WHERE message_id IN (${ph})`, ids);
  const reactions = qAll<{ message_id: string; user_id: string; emoji: string }>(
    `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${ph}) ORDER BY created_at`,
    ids,
  );
  const embeds = qAll<EmbedRow>(`SELECT * FROM embeds WHERE message_id IN (${ph}) ORDER BY position`, ids);

  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => !!x))];
  const replies = replyIds.length ? qAll<MessageRow>(`SELECT * FROM messages WHERE id IN (${placeholders(replyIds.length)})`, replyIds) : [];
  const replyMap = new Map(replies.map((r) => [r.id, r]));

  const userIds = new Set(rows.map((r) => r.author_id));
  for (const r of replies) userIds.add(r.author_id);
  // System messages reference other users in their content (recipient add/remove).
  for (const r of rows) if (r.type === 'recipient_add' || r.type === 'recipient_remove') userIds.add(r.content);
  const users = usersByIds([...userIds]);

  return rows.map((m) => {
    const grouped = new Map<string, string[]>();
    for (const r of reactions) {
      if (r.message_id !== m.id) continue;
      const list = grouped.get(r.emoji) ?? [];
      list.push(r.user_id);
      grouped.set(r.emoji, list);
    }
    const reply = m.reply_to_id ? replyMap.get(m.reply_to_id) : undefined;
    const replyAuthor = reply ? users.get(reply.author_id) : undefined;
    const mentioned = m.type === 'recipient_add' || m.type === 'recipient_remove' ? users.get(m.content) : undefined;
    return {
      id: m.id,
      channel_id: m.channel_id,
      type: m.type,
      author: publicUser(users.get(m.author_id)!),
      content: m.content,
      target_user: mentioned ? publicUser(mentioned) : null,
      reply_to_id: m.reply_to_id,
      reply_to: reply && replyAuthor ? { id: reply.id, author: publicUser(replyAuthor), content: reply.content.slice(0, 200) } : null,
      pinned: !!m.pinned,
      edited_at: m.edited_at,
      created_at: m.created_at,
      attachments: attachments
        .filter((a) => a.message_id === m.id)
        .map((a) => ({ id: a.id, filename: a.filename, url: a.url, content_type: a.content_type, size: a.size })),
      reactions: [...grouped].map(([emoji, user_ids]) => ({ emoji, user_ids })),
      embeds: embeds
        .filter((e) => e.message_id === m.id)
        .map((e) => ({
          type: e.type,
          url: e.url,
          title: e.title,
          description: e.description,
          site_name: e.site_name,
          image_url: e.image_url,
          color: e.color,
        })),
    };
  });
}

export function getMessage(id: string) {
  const row = q.get<MessageRow>('SELECT * FROM messages WHERE id = ?', id);
  return row ? serializeMessages([row])[0] : undefined;
}
