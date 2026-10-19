import { Router } from 'express';
import { q } from '../db.js';
import { type GuildRow, getUser, publicUser } from '../models.js';
import { limits } from '../ratelimit.js';
import { guildPayload } from '../ready.js';
import { HttpError } from '../util.js';
import { joinGuild } from './guilds.js';

export const invitesRouter = Router();

interface InviteRow {
  code: string;
  guild_id: string;
  creator_id: string;
  uses: number;
  max_uses: number | null;
  expires_at: number | null;
}

/** Accepts a raw code or a pasted link like https://host/invite/CODE. */
function parseCode(raw: string): string {
  return raw.trim().split('/').filter(Boolean).pop() ?? '';
}

function requireInvite(raw: string): InviteRow {
  const invite = q.get<InviteRow>('SELECT * FROM invites WHERE code = ?', parseCode(raw));
  const expired = invite && ((invite.expires_at && invite.expires_at < Date.now()) || (invite.max_uses && invite.uses >= invite.max_uses));
  if (!invite || expired) throw new HttpError(404, 'Convite inválido ou expirado');
  return invite;
}

invitesRouter.get('/invites/:code', (req, res) => {
  const invite = requireInvite(req.params.code);
  const guild = q.get<GuildRow>('SELECT * FROM guilds WHERE id = ?', invite.guild_id)!;
  const memberCount = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?', guild.id)!.n;
  const inviter = getUser(invite.creator_id);
  res.json({
    code: invite.code,
    guild: { id: guild.id, name: guild.name, icon_url: guild.icon_url },
    member_count: memberCount,
    inviter: inviter ? publicUser(inviter) : null,
  });
});

invitesRouter.post('/invites/:code', limits.invitesJoin, (req, res) => {
  const invite = requireInvite(String(req.params.code));
  const guild = q.get<GuildRow>('SELECT * FROM guilds WHERE id = ?', invite.guild_id)!;
  if (q.get('SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?', guild.id, req.userId)) {
    res.json(guildPayload(guild, req.userId));
    return;
  }
  q.run('UPDATE invites SET uses = uses + 1 WHERE code = ?', invite.code);
  res.json(joinGuild(invite.guild_id, req.userId));
});
