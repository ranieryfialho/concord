import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import multer from 'multer';
import { requireAuth } from './auth.js';
import { DATA_DIR, UPLOAD_DIR } from './db.js';
import { downloadsRouter } from './downloads.js';
import { attachGateway } from './gateway.js';
import { limits } from './ratelimit.js';
import { authRouter } from './routes/auth.js';
import { channelsRouter } from './routes/channels.js';
import { guildsRouter } from './routes/guilds.js';
import { invitesRouter } from './routes/invites.js';
import { usersRouter } from './routes/users.js';
import { livekitEnabled, voiceRouter } from './routes/voice.js';
import { transcriptionMode } from './transcription.js';
import { INLINE_EXTENSIONS, removeRequestFiles } from './uploads.js';
import { HttpError } from './util.js';

const PORT = Number(process.env.PORT ?? 3001);
const CLIENT_DIST = path.resolve(import.meta.dirname, '..', '..', 'client', 'dist');

const app = express();
app.disable('x-powered-by');
// Behind a reverse proxy (Caddy/nginx) set TRUST_PROXY=1 so rate limits see the real client IP.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!INLINE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) res.setHeader('Content-Disposition', 'attachment');
    },
  }),
);

app.use(downloadsRouter);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api', authRouter);
app.use('/api', requireAuth, limits.api, usersRouter, guildsRouter, channelsRouter, invitesRouter, voiceRouter);
app.use('/api', (_req, _res) => {
  throw new HttpError(404, 'Rota não encontrada');
});

// Serve the built web client (npm run build) so the desktop shell can load a single origin.
const livekitOrigin = livekitEnabled ? ` ${process.env.LIVEKIT_URL} ${process.env.LIVEKIT_URL!.replace(/^ws/, 'http')}` : '';
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", // https: for link-preview images
  "media-src 'self' blob:",
  `connect-src 'self' ws: wss:${livekitOrigin}`,
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

if (fs.existsSync(path.join(CLIENT_DIST, 'index.html'))) {
  app.use(express.static(CLIENT_DIST, { index: false }));
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    res.setHeader('Content-Security-Policy', CSP);
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
}

const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  removeRequestFiles(req.files ?? (req.file ? [req.file] : undefined));
  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message });
    return;
  }
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo grande demais' : 'Falha no upload';
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ message });
    return;
  }
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ message: 'JSON inválido' });
    return;
  }
  console.error(err);
  res.status(500).json({ message: 'Erro interno do servidor' });
};
app.use(errorHandler);

const server = http.createServer(app);
attachGateway(server);
server.listen(PORT, () => {
  console.log(
    `Concord server on http://localhost:${PORT}  (data: ${DATA_DIR}, voice: ${livekitEnabled ? 'livekit' : 'mesh'}, transcription: ${transcriptionMode})`,
  );
});
