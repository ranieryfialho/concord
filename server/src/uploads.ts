import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { UPLOAD_DIR } from './db.js';
import { snowflake } from './util.js';

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path
      .extname(file.originalname)
      .toLowerCase()
      .replace(/[^a-z0-9.]/g, '')
      .slice(0, 10);
    cb(null, snowflake() + ext);
  },
});

export const uploadFiles = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 10 } });

export const uploadImage = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(png|jpeg|gif|webp)$/.test(file.mimetype)),
});

/** Extensions served inline; everything else is forced to download so uploads can't run as pages. */
export const INLINE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp',
  '.mp4', '.webm', '.mov',
  '.mp3', '.ogg', '.wav', '.m4a',
]);

/** Busboy decodes multipart filenames as latin1; recover the UTF-8 original. */
export function originalName(file: Express.Multer.File): string {
  return Buffer.from(file.originalname, 'latin1').toString('utf8').slice(0, 200);
}

export function publicUrl(file: Express.Multer.File): string {
  return `/uploads/${file.filename}`;
}

export function removeUpload(url: string | null | undefined) {
  if (!url?.startsWith('/uploads/')) return;
  fs.rm(path.join(UPLOAD_DIR, path.basename(url)), { force: true }, () => {});
}

export function removeRequestFiles(files: unknown) {
  const list = Array.isArray(files) ? files : files && typeof files === 'object' ? Object.values(files).flat() : [];
  for (const f of list as Express.Multer.File[]) if (f?.path) fs.rm(f.path, { force: true }, () => {});
}
