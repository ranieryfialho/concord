import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, q } from './db.js';
import { getChannel, channelAudience } from './permissions.js';
import { channelEmptyHooks, dispatch, usersInVoiceChannel } from './realtime.js';
import { snowflake } from './util.js';

// Voice transcription. Each client sends only its own microphone (already split into speech
// segments by the client), so every line is attributed to the right speaker.
//  - default: Whisper running locally on the server (transformers.js + onnxruntime, CPU)
//  - TRANSCRIBE_API_URL + TRANSCRIBE_API_KEY: any OpenAI-compatible /audio/transcriptions API (OpenAI, Groq…)
//  - TRANSCRIBE=0 disables the feature.

const API_URL = (process.env.TRANSCRIBE_API_URL ?? '').replace(/\/$/, '');
const API_KEY = process.env.TRANSCRIBE_API_KEY ?? '';
const API_MODEL = process.env.TRANSCRIBE_API_MODEL ?? 'whisper-1';
// "small" gets short words ("entendi", "não") right where "base" guesses; ~2x slower, still ~1-2 s per phrase on CPU.
const LOCAL_MODEL = process.env.TRANSCRIBE_MODEL ?? 'onnx-community/whisper-small';
const LANGUAGE = process.env.TRANSCRIBE_LANGUAGE ?? 'pt';
const WHISPER_LANGUAGES: Record<string, string> = { pt: 'portuguese', en: 'english', es: 'spanish', fr: 'french', de: 'german', it: 'italian' };

export const transcriptionMode: 'local' | 'api' | 'off' =
  process.env.TRANSCRIBE === '0' ? 'off' : API_URL && API_KEY ? 'api' : 'local';

export const SAMPLE_RATE = 16_000;
const MAX_QUEUE = 30;

export interface TranscriptEntry {
  id: string;
  user_id: string;
  text: string;
  at: number;
}

export interface TranscriptionSession {
  id: string;
  channel_id: string;
  started_by: string;
  started_at: number;
  entries: TranscriptEntry[];
}

export const sessions = new Map<string, TranscriptionSession>();

export function sessionPayload(s: TranscriptionSession | undefined, channelId: string) {
  return s
    ? { channel_id: channelId, active: true, transcript_id: s.id, started_by: s.started_by, started_at: s.started_at }
    : { channel_id: channelId, active: false, transcript_id: null, started_by: null, started_at: null };
}

function broadcastSession(channelId: string) {
  const channel = getChannel(channelId);
  if (!channel) return;
  dispatch(channelAudience(channel), 'TRANSCRIPTION_UPDATE', sessionPayload(sessions.get(channelId), channelId));
}

// Every session is persisted as it happens (row on start, one row per line), so transcripts
// survive the end of the call and even a server restart.
export function startSession(channelId: string, userId: string) {
  if (sessions.has(channelId)) return;
  const session: TranscriptionSession = { id: snowflake(), channel_id: channelId, started_by: userId, started_at: Date.now(), entries: [] };
  q.run('INSERT INTO transcripts (id, channel_id, started_by, started_at) VALUES (?, ?, ?, ?)', session.id, channelId, userId, session.started_at);
  sessions.set(channelId, session);
  broadcastSession(channelId);
  warmUp();
}

function finishTranscript(id: string) {
  const hasLines = q.get('SELECT 1 FROM transcript_entries WHERE transcript_id = ?', id);
  if (hasLines) q.run('UPDATE transcripts SET ended_at = ? WHERE id = ? AND ended_at IS NULL', Date.now(), id);
  else q.run('DELETE FROM transcripts WHERE id = ?', id); // nothing was said: don't keep an empty record
}

export function stopSession(channelId: string) {
  const session = sessions.get(channelId);
  if (!session) return;
  sessions.delete(channelId);
  finishTranscript(session.id);
  broadcastSession(channelId);
}

// The live session ends when the last person leaves the call; the saved transcript stays.
channelEmptyHooks.push(stopSession);

// Sessions interrupted by a restart: close them (or drop them if empty).
for (const t of q.all<{ id: string }>('SELECT id FROM transcripts WHERE ended_at IS NULL')) {
  const last = q.get<{ at: number | null }>('SELECT MAX(at) AS at FROM transcript_entries WHERE transcript_id = ?', t.id)?.at;
  if (last) q.run('UPDATE transcripts SET ended_at = ? WHERE id = ?', last, t.id);
  else q.run('DELETE FROM transcripts WHERE id = ?', t.id);
}

// ---------- Saved transcripts ----------

export interface TranscriptRow {
  id: string;
  channel_id: string;
  started_by: string;
  started_at: number;
  ended_at: number | null;
}

export function transcriptSummary(t: TranscriptRow) {
  const stats = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM transcript_entries WHERE transcript_id = ?', t.id)!;
  const speakers = q.all<{ user_id: string }>('SELECT DISTINCT user_id FROM transcript_entries WHERE transcript_id = ?', t.id);
  return {
    ...t,
    active: sessions.get(t.channel_id)?.id === t.id,
    entry_count: stats.n,
    speaker_ids: speakers.map((s) => s.user_id),
  };
}

