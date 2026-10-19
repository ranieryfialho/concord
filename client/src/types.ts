export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type UserStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type ChannelType = 'text' | 'voice' | 'category' | 'dm' | 'group_dm' | 'thread';
export type RelationshipType = 'friend' | 'pending_in' | 'pending_out';
export type MessageType = 'default' | 'recipient_add' | 'recipient_remove' | 'call' | 'thread_created' | 'channel_name_change';

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  custom_status: string | null;
}

export interface Me extends User {
  status: UserStatus;
}

export interface Guild {
  id: string;
  name: string;
  icon_url: string | null;
  owner_id: string;
  created_at: number;
  /** The current user's guild-level permissions. */
  permissions: number;
}

export interface Role {
  id: string;
  guild_id: string;
  name: string;
  color: number | null;
  permissions: number;
  position: number;
  hoist: boolean;
}

export interface Member {
  guild_id: string;
  user_id: string;
  role_ids: string[];
  nickname: string | null;
  joined_at: number;
}

export interface ApiMember extends Omit<Member, 'user_id'> {
  user: User;
}

export interface Channel {
  id: string;
  guild_id: string | null;
  parent_id: string | null;
  type: ChannelType;
  name: string | null;
  topic: string | null;
  position: number;
  owner_id: string | null;
  icon_url: string | null;
  archived: boolean;
  starter_message_id: string | null;
  message_count?: number;
  created_at: number;
  last_message_id: string | null;
  /** The current user's permissions in this channel. */
  permissions: number;
  recipient_ids?: string[];
}

export interface ApiChannel extends Omit<Channel, 'recipient_ids'> {
  recipients?: User[];
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  content_type: string | null;
  size: number;
}

export interface Reaction {
  emoji: string;
  user_ids: string[];
}

export interface Embed {
  type: 'link' | 'image';
  url: string;
  title: string | null;
  description: string | null;
  site_name: string | null;
  image_url: string | null;
  color: string | null;
}

export interface Message {
  id: string;
  channel_id: string;
  type: MessageType;
  author: User;
  content: string;
  target_user: User | null;
  reply_to_id: string | null;
  reply_to: { id: string; author: User; content: string } | null;
  pinned: boolean;
  edited_at: number | null;
  created_at: number;
  attachments: Attachment[];
  reactions: Reaction[];
  embeds: Embed[];
}

export interface VoiceState {
  user_id: string;
  guild_id: string | null;
  channel_id: string | null;
  self_mute: boolean;
  self_deaf: boolean;
  self_video: boolean;
  self_stream: boolean;
  suppress: boolean;
}

export interface TranscriptEntry {
  id: string;
  user_id: string;
  text: string;
  at: number;
}

export interface SavedTranscript {
  id: string;
  channel_id: string;
  started_by: string;
  started_at: number;
  ended_at: number | null;
  active: boolean;
  entry_count: number;
  speaker_ids: string[];
  entries?: TranscriptEntry[];
}

export interface Transcription {
  channel_id: string;
  active: boolean;
  transcript_id?: string | null;
  started_by: string | null;
  started_at: number | null;
  entries: TranscriptEntry[];
}

export interface Call {
  channel_id: string;
  ringing: string[];
}

export interface ApiGuild extends Guild {
  channels: ApiChannel[];
  roles: Role[];
  members: ApiMember[];
  presences: Record<string, Presence>;
  voice_states: VoiceState[];
}

export interface ReadyPayload {
  user: Me;
  guilds: ApiGuild[];
  private_channels: ApiChannel[];
  relationships: { type: RelationshipType; user: User }[];
  presences: Record<string, Presence>;
  read_states: Record<string, string>;
  mention_counts: Record<string, number>;
  voice_states: VoiceState[];
  calls: Call[];
}
