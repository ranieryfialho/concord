import type http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { sanitizeActivities } from './activities.js';
import { userFromToken } from './auth.js';
import { P, channelPermissions, getChannel, has } from './permissions.js';
import { Limiter } from './ratelimit.js';
import { buildReady } from './ready.js';
import {
  type Conn,
  broadcastPresence,
  connections,
  declineCall,
  leaveVoice,
  onPrivateVoiceJoin,
  ringAgain,
  send,
  setVoiceState,
  voiceConns,
  voiceStates,
} from './realtime.js';

interface ClientMessage {
  op: string;
  d?: Record<string, unknown>;
}

// Generous enough for ICE candidate bursts when joining a busy voice channel.
const opLimiter = new Limiter(400, 10_000);

function handleOp(conn: Conn, msg: ClientMessage) {
  const d = msg.d ?? {};
  switch (msg.op) {
    case 'heartbeat':
      conn.ws.send(JSON.stringify({ op: 'heartbeat_ack' }));
      return;

    case 'voice_join': {
      const channel = typeof d.channel_id === 'string' ? getChannel(d.channel_id) : undefined;
      if (!channel) return;
      const isPrivate = channel.type === 'dm' || channel.type === 'group_dm';
      if (channel.type !== 'voice' && !isPrivate) return;
      const perms = channelPermissions(channel, conn.userId);
      if (!has(perms, P.CONNECT)) return;
      const previous = voiceStates.get(conn.userId);
      if (previous && previous.channel_id !== channel.id) leaveVoice(conn.userId);
      voiceConns.set(conn.userId, conn);
      setVoiceState({
        user_id: conn.userId,
        guild_id: channel.guild_id,
        channel_id: channel.id,
        self_mute: !!d.self_mute,
        self_deaf: !!d.self_deaf,
        self_afk: !!d.self_afk,
        self_video: false,
        self_stream: false,
        server_mute: false,
        server_deaf: false,
        suppress: !has(perms, P.SPEAK),
      });
      if (isPrivate) onPrivateVoiceJoin(channel, conn.userId);
      return;
    }

    case 'voice_leave':
      if (voiceConns.get(conn.userId) === conn) leaveVoice(conn.userId);
      return;

    case 'voice_update': {
      const state = voiceStates.get(conn.userId);
      if (!state || voiceConns.get(conn.userId) !== conn) return;
      const channel = getChannel(state.channel_id);
      const canStream = !!channel && has(channelPermissions(channel, conn.userId), P.STREAM);
      const bool = (key: string, current: boolean) => (typeof d[key] === 'boolean' ? (d[key] as boolean) : current);
      setVoiceState({
        ...state,
        self_mute: bool('self_mute', state.self_mute),
        self_deaf: bool('self_deaf', state.self_deaf),
        self_afk: bool('self_afk', state.self_afk),
        self_video: canStream && bool('self_video', state.self_video),
        self_stream: canStream && bool('self_stream', state.self_stream),
      });
      return;
    }

    case 'voice_signal': {
      // WebRTC signaling relay: only between peers in the same voice channel.
      const to = typeof d.to === 'string' ? d.to : '';
      const mine = voiceStates.get(conn.userId);
      const theirs = voiceStates.get(to);
      if (!mine || !theirs || mine.channel_id !== theirs.channel_id) return;
      if (voiceConns.get(conn.userId) !== conn) return;
      const target = voiceConns.get(to);
      if (target) send(target, 'VOICE_SIGNAL', { from: conn.userId, data: d.data });
      return;
    }

    case 'activity_update': {
      const next = sanitizeActivities(d.activities);
      if (JSON.stringify(next) === JSON.stringify(conn.activities ?? [])) return;
      conn.activities = next;
      broadcastPresence(conn.userId);
      return;
    }

    case 'call_decline':
      if (typeof d.channel_id === 'string') declineCall(d.channel_id, conn.userId);
      return;

    case 'call_ring': {
      // Ring recipients again (e.g. someone who declined), only from inside the call.
      const channelId = typeof d.channel_id === 'string' ? d.channel_id : '';
      if (voiceStates.get(conn.userId)?.channel_id !== channelId) return;
      const ids = Array.isArray(d.user_ids) ? d.user_ids.filter((x): x is string => typeof x === 'string') : [];
      ringAgain(channelId, ids);
      return;
    }
  }
}

export function attachGateway(server: http.Server) {
  const wss = new WebSocketServer({ server, path: '/gateway', maxPayload: 1 << 20 });

  wss.on('connection', (ws) => {
    let conn: Conn | null = null;
    const identifyTimeout = setTimeout(() => {
      if (!conn) ws.close(4001, 'identify timeout');
    }, 10_000);

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!msg || typeof msg.op !== 'string') return;

      if (!conn) {
        if (msg.op !== 'identify') return;
        const user = userFromToken(msg.d?.token);
        if (!user) {
          ws.close(4004, 'authentication failed');
          return;
        }
        clearTimeout(identifyTimeout);
        conn = { ws, userId: user.id, alive: true };
        let set = connections.get(user.id);
        const firstConnection = !set;
        if (!set) connections.set(user.id, (set = new Set()));
        set.add(conn);
        send(conn, 'READY', buildReady(user));
        if (firstConnection) broadcastPresence(user.id);
        return;
      }

      if (opLimiter.hit(conn.userId)) return; // silently drop floods

      try {
        handleOp(conn, msg);
      } catch (err) {
        console.error('[gateway] op failed', msg.op, err);
      }
    });

    ws.on('pong', () => {
      if (conn) conn.alive = true;
    });

    ws.on('close', () => {
      clearTimeout(identifyTimeout);
      if (!conn) return;
      if (voiceConns.get(conn.userId) === conn) leaveVoice(conn.userId);
      const set = connections.get(conn.userId);
      set?.delete(conn);
      if (set && set.size === 0) {
        connections.delete(conn.userId);
        broadcastPresence(conn.userId);
      } else if (conn.activities?.length) {
        broadcastPresence(conn.userId); // the desktop app closed while the browser stays open
      }
    });
  });

  const interval = setInterval(() => {
    for (const set of connections.values()) {
      for (const conn of set) {
        if (!conn.alive) {
          conn.ws.terminate();
          continue;
        }
        conn.alive = false;
        if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
      }
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));
}