export function listTranscripts(channelId: string) {
  return q.all<TranscriptRow>('SELECT * FROM transcripts WHERE channel_id = ? ORDER BY started_at DESC LIMIT 100', channelId).map(transcriptSummary);
}

export function getTranscript(id: string): TranscriptRow | undefined {
  return q.get<TranscriptRow>('SELECT * FROM transcripts WHERE id = ?', id);
}

export function transcriptEntries(id: string): TranscriptEntry[] {
  return q.all<TranscriptEntry>('SELECT id, user_id, text, at FROM transcript_entries WHERE transcript_id = ? ORDER BY at', id);
}

export function deleteTranscript(t: TranscriptRow) {
  const live = sessions.get(t.channel_id);
  if (live?.id === t.id) {
    sessions.delete(t.channel_id);
    broadcastSession(t.channel_id);
  }
  q.run('DELETE FROM transcripts WHERE id = ?', t.id);
}

// ---------- Engines ----------

type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let localAsr: Promise<Asr> | null = null;

function loadLocal(): Promise<Asr> {
  localAsr ??= (async () => {
    const t = await import('@huggingface/transformers');
    t.env.cacheDir = path.join(DATA_DIR, 'models');
    console.log(`[transcription] loading ${LOCAL_MODEL} (first run downloads the model)…`);
    const asr = await t.pipeline('automatic-speech-recognition', LOCAL_MODEL, { dtype: 'q8' });
    console.log('[transcription] model ready');
    return asr as unknown as Asr;
  })().catch((err) => {
    localAsr = null;
    throw err;
  });
  return localAsr;
}

function wavFile(pcm: Int16Array): Blob {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  const file = new Uint8Array(44 + dataBytes);
  file.set(header, 0);
  file.set(new Uint8Array(pcm.buffer, pcm.byteOffset, dataBytes), 44);
  return new Blob([file], { type: 'audio/wav' });
}

async function transcribe(pcm: Int16Array): Promise<string> {
  if (transcriptionMode === 'api') {
    const form = new FormData();
    form.append('file', wavFile(pcm), 'audio.wav');
    form.append('model', API_MODEL);
    form.append('language', LANGUAGE);
    const res = await fetch(`${API_URL}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}` }, body: form });
    if (!res.ok) throw new Error(`transcription API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return String(((await res.json()) as { text?: string }).text ?? '');
  }
  const asr = await loadLocal();
  const audio = Float32Array.from(pcm, (v) => v / 32768);
  const out = await asr(audio, { language: WHISPER_LANGUAGES[LANGUAGE] ?? LANGUAGE, task: 'transcribe', chunk_length_s: 30 });
  return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text) ?? '';
}

// Whisper "hallucinates" these on silence or noise.
const HALLUCINATIONS = [/amara\.org/i, /legendas? (pela|por)/i, /inscreva-se/i, /^\W*$/, /^\s*\[.*\]\s*$/, /^\s*\(.*\)\s*$/];

/** Whisper invents sentences for near-silent input, so quiet segments are never transcribed. */
function isSilent(pcm: Int16Array): boolean {
  let sum = 0;
  for (const v of pcm) sum += v * v;
  return Math.sqrt(sum / pcm.length) / 32768 < 0.004;
}

function clean(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return HALLUCINATIONS.some((re) => re.test(t)) ? '' : t;
}

// ---------- Queue (one transcription at a time to keep CPU usage bounded) ----------

let queue: Promise<void> = Promise.resolve();
let pending = 0;

/** Returns false when the queue is full and the segment was dropped. */
export function enqueue(channelId: string, userId: string, pcm: Int16Array, spokenAt: number): boolean {
  if (process.env.TRANSCRIBE_DEBUG_DIR) {
    // Debug aid: keep every received segment as a .wav to inspect what clients actually send.
    void wavFile(pcm)
      .arrayBuffer()
      .then((buf) => fs.promises.writeFile(path.join(process.env.TRANSCRIBE_DEBUG_DIR!, `${spokenAt}-${userId}.wav`), Buffer.from(buf)));
  }
  if (isSilent(pcm)) return true;
  if (pending >= MAX_QUEUE) return false;
  pending++;
  queue = queue
    .then(async () => {
      const session = sessions.get(channelId);
      if (!session) return;
      const text = clean(await transcribe(pcm));
      if (!text || sessions.get(channelId) !== session) return;
      const entry: TranscriptEntry = { id: snowflake(), user_id: userId, text, at: spokenAt };
      q.run('INSERT INTO transcript_entries (transcript_id, id, user_id, text, at) VALUES (?, ?, ?, ?, ?)', session.id, entry.id, userId, text, spokenAt);
      session.entries.push(entry);
      session.entries.sort((a, b) => a.at - b.at);
      if (session.entries.length > 5000) session.entries.shift();
      dispatch(usersInVoiceChannel(channelId), 'TRANSCRIPT', { channel_id: channelId, entry });
    })
    .catch((err) => console.error('[transcription] failed:', err instanceof Error ? err.message : err))
    .finally(() => {
      pending--;
    });
  return true;
}

/** Loads the local model in the background so the first segment isn't slow. */
export function warmUp() {
  if (transcriptionMode === 'local') void loadLocal().catch((err) => console.error('[transcription] model load failed:', err.message));
}
