import { WebSocket } from 'ws';
import { q } from './db.js';
import { type ChannelRow, getMessage } from './models.js';
import { channelAudience, getChannel, recipientIds } from './permissions.js';
import type { Activity } from './activities.js';
import { snowflake } from './util.js';

export interface Conn {
  ws: WebSocket;
  userId: string;
  alive: boolean;
  /** Reported by this connection (the desktop app); see activities.ts. */
  activities?: Activity[];
}

export interface VoiceState {
  user_id: string;
  guild_id: string | null;
  channel_id: string;
  self_mute: boolean;
  self_deaf: boolean;
  /** Away from keyboard: shown as a tag; the client also mutes and deafens itself. */
  self_afk: boolean;
  self_video: boolean;
  self_stream: boolean;
  /** A moderator muted this member (MUTE_MEMBERS). Cleared when they leave the channel. */
  server_mute: boolean;
  /** A moderator deafened this member (MUTE_MEMBERS): they hear nothing. Cleared when they leave. */
  server_deaf: boolean;
  /** Cannot transmit audio: lacks SPEAK or is server-muted. */
  suppress: boolean;
}

export const connections = new Map<string, Set<Conn>>();
export const voiceStates = new Map<string, VoiceState>();
// The single connection (device) that owns a user's voice session.
export const voiceConns = new Map<string, Conn>();

export function send(conn: Conn, t: string, d: unknown) {
  if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify({ op: 'dispatch', t, d }));
}

export function dispatch(userIds: Iterable<string>, t: string, d: unknown) {
  const payload = JSON.stringify({ op: 'dispatch', t, d });
  for (const id of new Set(userIds)) {
    for (const conn of connections.get(id) ?? []) {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(payload);
    }
  }
}

export function presenceOf(userId: string, status: string): string {
  if (!connections.has(userId) || status === 'invisible') return 'offline';
  return status;
}

/** Everything the user's connections report, hidden while they appear offline. */
export function activitiesOf(userId: string, status: string): Activity[] {
  if (presenceOf(userId, status) === 'offline') return [];
  return [...(connections.get(userId) ?? [])].flatMap((c) => c.activities ?? []).slice(0, 3);
}

/** Everyone who should see this user's presence: guild co-members, relationships and DM partners. */
export function presenceAudience(userId: string): string[] {
  return q
    .all<{ id: string }>(
      `SELECT m2.user_id AS id FROM members m1 JOIN members m2 ON m1.guild_id = m2.guild_id WHERE m1.user_id = ?
       UNION SELECT target_id AS id FROM relationships WHERE user_id = ?
       UNION SELECT r2.user_id AS id FROM dm_recipients r1 JOIN dm_recipients r2 ON r1.channel_id = r2.channel_id WHERE r1.user_id = ?`,
      userId,
      userId,
      userId,
    )
    .map((r) => r.id);
}

export function broadcastPresence(userId: string) {
  const user = q.get<{ status: string }>('SELECT status FROM users WHERE id = ?', userId);
  if (!user) return;
  dispatch([...presenceAudience(userId), userId], 'PRESENCE_UPDATE', {
    user_id: userId,
    status: presenceOf(userId, user.status),
    activities: activitiesOf(userId, user.status),
  });
}

// ---------- Voice ----------

function voiceAudience(channelId: string): string[] {
  const channel = getChannel(channelId);
  return channel ? channelAudience(channel) : [];
}

export function setVoiceState(state: VoiceState) {
  voiceStates.set(state.user_id, state);
  dispatch([...voiceAudience(state.channel_id), state.user_id], 'VOICE_STATE_UPDATE', state);
}

/** Called with a channel id when the last person leaves its voice session. */
export const channelEmptyHooks: ((channelId: string) => void)[] = [];

export function leaveVoice(userId: string) {
  const state = voiceStates.get(userId);
  voiceConns.delete(userId);
  if (!state) return;
  voiceStates.delete(userId);
  // Also notify the leaving user: they may have just lost access to the channel.
  dispatch([...voiceAudience(state.channel_id), userId], 'VOICE_STATE_UPDATE', { ...state, channel_id: null });
  endCallIfEmpty(state.channel_id);
  if (!usersInVoiceChannel(state.channel_id).length) for (const hook of channelEmptyHooks) hook(state.channel_id);
}

export function leaveVoiceWhere(predicate: (s: VoiceState) => boolean) {
  for (const s of [...voiceStates.values()]) if (predicate(s)) leaveVoice(s.user_id);
}

export function usersInVoiceChannel(channelId: string): string[] {
  return [...voiceStates.values()].filter((s) => s.channel_id === channelId).map((s) => s.user_id);
}

// ---------- Private calls (voice in DMs and group DMs) ----------

interface Call {
  channel_id: string;
  ringing: Set<string>;
  timer: ReturnType<typeof setTimeout>;
}

const RING_MS = 45_000;
export const calls = new Map<string, Call>();

export function callPayload(call: Call) {
  return { channel_id: call.channel_id, ringing: [...call.ringing] };
}

export function insertSystemMessage(channelId: string, authorId: string, type: string, content = '') {
  const id = snowflake();
  q.run(
    'INSERT INTO messages (id, channel_id, author_id, type, content, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id,
    channelId,
    authorId,
    type,
    content,
    Date.now(),
  );
  return getMessage(id)!;
}

/** Called after someone joins voice in a DM: starts ringing the others, or stops ringing the joiner. */
export function onPrivateVoiceJoin(channel: ChannelRow, userId: string) {
  const recipients = recipientIds(channel.id);
  const existing = calls.get(channel.id);
  if (existing) {
    if (existing.ringing.delete(userId)) dispatch(recipients, 'CALL_UPDATE', callPayload(existing));
    return;
  }
  const inCall = new Set(usersInVoiceChannel(channel.id));
  const call: Call = {
    channel_id: channel.id,
    ringing: new Set(recipients.filter((id) => !inCall.has(id))),
    timer: setTimeout(() => {
      call.ringing.clear();
      dispatch(recipientIds(channel.id), 'CALL_UPDATE', callPayload(call));
    }, RING_MS),
  };
  calls.set(channel.id, call);
  dispatch(recipients, 'CALL_CREATE', callPayload(call));
  dispatch(recipients, 'MESSAGE_CREATE', insertSystemMessage(channel.id, userId, 'call'));
}

export function declineCall(channelId: string, userId: string) {
  const call = calls.get(channelId);
  if (call?.ringing.delete(userId)) dispatch(recipientIds(channelId), 'CALL_UPDATE', callPayload(call));
}

export function ringAgain(channelId: string, userIds: string[]) {
  const call = calls.get(channelId);
  if (!call) return;
  const inCall = new Set(usersInVoiceChannel(channelId));
  for (const id of userIds) if (!inCall.has(id)) call.ringing.add(id);
  dispatch(recipientIds(channelId), 'CALL_UPDATE', callPayload(call));
}

function endCallIfEmpty(channelId: string) {
  const call = calls.get(channelId);
  if (!call || usersInVoiceChannel(channelId).length) return;
  clearTimeout(call.timer);
  calls.delete(channelId);
  dispatch(recipientIds(channelId), 'CALL_DELETE', { channel_id: channelId });
}
