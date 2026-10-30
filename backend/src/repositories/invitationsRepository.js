// Employee invitations (Phase 2). Only sha256(token) is stored; see services/invitations.js.
import { pool } from '../db/pool.js';

/** pending | accepted | revoked | expired | failed (email could not be sent) */
// Expiry is decided by the database clock (is_expired), the same clock that set expires_at.
export function statusOf(row) {
  if (row.accepted_at) return 'accepted';
  if (row.send_error) return 'failed';
  if (row.revoked_at) return 'revoked';
  if (Number(row.is_expired)) return 'expired';
  return 'pending';
}

export const toInvitation = (row) =>
  row && {
    id: row.id,
    status: statusOf(row),
    email: row.email,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    sentAt: row.sent_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
    sendError: row.send_error,
    createdBy: row.created_by ? { id: row.created_by, fullName: row.created_by_name ?? null } : null,
  };

const SELECT = `
  SELECT i.*, i.expires_at <= NOW() AS is_expired, c.full_name AS created_by_name
  FROM user_invitations i LEFT JOIN users c ON c.id = i.created_by`;

export async function create(conn, { userId, tokenHash, email, createdBy, ttlHours }) {
  const [result] = await conn.execute(
    `INSERT INTO user_invitations (user_id, token_hash, email, created_by, expires_at)
     VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))`,
    [userId, tokenHash, email, createdBy, ttlHours],
  );
  return result.insertId;
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.query(`${SELECT} WHERE i.id = ?`, [id]);
  return rows[0] ?? null;
}

/** Revokes the user's open (not accepted, not revoked) invitations. Returns how many. */
export async function revokeOpen(conn, userId, revokedBy) {
  const [result] = await conn.execute(
    `UPDATE user_invitations SET revoked_at = NOW(), revoked_by = ?
     WHERE user_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    [revokedBy, userId],
  );
  return result.affectedRows;
}

export async function markSent(id) {
  await pool.execute('UPDATE user_invitations SET sent_at = NOW() WHERE id = ?', [id]);
}

/** The email could not be sent: the link must never become usable later. */
export async function markSendFailed(id, message) {
  await pool.execute(
    'UPDATE user_invitations SET revoked_at = COALESCE(revoked_at, NOW()), send_error = ? WHERE id = ?',
    [String(message).slice(0, 255), id],
  );
}

/** Invitation + its user by token hash. With conn, locks the invitation row. */
export async function findByTokenHash(tokenHash, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(
    `SELECT i.*, i.expires_at <= NOW() AS is_expired, u.email AS user_email, u.full_name AS user_full_name, u.is_active AS user_is_active,
            u.password_hash IS NOT NULL AS user_has_password
     FROM user_invitations i JOIN users u ON u.id = i.user_id
     WHERE i.token_hash = ?${forUpdate ? ' FOR UPDATE OF i' : ''}`,
    [tokenHash],
  );
  return rows[0] ?? null;
}

export async function markAccepted(conn, id) {
  await conn.execute('UPDATE user_invitations SET accepted_at = NOW() WHERE id = ?', [id]);
}

export async function listForUser(userId) {
  const [rows] = await pool.execute(`${SELECT} WHERE i.user_id = ? ORDER BY i.id DESC`, [userId]);
  return rows.map(toInvitation);
}

/** The most recent invitation of each user, keyed by user id. */
export async function latestByUser() {
  const [rows] = await pool.query(
    `SELECT * FROM (
       SELECT i.*, i.expires_at <= NOW() AS is_expired, c.full_name AS created_by_name,
              ROW_NUMBER() OVER (PARTITION BY i.user_id ORDER BY i.id DESC) AS rn
       FROM user_invitations i LEFT JOIN users c ON c.id = i.created_by
     ) latest WHERE rn = 1`,
  );
  return new Map(rows.map((r) => [r.user_id, toInvitation(r)]));
}
