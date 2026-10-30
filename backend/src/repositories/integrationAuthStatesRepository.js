// Single-use CSRF state for install/OAuth redirects (Phase 3A). Only sha256(state) is stored, the
// same pattern as invitation tokens. Expiry uses the database clock.
import { pool } from '../db/pool.js';

export async function create(conn, { provider, purpose, stateHash, userId, connectionId = null, ttlSeconds }) {
  const [result] = await conn.execute(
    `INSERT INTO integration_auth_states (provider, purpose, state_hash, user_id, connection_id, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [provider, purpose, stateHash, userId, connectionId, ttlSeconds],
  );
  return result.insertId;
}

/**
 * Consumes the state if it is open, unexpired, for this provider and was started by `userId`.
 * Returns { id, purpose, connectionId } or null. Call inside a transaction: the row is locked
 * and marked consumed, so a state can only ever be used once.
 */
export async function consume(conn, { stateHash, provider, userId }) {
  const [rows] = await conn.query(
    `SELECT id, purpose, connection_id, user_id, provider, consumed_at, expires_at <= NOW() AS is_expired
     FROM integration_auth_states WHERE state_hash = ? FOR UPDATE`,
    [stateHash],
  );
  const row = rows[0];
  if (!row || row.consumed_at || Number(row.is_expired) || row.provider !== provider || row.user_id !== userId) return null;
  await conn.execute('UPDATE integration_auth_states SET consumed_at = NOW() WHERE id = ?', [row.id]);
  return { id: row.id, purpose: row.purpose, connectionId: row.connection_id };
}

/** Housekeeping: removes states that expired more than a day ago. Returns how many. */
export async function deleteExpired(conn = pool) {
  const [result] = await conn.execute('DELETE FROM integration_auth_states WHERE expires_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
  return result.affectedRows;
}
