// Server-side sessions (Phase 2). The JWT carries a random session id (`sid`); only its sha256 is
// stored. A session authorizes requests while it exists, is not revoked and has not expired.
import { pool } from '../db/pool.js';

// expires_at is computed by the database clock (like every other NOW()-based check here).
export async function create(conn, { userId, sidHash, ttlSeconds, ip, userAgent }) {
  const [result] = await conn.execute(
    `INSERT INTO user_sessions (user_id, sid_hash, expires_at, ip, user_agent)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND), ?, ?)`,
    [userId, sidHash, ttlSeconds, ip ?? null, userAgent ? String(userAgent).slice(0, 255) : null],
  );
  return result.insertId;
}

/** The live session for this hash and user, or null. */
export async function findActive(sidHash, userId) {
  const [rows] = await pool.execute(
    `SELECT id, user_id FROM user_sessions
     WHERE sid_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > NOW()`,
    [sidHash, userId],
  );
  return rows[0] ?? null;
}

export async function revoke(id, reason, conn = pool) {
  const [result] = await conn.execute(
    'UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE id = ? AND revoked_at IS NULL',
    [reason, id],
  );
  return result.affectedRows;
}

/** Revokes every live session of a user (deactivation, password set). Returns how many. */
export async function revokeAllForUser(userId, reason, conn = pool) {
  const [result] = await conn.execute(
    'UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL',
    [reason, userId],
  );
  return result.affectedRows;
}

/** Housekeeping: drops sessions that expired more than a day ago. */
export async function deleteExpired() {
  await pool.execute('DELETE FROM user_sessions WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
}
