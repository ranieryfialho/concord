import { q } from './db.js';
import {
  type ChannelRow,
  type GuildRow,
  type MemberRow,
  type UserRow,
  privateUser,
  publicUser,
  serializeChannel,
  serializeMember,
} from './models.js';
import { DM_PERMISSIONS, GuildContext, P, type RoleRow } from './permissions.js';
import type { Activity } from './activities.js';
import { activitiesOf, callPayload, calls, presenceOf, voiceStates } from './realtime.js';
import { clientBuild } from './version.js';

export function serializeRole(r: RoleRow) {
  return {
    id: r.id,
    guild_id: r.guild_id,
    name: r.name,
    color: r.color,
    permissions: r.permissions,
    position: r.position,
    hoist: !!r.hoist,
  };
}

/** A guild as seen by one member: only channels they can view, with their computed permissions. */
export function guildPayload(guild: GuildRow, userId: string, ctx: GuildContext = new GuildContext(guild)) {
  const visible = [...ctx.channels.values()]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((c) => ({ c, perms: ctx.channel(c, userId) }))
    .filter(({ perms }) => perms & P.VIEW_CHANNEL);
  const visibleIds = new Set(visible.map(({ c }) => c.id));

  const memberRows = q.all<MemberRow & UserRow>(
    'SELECT m.guild_id, m.nickname, m.joined_at, m.user_id, u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? ORDER BY m.joined_at',
    guild.id,
  );
  const presences: Record<string, string> = {};
  const activities: Record<string, Activity[]> = {};
  const members = memberRows.map((row) => {
    presences[row.id] = presenceOf(row.id, row.status);
    const acts = activitiesOf(row.id, row.status);
    if (acts.length) activities[row.id] = acts;
    return serializeMember(row, row, ctx.memberRoles.get(row.id) ?? []);
  });

  return {
    ...guild,
    permissions: ctx.base(userId),
    channels: visible.map(({ c, perms }) => ({ ...serializeChannel(c), permissions: perms })),
    roles: [...ctx.roles.values()].map(serializeRole),
    members,
    presences,
    activities,
    voice_states: [...voiceStates.values()].filter((s) => s.guild_id === guild.id && visibleIds.has(s.channel_id)),
  };
}

export function privateChannelPayload(c: ChannelRow) {
  return { ...serializeChannel(c), permissions: DM_PERMISSIONS };
}

export function buildReady(user: UserRow) {
  const guilds = q
    .all<GuildRow>(
      'SELECT g.* FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at',
      user.id,
    )
    .map((g) => guildPayload(g, user.id));

  const privateRows = q.all<ChannelRow>(
    'SELECT c.* FROM channels c JOIN dm_recipients r ON r.channel_id = c.id WHERE r.user_id = ?',
    user.id,
  );
  const privateChannels = privateRows.map(privateChannelPayload);
  const privateIds = new Set(privateRows.map((c) => c.id));

  const relationships = q
    .all<UserRow & { rel_type: string }>(
      'SELECT r.type AS rel_type, u.* FROM relationships r JOIN users u ON u.id = r.target_id WHERE r.user_id = ?',
      user.id,
    )
    .map((row) => ({ type: row.rel_type, user: publicUser(row) }));

  const presences: Record<string, string> = {};
  const activities: Record<string, Activity[]> = {};
  for (const g of guilds) {
    Object.assign(presences, g.presences);
    Object.assign(activities, g.activities);
  }
  const others = q.all<{ id: string; status: string }>(
    `SELECT u.id, u.status FROM users u WHERE u.id IN (
       SELECT target_id FROM relationships WHERE user_id = ?
       UNION SELECT r2.user_id FROM dm_recipients r1 JOIN dm_recipients r2 ON r1.channel_id = r2.channel_id WHERE r1.user_id = ?
     )`,
    user.id,
    user.id,
  );
  for (const o of others) {
    presences[o.id] = presenceOf(o.id, o.status);
    const acts = activitiesOf(o.id, o.status);
    if (acts.length) activities[o.id] = acts;
  }

  const readStates: Record<string, string> = {};
  for (const r of q.all<{ channel_id: string; last_read_id: string }>(
    'SELECT channel_id, last_read_id FROM read_states WHERE user_id = ?',
    user.id,
  )) {
    readStates[r.channel_id] = r.last_read_id;
  }

  // Unread mentions in guild channels, plus every unread message in DMs (same as Discord's badge).
  const visible = new Set<string>(privateIds);
  for (const g of guilds) for (const c of g.channels) visible.add(c.id);
  const mentionCounts: Record<string, number> = {};
  const counts = q.all<{ channel_id: string; n: number }>(
    `SELECT m.channel_id, COUNT(*) AS n FROM messages m
     JOIN channels c ON c.id = m.channel_id
     LEFT JOIN read_states rs ON rs.channel_id = m.channel_id AND rs.user_id = ?
     WHERE m.author_id != ? AND m.type = 'default'
       AND (rs.last_read_id IS NULL OR m.id > rs.last_read_id)
       AND (
         (c.type IN ('dm', 'group_dm') AND c.id IN (SELECT channel_id FROM dm_recipients WHERE user_id = ?))
         OR (c.guild_id IN (SELECT guild_id FROM members WHERE user_id = ?) AND m.content LIKE ?)
       )
     GROUP BY m.channel_id`,
    user.id,
    user.id,
    user.id,
    user.id,
    `%<@${user.id}>%`,
  );
  for (const c of counts) if (visible.has(c.channel_id)) mentionCounts[c.channel_id] = c.n;

  const voice = [...voiceStates.values()].filter((s) => visible.has(s.channel_id));

  return {
    user: privateUser(user),
    guilds,
    private_channels: privateChannels,
    relationships,
    presences,
    activities,
    read_states: readStates,
    mention_counts: mentionCounts,
    voice_states: voice,
    calls: [...calls.values()].filter((c) => privateIds.has(c.channel_id)).map(callPayload),
    client_build: clientBuild(),
  };
}
