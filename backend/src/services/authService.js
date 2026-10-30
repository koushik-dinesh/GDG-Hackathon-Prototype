import { createHash, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import * as sessions from '../repositories/sessionsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { logger } from '../utils/logger.js';

export const BCRYPT_ROUNDS = 12;

// Compared against when the email is unknown, so response time doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', BCRYPT_ROUNDS);

export const hashPassword = (plain) => bcrypt.hash(plain, BCRYPT_ROUNDS);

/** sha256 hex. Used for session ids and invitation tokens, which are high-entropy random values. */
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** URL-safe random token with 256 bits of entropy. */
export const randomToken = () => randomBytes(32).toString('base64url');

/** Returns the user row if the credentials are valid and the account is active, else null. */
export async function verifyCredentials(email, password) {
  const user = await users.findByEmailWithHash(email);
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok || !user.password_hash || !user.is_active) return null;
  return user;
}

/**
 * Starts a server-side session and returns the JWT that refers to it. The token is only valid
 * while the session row is live, so logout and deactivation take effect immediately.
 */
export async function signSession(userId, { ip, userAgent } = {}) {
  const sid = randomToken();
  const token = jwt.sign({ sub: String(userId), sid }, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.expiresIn,
  });
  const { exp, iat } = jwt.decode(token);
  const expiresAt = new Date(exp * 1000);
  await sessions.create(pool, { userId, sidHash: sha256(sid), ttlSeconds: exp - iat, ip, userAgent });
  // Best-effort cleanup of long-expired rows; never blocks a login.
  sessions.deleteExpired().catch((err) => logger.warn('session cleanup failed', { error: err.message }));
  return { token, expiresAt };
}

/**
 * Returns { userId, sessionId } for a valid token whose session is still live, or null.
 * Tokens issued before Phase 2 have no `sid` and are rejected (users sign in again once).
 */
export async function verifySession(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const userId = Number(payload.sub);
  if (!Number.isSafeInteger(userId) || userId <= 0 || typeof payload.sid !== 'string' || !payload.sid) return null;
  const session = await sessions.findActive(sha256(payload.sid), userId);
  return session ? { userId, sessionId: session.id } : null;
}

export const revokeSession = (sessionId, reason = 'logout') => sessions.revoke(sessionId, reason);
export const revokeAllSessions = (userId, reason, conn) => sessions.revokeAllForUser(userId, reason, conn);

export function sessionCookieOptions(expiresAt) {
  return {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: 'lax',
    path: '/',
    ...(expiresAt && { expires: expiresAt }),
  };
}
