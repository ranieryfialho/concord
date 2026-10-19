import { gatewayUrl, getToken } from './api';
import { native } from './native';
import { sounds } from './sounds';
import {
  HOME,
  ackChannel,
  addGuild,
  addMessage,
  applyReady,
  channelLabel,
  getState,
  ingestMessageUsers,
  isPrivateChannel,
  isViewing,
  nameOf,
  patchMessage,
  removeMessage,
  selectChannel,
  selectGuild,
  setState,
  toChannel,
  toast,
  toMember,
  upsertChannel,
  upsertUsers,
  updateMessage,
} from './store';
import type {
  ApiChannel,
  ApiGuild,
  ApiMember,
  Call,
  Guild,
  Message,
  Presence,
  ReadyPayload,
  RelationshipType,
  TranscriptEntry,
  Transcription,
  User,
  VoiceState,
} from './types';
import { voice } from './voice';

type Handler = (d: any) => void;

function mentionsMe(m: Message): boolean {
  const me = getState().me;
  return !!me && m.content.includes(`<@${me.id}>`);
}

function notifyMessage(m: Message) {
  const s = getState();
  const channel = s.channels[m.channel_id];
  if (!channel) return;
  if (s.me?.status === 'dnd') return;
  const where = isPrivateChannel(channel)
    ? channel.type === 'group_dm'
      ? ` (${channelLabel(s, channel)})`
      : ''
    : ` (#${channel.name}, ${s.guilds[channel.guild_id ?? '']?.name ?? ''})`;
  const title = `${nameOf(s, m.author.id, channel.guild_id)}${where}`;
  const body = m.content.replace(/<@(\d+)>/g, (_, id: string) => `@${nameOf(s, id, channel.guild_id)}`) || 'Enviou um anexo';
  sounds.message();
  if (native) {
    native.notify({ title, body: body.slice(0, 200), id: m.channel_id });
    native.flashFrame();
  } else if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body: body.slice(0, 200), tag: m.channel_id });
    n.onclick = () => {
      window.focus();
      openChannel(m.channel_id);
    };
  }
}

export function openChannel(channelId: string) {
  const c = getState().channels[channelId];
  if (!c) return;
  selectChannel(c.guild_id ?? HOME, c.id);
}

function setCall(call: Call | null, channelId: string) {
  setState((s) => {
    const calls = { ...s.calls };
    if (call) calls[channelId] = call;
    else delete calls[channelId];
    return { calls };
  });
}

