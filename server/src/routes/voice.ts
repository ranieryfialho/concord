import crypto from 'node:crypto';
import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { getUser } from '../models.js';
import { P, has, requireChannel } from '../permissions.js';
import { HttpError } from '../util.js';

export const voiceRouter = Router();

// ---- ICE servers (STUN/TURN) ----
// TURN_URLS: comma-separated, e.g. "turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp"
// TURN_SECRET: coturn "static-auth-secret" -> short-lived credentials (TURN REST API).
// TURN_USERNAME / TURN_CREDENTIAL: static credentials (e.g. managed TURN providers).
const STUN_URLS = (process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const TURN_TTL = 12 * 60 * 60;

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? '';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY ?? '';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET ?? '';
export const livekitEnabled = !!(LIVEKIT_URL && LIVEKIT_API_KEY && LIVEKIT_API_SECRET);

function iceServers(userId: string) {
  const servers: { urls: string[]; username?: string; credential?: string }[] = [];
  if (STUN_URLS.length) servers.push({ urls: STUN_URLS });
  if (TURN_URLS.length) {
    if (process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${userId}`;
      const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls: TURN_URLS, username, credential });
    } else if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
      servers.push({ urls: TURN_URLS, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    }
  }
  return servers;
}

voiceRouter.get('/voice/config', (req, res) => {
  res.json({
    mode: livekitEnabled ? 'livekit' : 'mesh',
    livekit_url: livekitEnabled ? LIVEKIT_URL : null,
    ice_servers: iceServers(req.userId),
    ttl: TURN_TTL,
  });
});

voiceRouter.post('/voice/livekit-token', async (req, res) => {
  if (!livekitEnabled) throw new HttpError(400, 'LiveKit não está configurado neste servidor');
  const { channel, perms } = requireChannel(req.userId, String(req.body?.channel_id ?? ''), P.CONNECT);
  if (channel.type !== 'voice' && channel.type !== 'dm' && channel.type !== 'group_dm') {
    throw new HttpError(400, 'Este canal não tem voz');
  }
  const user = getUser(req.userId)!;
  const token = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: user.id,
    name: user.display_name ?? user.username,
    ttl: '6h',
  });
  token.addGrant({
    room: `concord-${channel.id}`,
    roomJoin: true,
    canSubscribe: true,
    canPublish: has(perms, P.SPEAK) || has(perms, P.STREAM),
    canPublishData: false,
  });
  res.json({ url: LIVEKIT_URL, token: await token.toJwt() });
});
