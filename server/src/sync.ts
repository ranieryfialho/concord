import { type ChannelRow, serializeChannel } from './models.js';
import { DM_PERMISSIONS, P, guildContext, recipientIds } from './permissions.js';
import { guildPayload } from './ready.js';
import { dispatch, leaveVoice, voiceStates } from './realtime.js';

/**
 * Sends a channel create/update to everyone in its guild with their own permissions;
 * members who can no longer see it get CHANNEL_DELETE instead.
 */
export function dispatchChannel(c: ChannelRow, t: 'CHANNEL_CREATE' | 'CHANNEL_UPDATE') {
  const payload = serializeChannel(c);
  if (!c.guild_id) {
    dispatch(recipientIds(c.id), t, { ...payload, permissions: DM_PERMISSIONS });
    return;
  }
  const ctx = guildContext(c.guild_id);
  if (!ctx) return;
  for (const uid of ctx.memberIds()) {
    const perms = ctx.channel(c, uid);
    if (perms & P.VIEW_CHANNEL) dispatch([uid], t, { ...payload, permissions: perms });
    else if (t === 'CHANNEL_UPDATE') dispatch([uid], 'CHANNEL_DELETE', { id: c.id, guild_id: c.guild_id });
  }
}

/**
 * Re-sends the full guild to members after roles or overwrites change, since any channel's
 * visibility can flip. Also drops voice sessions that are no longer permitted.
 */
export function resyncGuild(guildId: string, userIds?: string[]) {
  const ctx = guildContext(guildId);
  if (!ctx) return;
  for (const uid of userIds ?? ctx.memberIds()) {
    if (!ctx.isMember(uid)) continue;
    dispatch([uid], 'GUILD_CREATE', guildPayload(ctx.guild, uid, ctx));
  }
  for (const state of [...voiceStates.values()]) {
    if (state.guild_id !== guildId) continue;
    const channel = ctx.channels.get(state.channel_id);
    if (!channel || !(ctx.channel(channel, state.user_id) & P.CONNECT)) leaveVoice(state.user_id);
  }
}