const handlers: Record<string, Handler> = {
  READY: (d: ReadyPayload) => {
    applyReady(d);
    voice.onReady();
  },

  USER_UPDATE: (u: User) => {
    upsertUsers([u]);
    const me = getState().me;
    if (me?.id === u.id) setState({ me: { ...me, ...u } });
  },

  PRESENCE_UPDATE: (d: { user_id: string; status: Presence }) =>
    setState((s) => ({ presences: { ...s.presences, [d.user_id]: d.status } })),

  GUILD_CREATE: (g: ApiGuild) => addGuild(g),

  GUILD_UPDATE: (g: Omit<Guild, 'permissions'>) =>
    setState((s) => ({ guilds: { ...s.guilds, [g.id]: { ...s.guilds[g.id], ...g } } })),

  GUILD_DELETE: (d: { id: string }) => {
    if (voice.guildId() === d.id) voice.leave(false);
    setState((s) => {
      const guilds = { ...s.guilds };
      delete guilds[d.id];
      const members = { ...s.members };
      delete members[d.id];
      const roles = { ...s.roles };
      delete roles[d.id];
      const channels = Object.fromEntries(Object.entries(s.channels).filter(([, c]) => c.guild_id !== d.id));
      const voiceStates = Object.fromEntries(Object.entries(s.voiceStates).filter(([, v]) => v.guild_id !== d.id));
      return { guilds, members, roles, channels, voiceStates, guildOrder: s.guildOrder.filter((id) => id !== d.id) };
    });
    if (getState().view.guildId === d.id) selectGuild(HOME);
  },

  GUILD_MEMBER_ADD: (m: ApiMember & { status: Presence }) => {
    upsertUsers([m.user]);
    setState((s) => ({
      members: { ...s.members, [m.guild_id]: { ...s.members[m.guild_id], [m.user.id]: toMember(m) } },
      presences: { ...s.presences, [m.user.id]: m.status },
    }));
  },

  GUILD_MEMBER_UPDATE: (m: ApiMember) => {
    upsertUsers([m.user]);
    setState((s) => ({ members: { ...s.members, [m.guild_id]: { ...s.members[m.guild_id], [m.user.id]: toMember(m) } } }));
  },

  GUILD_MEMBER_REMOVE: (d: { guild_id: string; user_id: string }) =>
    setState((s) => {
      const list = { ...s.members[d.guild_id] };
      delete list[d.user_id];
      return { members: { ...s.members, [d.guild_id]: list } };
    }),

  CHANNEL_CREATE: (c: ApiChannel) => upsertChannel(c),

  CHANNEL_UPDATE: (c: ApiChannel) => {
    if (c.recipients) upsertUsers(c.recipients);
    setState((s) => {
      const prev = s.channels[c.id]?.last_message_id;
      const last = prev && (!c.last_message_id || prev > c.last_message_id) ? prev : c.last_message_id;
      return { channels: { ...s.channels, [c.id]: { ...toChannel(c), last_message_id: last } } };
    });
  },

  CHANNEL_DELETE: (d: { id: string; guild_id: string | null }) => {
    setState((s) => {
      const channels = { ...s.channels };
      delete channels[d.id];
      const calls = { ...s.calls };
      delete calls[d.id];
      return { channels, calls };
    });
    if (getState().view.channelId === d.id) {
      if (d.guild_id) selectGuild(d.guild_id);
      else selectChannel(HOME, null);
    }
  },

  MESSAGE_CREATE: (m: Message) => {
    const s = getState();
    ingestMessageUsers([m]);
    addMessage(m);
    // Author stopped typing.
    if (s.typing[m.channel_id]?.[m.author.id]) {
      setState((st) => {
        const t = { ...st.typing[m.channel_id] };
        delete t[m.author.id];
        return { typing: { ...st.typing, [m.channel_id]: t } };
      });
    }
    if (m.author.id === s.me?.id) {
      setState((st) => ({ readStates: { ...st.readStates, [m.channel_id]: m.id } }));
      return;
    }
    if (isViewing(m.channel_id)) {
      ackChannel(m.channel_id);
      return;
    }
    if (m.type !== 'default') return;
    const channel = s.channels[m.channel_id];
    if (isPrivateChannel(channel) || mentionsMe(m)) {
      setState((st) => ({ mentionCounts: { ...st.mentionCounts, [m.channel_id]: (st.mentionCounts[m.channel_id] ?? 0) + 1 } }));
      notifyMessage(m);
    }
  },

  MESSAGE_UPDATE: (m: Message) => {
    ingestMessageUsers([m]);
    updateMessage(m);
  },

  MESSAGE_DELETE: (d: { id: string; channel_id: string }) => removeMessage(d.channel_id, d.id),

  MESSAGE_REACTION_ADD: (d: { channel_id: string; message_id: string; user_id: string; emoji: string }) =>
    patchMessage(d.channel_id, d.message_id, (m) => {
      const existing = m.reactions.find((r) => r.emoji === d.emoji);
      if (existing?.user_ids.includes(d.user_id)) return m;
      const reactions = existing
        ? m.reactions.map((r) => (r.emoji === d.emoji ? { ...r, user_ids: [...r.user_ids, d.user_id] } : r))
        : [...m.reactions, { emoji: d.emoji, user_ids: [d.user_id] }];
      return { ...m, reactions };
    }),

  MESSAGE_REACTION_REMOVE: (d: { channel_id: string; message_id: string; user_id: string; emoji: string }) =>
    patchMessage(d.channel_id, d.message_id, (m) => ({
      ...m,
      reactions: m.reactions
        .map((r) => (r.emoji === d.emoji ? { ...r, user_ids: r.user_ids.filter((id) => id !== d.user_id) } : r))
        .filter((r) => r.user_ids.length),
    })),

  MESSAGE_ACK: (d: { channel_id: string; message_id: string }) =>
    setState((s) => ({
      readStates: { ...s.readStates, [d.channel_id]: d.message_id },
      mentionCounts: { ...s.mentionCounts, [d.channel_id]: 0 },
    })),

  TYPING_START: (d: { channel_id: string; user_id: string }) =>
    setState((s) => ({
      typing: { ...s.typing, [d.channel_id]: { ...s.typing[d.channel_id], [d.user_id]: Date.now() + 9000 } },
    })),

  RELATIONSHIP_ADD: (d: { type: RelationshipType; user: User }) => {
    upsertUsers([d.user]);
    const prev = getState().relationships[d.user.id];
    setState((s) => ({ relationships: { ...s.relationships, [d.user.id]: d.type } }));
    if (d.type === 'pending_in' && prev !== 'pending_in') {
      sounds.message();
      native?.notify({ title: 'Pedido de amizade', body: `${d.user.display_name ?? d.user.username} quer ser seu amigo`, id: 'friends' });
    }
  },

  RELATIONSHIP_REMOVE: (d: { id: string }) =>
    setState((s) => {
      const relationships = { ...s.relationships };
      delete relationships[d.id];
      return { relationships };
    }),

  VOICE_STATE_UPDATE: (v: VoiceState) => {
    const prev = getState().voiceStates[v.user_id];
    setState((s) => {
      const voiceStates = { ...s.voiceStates };
      if (v.channel_id) voiceStates[v.user_id] = v;
      else delete voiceStates[v.user_id];
      return { voiceStates };
    });
    voice.onVoiceState(v, prev);
  },

  VOICE_SIGNAL: (d: { from: string; data: unknown }) => voice.onSignal(d.from, d.data),

  // A moderator moved us: our own client does the join (WebRTC is negotiated here).
  VOICE_MOVE: (d: { guild_id: string; channel_id: string }) => {
    if (!getState().channels[d.channel_id]) return;
    toast('Você foi movido para outro canal de voz');
    void voice.join(d.guild_id, d.channel_id);
  },

  TRANSCRIPTION_UPDATE: (d: Omit<Transcription, 'entries'>) => {
    setState((s) => {
      const prev = s.transcriptions[d.channel_id];
      // A new session starts with an empty transcript.
      const entries = d.active && prev?.active && prev.started_at === d.started_at ? prev.entries : [];
      return { transcriptions: { ...s.transcriptions, [d.channel_id]: { ...d, entries } } };
    });
    voice.syncTranscription();
  },

  TRANSCRIPT: (d: { channel_id: string; entry: TranscriptEntry }) =>
    setState((s) => {
      const t = s.transcriptions[d.channel_id];
      if (!t || t.entries.some((e) => e.id === d.entry.id)) return {};
      const entries = [...t.entries, d.entry].sort((a, b) => a.at - b.at);
      return { transcriptions: { ...s.transcriptions, [d.channel_id]: { ...t, entries } } };
    }),

  CALL_CREATE: (c: Call) => setCall(c, c.channel_id),
  CALL_UPDATE: (c: Call) => setCall(c, c.channel_id),
  CALL_DELETE: (d: { channel_id: string }) => setCall(null, d.channel_id),
};

