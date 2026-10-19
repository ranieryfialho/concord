import { Router } from 'express';
import { createSession, deleteSession, deleteSessions, hashPassword, requireAuth, verifyPassword } from '../auth.js';
import { q } from '../db.js';
import { type UserRow, getUser, privateUser } from '../models.js';
import { limits } from '../ratelimit.js';
import { issueRecoveryCode, recoveryCodeMatches } from '../recovery.js';
import { HttpError, optionalText, snowflake, text } from '../util.js';

export const authRouter = Router();

const USERNAME = /^[a-zA-Z0-9_.]{2,32}$/;

authRouter.post('/auth/register', limits.register, (req, res) => {
  const username = text(req.body?.username, 'Nome de usuário', { min: 2, max: 32 });
  if (!USERNAME.test(username)) throw new HttpError(400, 'Use apenas letras, números, "_" e "."');
  const password = text(req.body?.password, 'Senha', { min: 6, max: 128 });
  const displayName = optionalText(req.body?.display_name, 'Nome de exibição', 32) ?? null;
  if (q.get('SELECT 1 FROM users WHERE username = ?', username)) throw new HttpError(409, 'Esse nome de usuário já existe');

  const id = snowflake();
  q.run(
    'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    username,
    displayName,
    hashPassword(password),
    Date.now(),
  );
  const recoveryCode = issueRecoveryCode(id);
  res.status(201).json({ token: createSession(id), user: privateUser(getUser(id)!), recovery_code: recoveryCode });
});

authRouter.post('/auth/login', limits.login, (req, res) => {
  const username = text(req.body?.username, 'Nome de usuário', { max: 32 });
  const password = text(req.body?.password, 'Senha', { max: 128 });
  const user = q.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Usuário ou senha incorretos');
  res.json({ token: createSession(user.id), user: privateUser(user) });
});

// Forgot-password flow: username + recovery code + new password. Every session is revoked and the used code is replaced.
authRouter.post('/auth/reset-password', limits.resetIp, limits.resetAccount, (req, res) => {
  const username = text(req.body?.username, 'Nome de usuário', { max: 32 });
  const code = text(req.body?.recovery_code, 'Código de recuperação', { max: 64 });
  const password = text(req.body?.new_password, 'Nova senha', { min: 6, max: 128 });
  const user = q.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  if (!user || !recoveryCodeMatches(user.recovery_hash, code)) throw new HttpError(401, 'Usuário ou código de recuperação incorretos');

  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
  deleteSessions(user.id);
  const recoveryCode = issueRecoveryCode(user.id);
  res.json({ token: createSession(user.id), user: privateUser(getUser(user.id)!), recovery_code: recoveryCode });
});

authRouter.post('/auth/logout', requireAuth, (req, res) => {
  deleteSession(String(req.headers.authorization));
  res.status(204).end();
});
