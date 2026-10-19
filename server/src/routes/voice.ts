import crypto from 'node:crypto';
import express, { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { getUser } from '../models.js';
import { P, has, requireChannel } from '../permissions.js';
import { limits } from '../ratelimit.js';
import { voiceStates } from '../realtime.js';
import {
  SAMPLE_RATE,
  deleteTranscript,
  enqueue,
  getTranscript,
  listTranscripts,
  sessionPayload,
  sessions,
  startSession,
  stopSession,
  transcriptEntries,
  transcriptSummary,
  transcriptionMode,
} from '../transcription.js';
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
    transcription: transcriptionMode,
  });
});

// ---- Transcription ----

function requireInCall(userId: string, channelId: string) {
  if (voiceStates.get(userId)?.channel_id !== channelId) throw new HttpError(403, 'Entre na chamada para usar a transcrição');
}

voiceRouter.post('/voice/transcription', (req, res) => {
  if (transcriptionMode === 'off') throw new HttpError(400, 'A transcrição está desativada neste servidor');
  const channelId = String(req.body?.channel_id ?? '');
  requireChannel(req.userId, channelId);
  requireInCall(req.userId, channelId);
  if (req.body?.enabled) startSession(channelId, req.userId);
  else stopSession(channelId);
  res.json(sessionPayload(sessions.get(channelId), channelId));
});

voiceRouter.get('/voice/transcription/:channelId', (req, res) => {
  const channelId = req.params.channelId;
  requireChannel(req.userId, channelId);
  const session = sessions.get(channelId);
  const inCall = voiceStates.get(req.userId)?.channel_id === channelId;
  res.json({ ...sessionPayload(session, channelId), entries: inCall ? (session?.entries ?? []) : [] });
});

// ---- Saved transcripts (readable by anyone who can see the channel) ----

voiceRouter.get('/channels/:id/transcripts', (req, res) => {
  const { channel } = requireChannel(req.userId, req.params.id);
  res.json(listTranscripts(channel.id));
});

function requireTranscript(userId: string, id: string) {
  const t = getTranscript(id);
  if (!t) throw new HttpError(404, 'Transcrição não encontrada');
  const access = requireChannel(userId, t.channel_id);
  return { t, ...access };
}

voiceRouter.get('/transcripts/:id', (req, res) => {
  const { t } = requireTranscript(req.userId, req.params.id);
  res.json({ ...transcriptSummary(t), entries: transcriptEntries(t.id) });
});

voiceRouter.delete('/transcripts/:id', (req, res) => {
  const { t, channel, perms } = requireTranscript(req.userId, req.params.id);
  const moderator = !!channel.guild_id && has(perms, P.MANAGE_MESSAGES);
  if (t.started_by !== req.userId && !moderator) throw new HttpError(403, 'Só quem iniciou a transcrição pode excluí-la');
  deleteTranscript(t);
  res.status(204).end();
});

voiceRouter.post(
  '/voice/transcribe',
  limits.transcribe,
  express.raw({ type: 'application/octet-stream', limit: '1mb' }),
  (req, res) => {
    const channelId = String(req.query.channel_id ?? '');
    requireInCall(req.userId, channelId);
    if (!sessions.has(channelId)) throw new HttpError(409, 'A transcrição não está ativa nesta chamada');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length < 2 * SAMPLE_RATE * 0.3 || body.length % 2) {
      throw new HttpError(400, 'Áudio inválido');
    }
    // Copy into an aligned buffer: Buffer slices can start at odd offsets.
    const pcm = new Int16Array(body.length / 2);
    Buffer.from(pcm.buffer).set(body);
    const spokenAt = Number(req.query.at) || Date.now();
    const accepted = enqueue(channelId, req.userId, pcm, Math.min(spokenAt, Date.now()));
    res.status(accepted ? 202 : 503).end();
  },
);

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