class GatewayClient {
  private ws: WebSocket | null = null;
  private retries = 0;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  onAuthFailed: () => void = () => {};

  connect() {
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    const token = getToken();
    if (!token) return;
    setState({ status: this.retries ? 'reconnecting' : 'connecting' });
    const ws = new WebSocket(gatewayUrl());
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ op: 'identify', d: { token } }));
      this.heartbeat = setInterval(() => this.send('heartbeat'), 30_000);
    };

    ws.onmessage = (ev) => {
      let msg: { op: string; t?: string; d?: unknown };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.op !== 'dispatch' || !msg.t) return;
      if (msg.t === 'READY') this.retries = 0;
      try {
        handlers[msg.t]?.(msg.d);
      } catch (err) {
        console.error('[gateway] handler failed', msg.t, err);
      }
    };

    ws.onclose = (ev) => {
      clearInterval(this.heartbeat);
      if (this.ws !== ws) return;
      this.ws = null;
      voice.onGatewayLost();
      if (ev.code === 4004) {
        this.stopped = true;
        this.onAuthFailed();
        return;
      }
      if (this.stopped) return;
      setState({ status: 'reconnecting' });
      const delay = Math.min(1000 * 2 ** this.retries, 15_000);
      this.retries++;
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
  }

  send(op: string, d?: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  disconnect() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

export const gateway = new GatewayClient();
