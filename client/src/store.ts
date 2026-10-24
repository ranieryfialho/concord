import { create } from 'zustand';
import { api } from './api';
import { P, has } from './permissions';
import type {
  ApiChannel,
  ApiGuild,
  ApiMember,
  Call,
  Channel,
  Guild,
  Me,
  Member,
  Message,
  Presence,
  ReadyPayload,
  RelationshipType,
  Role,
  Transcription,
  User,
  VoiceState,
} from './types';

export interface MessageBucket {
  items: Message[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'ready' | 'reconnecting';

export const HOME = '@me';

export interface View {
  guildId: string; // HOME for friends & DMs
  channelId: string | null;
}

export type ModalState =
  | { type: 'createGuild'; inviteCode?: string }
  | { type: 'createChannel'; guildId: string; parentId: string | null; channelType: 'text' | 'voice' | 'category' }
  | { type: 'channelSettings'; channelId: string }
  | { type: 'invite'; guildId: string }
  | { type: 'userSettings'; tab?: 'account' | 'appearance' | 'voice' | 'app' }
  | { type: 'guildSettings'; guildId: string }
  | { type: 'profile'; userId: string; guildId: string | null }
  | { type: 'screenPicker'; replace?: boolean }
  | { type: 'nickname'; guildId: string; userId: string }
  | { type: 'image'; url: string; filename: string }
  | { type: 'createGroup'; channelId: string | null }
  | { type: 'createThread'; channelId: string; message: Message | null }
  | { type: 'confirm'; title: string; body: string; confirmLabel: string; onConfirm: () => void | Promise<void> };

export interface State {
  status: ConnectionStatus;
  me: Me | null;
  users: Record<string, User>;
  guilds: Record<string, Guild>;
  guildOrder: string[];
  channels: Record<string, Channel>;
  members: Record<string, Record<string, Member>>;
  roles: Record<string, Record<string, Role>>;
  presences: Record<string, Presence>;
  relationships: Record<string, RelationshipType>;
  messages: Record<string, MessageBucket>;
  readStates: Record<string, string>;
  mentionCounts: Record<string, number>;
  typing: Record<string, Record<string, number>>;
  voiceStates: Record<string, VoiceState>;
  calls: Record<string, Call>;
  transcriptions: Record<string, Transcription>;
  view: View;
  lastChannels: Record<string, string>;
  showMembers: boolean;
  /** Phone layout shows one pane at a time: the server/channel lists or the open channel. */
  mobilePane: 'nav' | 'main';
  /** Phone layout: the member list opens as a drawer over the chat instead of a column. */
  membersDrawer: boolean;
  replyingTo: Record<string, Message | null>;
  editingId: string | null;
  modal: ModalState | null;
  toast: string | null;
}

const VIEW_KEY = 'concord.view';

function loadSaved<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const saved = loadSaved<{ view: View; lastChannels: Record<string, string> }>(VIEW_KEY, {
  view: { guildId: HOME, channelId: null },
  lastChannels: {},
});

const initialData = {
  status: 'idle' as ConnectionStatus,
  me: null,
  users: {},
  guilds: {},
  guildOrder: [],
  channels: {},
  members: {},
  roles: {},
  presences: {},
  relationships: {},
  messages: {},
  readStates: {},
  mentionCounts: {},
  typing: {},
  voiceStates: {},
  calls: {},
  transcriptions: {},
  replyingTo: {},
  editingId: null,
  modal: null,
  toast: null,
};

export const useStore = create<State>()(() => ({
  ...initialData,
  view: saved.view,
  lastChannels: saved.lastChannels,
  showMembers: loadSaved('concord.showMembers', true),
  mobilePane: 'nav',
  membersDrawer: false,
}));

export const getState = useStore.getState;
export const setState = useStore.setState;

export function resetStore() {
  setState({ ...initialData });
}

// ---------- Normalization ----------

export function toChannel(c: ApiChannel): Channel {
  const { recipients, ...rest } = c;
  return { ...rest, recipient_ids: recipients?.map((u) => u.id) };
}

export function toMember(m: ApiMember): Member {
  return { guild_id: m.guild_id, user_id: m.user.id, role_ids: m.role_ids ?? [], nickname: m.nickname, joined_at: m.joined_at };
}

interface Draft {
  users: Record<string, User>;
  guilds: Record<string, Guild>;
  channels: Record<string, Channel>;
  members: Record<string, Record<string, Member>>;
  roles: Record<string, Record<string, Role>>;
  presences: Record<string, Presence>;
  voiceStates: Record<string, VoiceState>;
}

export function ingestGuild(draft: Draft, g: ApiGuild) {
  draft.guilds[g.id] = {
    id: g.id,
    name: g.name,
    icon_url: g.icon_url,
    owner_id: g.owner_id,
    created_at: g.created_at,
    permissions: g.permissions,
  };
  for (const c of g.channels) draft.channels[c.id] = toChannel(c);
  const members: Record<string, Member> = {};
  for (const m of g.members) {
    members[m.user.id] = toMember(m);
    draft.users[m.user.id] = m.user;
  }
  draft.members[g.id] = members;
  draft.roles[g.id] = Object.fromEntries(g.roles.map((r) => [r.id, r]));
  Object.assign(draft.presences, g.presences);
  for (const v of g.voice_states) if (v.channel_id) draft.voiceStates[v.user_id] = v;
}

/** Adds a guild, or fully replaces it (permission changes can hide channels). */
export function addGuild(g: ApiGuild) {
  setState((s) => {
    const draft: Draft = {
      users: { ...s.users },
      guilds: { ...s.guilds },
      channels: Object.fromEntries(Object.entries(s.channels).filter(([, c]) => c.guild_id !== g.id)),
      members: { ...s.members },
      roles: { ...s.roles },
      presences: { ...s.presences },
      voiceStates: Object.fromEntries(Object.entries(s.voiceStates).filter(([, v]) => v.guild_id !== g.id)),
    };
    ingestGuild(draft, g);
    return { ...draft, guildOrder: s.guildOrder.includes(g.id) ? s.guildOrder : [...s.guildOrder, g.id] };
  });
  const { view, channels } = getState();
  if (view.guildId === g.id && view.channelId && !channels[view.channelId]) selectGuild(g.id);
}

export function applyReady(d: ReadyPayload) {
  const draft: Draft = { users: {}, guilds: {}, channels: {}, members: {}, roles: {}, presences: {}, voiceStates: {} };
  for (const g of d.guilds) ingestGuild(draft, g);
  for (const c of d.private_channels) {
    draft.channels[c.id] = toChannel(c);
    for (const u of c.recipients ?? []) draft.users[u.id] = u;
  }
  const relationships: Record<string, RelationshipType> = {};
  for (const r of d.relationships) {
    relationships[r.user.id] = r.type;
    draft.users[r.user.id] = r.user;
  }
  draft.users[d.user.id] = d.user;
  Object.assign(draft.presences, d.presences);
  for (const v of d.voice_states) if (v.channel_id) draft.voiceStates[v.user_id] = v;

  const s = getState();
  let view = s.view;
  if (view.guildId !== HOME && !draft.guilds[view.guildId]) view = { guildId: HOME, channelId: null };
  if (view.channelId && !draft.channels[view.channelId]) view = { ...view, channelId: null };

  setState({
    ...draft,
    status: 'ready',
    me: d.user,
    guildOrder: d.guilds.map((g) => g.id),
    relationships,
    readStates: d.read_states,
    mentionCounts: d.mention_counts,
    calls: Object.fromEntries(d.calls.map((c) => [c.channel_id, c])),
    messages: {}, // refetched on demand so nothing is stale after a reconnect
    typing: {},
    view,
  });
  if (view.guildId !== HOME && !view.channelId) selectGuild(view.guildId);
}

// ---------- Selectors ----------

export function nameOf(s: State, userId: string, guildId?: string | null): string {
  const nick = guildId ? s.members[guildId]?.[userId]?.nickname : null;
  const u = s.users[userId];
  return nick || u?.display_name || u?.username || 'Usuário desconhecido';
}

export function presenceOf(s: State, userId: string): Presence {
  if (s.me && userId === s.me.id) return s.me.status === 'invisible' ? 'offline' : s.me.status;
  return s.presences[userId] ?? 'offline';
}

export function sortedGuildChannels(s: State, guildId: string): Channel[] {
  return Object.values(s.channels)
    .filter((c) => c.guild_id === guildId && c.type !== 'thread')
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

export function threadsOf(s: State, parentId: string, includeArchived = false): Channel[] {
  return Object.values(s.channels)
    .filter((c) => c.type === 'thread' && c.parent_id === parentId && (includeArchived || !c.archived))
    .sort((a, b) => (b.last_message_id ?? b.id).localeCompare(a.last_message_id ?? a.id));
}

export function threadForMessage(s: State, messageId: string): Channel | undefined {
  return Object.values(s.channels).find((c) => c.type === 'thread' && c.starter_message_id === messageId);
}

export function isUnread(s: State, c: Channel): boolean {
  if (c.type === 'category') return false;
  if (!c.last_message_id) return false;
  const read = s.readStates[c.id];
  return !read || c.last_message_id > read;
}

export function guildUnread(s: State, guildId: string): boolean {
  return Object.values(s.channels).some((c) => c.guild_id === guildId && c.type !== 'thread' && isUnread(s, c));
}

export function guildMentions(s: State, guildId: string): number {
  let n = 0;
  for (const c of Object.values(s.channels)) if (c.guild_id === guildId) n += s.mentionCounts[c.id] ?? 0;
  return n;
}

export function isPrivateChannel(c: Channel | undefined): boolean {
  return c?.type === 'dm' || c?.type === 'group_dm';
}

export function dmChannels(s: State): Channel[] {
  return Object.values(s.channels)
    .filter(isPrivateChannel)
    .sort((a, b) => (b.last_message_id ?? b.id).localeCompare(a.last_message_id ?? a.id));
}

export function dmRecipient(s: State, c: Channel): string | undefined {
  return c.recipient_ids?.find((id) => id !== s.me?.id) ?? c.recipient_ids?.[0];
}

export function otherRecipients(s: State, c: Channel): string[] {
  return (c.recipient_ids ?? []).filter((id) => id !== s.me?.id);
}

export function channelLabel(s: State, c: Channel): string {
  if (c.type === 'dm') {
    const other = dmRecipient(s, c);
    return other ? nameOf(s, other) : 'Mensagem direta';
  }
  if (c.type === 'group_dm') {
    if (c.name) return c.name;
    const others = otherRecipients(s, c);
    return others.length ? others.map((id) => nameOf(s, id)).join(', ') : 'Grupo vazio';
  }
  return c.name ?? '';
}

export function totalMentions(s: State): number {
  return Object.values(s.mentionCounts).reduce((a, b) => a + b, 0);
}

export function guildPerms(s: State, guildId: string | null | undefined): number {
  return guildId ? (s.guilds[guildId]?.permissions ?? 0) : 0;
}

export function can(s: State, channelId: string | null | undefined, bit: number): boolean {
  return !!channelId && has(s.channels[channelId]?.permissions, bit);
}

export function canGuild(s: State, guildId: string | null | undefined, bit: number): boolean {
  return has(guildPerms(s, guildId), bit);
}

/** Member's roles from highest to lowest (excluding @everyone). */
export function memberRoles(s: State, guildId: string, userId: string): Role[] {
  const ids = s.members[guildId]?.[userId]?.role_ids ?? [];
  const roles = s.roles[guildId] ?? {};
  return ids
    .map((id) => roles[id])
    .filter((r): r is Role => !!r)
    .sort((a, b) => b.position - a.position);
}

export function memberColor(s: State, guildId: string | null | undefined, userId: string): number | null {
  if (!guildId) return null;
  return memberRoles(s, guildId, userId).find((r) => r.color != null)?.color ?? null;
}

export function hoistedRole(s: State, guildId: string, userId: string): Role | undefined {
  return memberRoles(s, guildId, userId).find((r) => r.hoist);
}

/** Highest role position; the owner outranks everyone. */
export function highestPosition(s: State, guildId: string, userId: string): number {
  if (s.guilds[guildId]?.owner_id === userId) return Number.POSITIVE_INFINITY;
  return memberRoles(s, guildId, userId)[0]?.position ?? 0;
}

export function sortedRoles(s: State, guildId: string): Role[] {
  return Object.values(s.roles[guildId] ?? {}).sort((a, b) => b.position - a.position);
}

// ---------- UI actions ----------

function persistView() {
  const s = getState();
  save(VIEW_KEY, { view: s.view, lastChannels: s.lastChannels });
}

export function selectGuild(guildId: string) {
  const s = getState();
  if (guildId === HOME) {
    const last = s.lastChannels[HOME];
    setState({ view: { guildId: HOME, channelId: last && s.channels[last] ? last : null } });
  } else {
    const remembered = s.lastChannels[guildId];
    const channelId =
      remembered && s.channels[remembered]
        ? remembered
        : (sortedGuildChannels(s, guildId).find((c) => c.type === 'text')?.id ?? null);
    setState({ view: { guildId, channelId } });
  }
  persistView();
}

export function selectChannel(guildId: string, channelId: string | null) {
  setState((s) => ({
    view: { guildId, channelId },
    mobilePane: 'main',
    membersDrawer: false,
    lastChannels: channelId ? { ...s.lastChannels, [guildId]: channelId } : { ...s.lastChannels, [guildId]: '' },
    editingId: null,
  }));
  persistView();
}

export function openModal(modal: ModalState) {
  setState({ modal });
}

export function closeModal() {
  setState({ modal: null });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string) {
  setState({ toast: message });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setState({ toast: null }), 3500);
}

export function copyText(text: string, message = 'Copiado!') {
  void navigator.clipboard.writeText(text).then(
    () => toast(message),
    () => toast('Não foi possível copiar'),
  );
}

export function toggleMembers() {
  const showMembers = !getState().showMembers;
  setState({ showMembers });
  save('concord.showMembers', showMembers);
}

export function setReplyingTo(channelId: string, message: Message | null) {
  setState((s) => ({ replyingTo: { ...s.replyingTo, [channelId]: message } }));
}

// ---------- Data actions ----------

export function upsertUsers(users: User[]) {
  setState((s) => {
    const next = { ...s.users };
    for (const u of users) next[u.id] = u;
    return { users: next };
  });
}

export function upsertChannel(c: ApiChannel) {
  if (c.recipients) upsertUsers(c.recipients);
  setState((s) => ({ channels: { ...s.channels, [c.id]: toChannel(c) } }));
}

function setBucket(channelId: string, patch: Partial<MessageBucket>) {
  setState((s) => {
    const prev = s.messages[channelId] ?? { items: [], hasMore: true, loading: false, loaded: false };
    return { messages: { ...s.messages, [channelId]: { ...prev, ...patch } } };
  });
}

function usersOf(messages: Message[]): User[] {
  const out: User[] = [];
  for (const m of messages) {
    out.push(m.author);
    if (m.target_user) out.push(m.target_user);
    if (m.reply_to) out.push(m.reply_to.author);
  }
  return out;
}

export function ingestMessageUsers(messages: Message[]) {
  upsertUsers(usersOf(messages));
}

export async function loadMessages(channelId: string, older = false) {
  const bucket = getState().messages[channelId];
  if (bucket?.loading) return;
  if (older && (!bucket?.hasMore || !bucket.items.length)) return;
  if (!older && bucket?.loaded) return;
  setBucket(channelId, { loading: true });
  try {
    const before = older ? bucket!.items[0].id : null;
    const page = await api<Message[]>(`/channels/${channelId}/messages?limit=50${before ? `&before=${before}` : ''}`);
    ingestMessageUsers(page);
    const current = getState().messages[channelId]?.items ?? [];
    const known = new Set(page.map((m) => m.id));
    const items = older ? [...page, ...current.filter((m) => !known.has(m.id))] : mergeMessages(page, current);
    setBucket(channelId, { items, hasMore: page.length === 50, loaded: true, loading: false });
  } catch (err) {
    setBucket(channelId, { loading: false });
    throw err;
  }
}

function mergeMessages(a: Message[], b: Message[]): Message[] {
  const map = new Map<string, Message>();
  for (const m of a) map.set(m.id, m);
  for (const m of b) map.set(m.id, m);
  return [...map.values()].sort((x, y) => x.id.localeCompare(y.id));
}

export function addMessage(m: Message) {
  setState((s) => {
    const bucket = s.messages[m.channel_id];
    const channel = s.channels[m.channel_id];
    const patch: Partial<State> = {};
    if (bucket?.loaded && !bucket.items.some((x) => x.id === m.id)) {
      patch.messages = { ...s.messages, [m.channel_id]: { ...bucket, items: [...bucket.items, m] } };
    }
    if (channel && (!channel.last_message_id || m.id > channel.last_message_id)) {
      patch.channels = { ...s.channels, [m.channel_id]: { ...channel, last_message_id: m.id } };
    }
    return patch;
  });
}

export function updateMessage(m: Message) {
  setState((s) => {
    const bucket = s.messages[m.channel_id];
    if (!bucket) return {};
    return {
      messages: {
        ...s.messages,
        [m.channel_id]: { ...bucket, items: bucket.items.map((x) => (x.id === m.id ? m : x)) },
      },
    };
  });
}

export function patchMessage(channelId: string, messageId: string, fn: (m: Message) => Message) {
  setState((s) => {
    const bucket = s.messages[channelId];
    if (!bucket) return {};
    return {
      messages: {
        ...s.messages,
        [channelId]: { ...bucket, items: bucket.items.map((x) => (x.id === messageId ? fn(x) : x)) },
      },
    };
  });
}

export function removeMessage(channelId: string, messageId: string) {
  setState((s) => {
    const bucket = s.messages[channelId];
    if (!bucket) return {};
    return {
      messages: { ...s.messages, [channelId]: { ...bucket, items: bucket.items.filter((x) => x.id !== messageId) } },
    };
  });
}

export async function sendMessage(channelId: string, content: string, files: File[], replyToId: string | null) {
  const form = new FormData();
  form.append('content', content);
  if (replyToId) form.append('reply_to_id', replyToId);
  for (const f of files) form.append('files', f, f.name);
  const message = await api<Message>(`/channels/${channelId}/messages`, { form });
  addMessage(message);
  setState((s) => ({ readStates: { ...s.readStates, [channelId]: message.id } }));
  return message;
}

export function toggleReaction(m: Message, emoji: string) {
  const me = getState().me;
  if (!me) return;
  const has = m.reactions.find((r) => r.emoji === emoji)?.user_ids.includes(me.id);
  const path = `/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`;
  api(path, { method: has ? 'DELETE' : 'PUT' }).catch((e: Error) => toast(e.message));
}

const ackInFlight = new Set<string>();
export function ackChannel(channelId: string) {
  const s = getState();
  const last = s.channels[channelId]?.last_message_id;
  if (!last) return;
  const read = s.readStates[channelId];
  if (read && read >= last && !s.mentionCounts[channelId]) return;
  setState({
    readStates: { ...s.readStates, [channelId]: last },
    mentionCounts: { ...s.mentionCounts, [channelId]: 0 },
  });
  if (ackInFlight.has(channelId)) return;
  ackInFlight.add(channelId);
  api(`/channels/${channelId}/ack`, { body: { message_id: last } })
    .catch(() => {})
    .finally(() => ackInFlight.delete(channelId));
}

export async function openDM(userId: string) {
  const channel = await api<ApiChannel>('/users/@me/channels', { body: { recipient_id: userId } });
  upsertChannel(channel);
  closeModal();
  selectChannel(HOME, channel.id);
  return channel;
}

export function isViewing(channelId: string): boolean {
  return getState().view.channelId === channelId && document.hasFocus() && !document.hidden;
}

export function canSend(s: State, channelId: string): boolean {
  return can(s, channelId, P.SEND_MESSAGES);
}
