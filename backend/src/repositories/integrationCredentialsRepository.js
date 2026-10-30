// Encrypted integration credentials (Phase 3A). Only services/integrations/vault.js may import this
// module: rows hold ciphertext, and nothing here is ever part of an API response.
import { pool } from '../db/pool.js';

const toSealed = (row) => ({
  id: row.id,
  connectionId: row.connection_id,
  kind: row.kind,
  keyId: row.key_id,
  iv: row.iv,
  authTag: row.auth_tag,
  ciphertext: row.ciphertext,
  expiresAt: row.expires_at,
  updatedAt: row.updated_at,
});

/** Inserts or replaces the credential of this kind for the connection. */
export async function upsert(conn, { connectionId, kind, sealed, expiresAt = null }) {
  await conn.execute(
    `INSERT INTO integration_credentials (connection_id, kind, key_id, iv, auth_tag, ciphertext, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE key_id = new.key_id, iv = new.iv, auth_tag = new.auth_tag,
                             ciphertext = new.ciphertext, expires_at = new.expires_at`,
    [connectionId, kind, sealed.keyId, sealed.iv, sealed.authTag, sealed.ciphertext, expiresAt],
  );
}

export async function find(connectionId, kind, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(
    `SELECT * FROM integration_credentials WHERE connection_id = ? AND kind = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [connectionId, kind],
  );
  return rows[0] ? toSealed(rows[0]) : null;
}

export async function findByIdForUpdate(conn, id) {
  const [rows] = await conn.query('SELECT * FROM integration_credentials WHERE id = ? FOR UPDATE', [id]);
  return rows[0] ? toSealed(rows[0]) : null;
}

/** Re-encrypts in place (rotation); expiry is unchanged. */
export async function replaceSealed(conn, id, sealed) {
  await conn.execute('UPDATE integration_credentials SET key_id = ?, iv = ?, auth_tag = ?, ciphertext = ? WHERE id = ?', [
    sealed.keyId,
    sealed.iv,
    sealed.authTag,
    sealed.ciphertext,
    id,
  ]);
}

/** Ids of rows encrypted with a key other than `keyId`, oldest first. */
export async function listIdsNotOnKey(keyId, { afterId = 0, limit = 100 } = {}) {
  const [rows] = await pool.query('SELECT id FROM integration_credentials WHERE key_id <> ? AND id > ? ORDER BY id LIMIT ?', [keyId, afterId, limit]);
  return rows.map((r) => r.id);
}

export async function kindsForConnection(connectionId, conn = pool) {
  const [rows] = await conn.query('SELECT kind, expires_at FROM integration_credentials WHERE connection_id = ? ORDER BY kind', [connectionId]);
  return rows.map((r) => ({ kind: r.kind, expiresAt: r.expires_at }));
}

/** Deletes every credential of the connection (disconnect). Returns how many. */
export async function deleteForConnection(conn, connectionId) {
  const [result] = await conn.execute('DELETE FROM integration_credentials WHERE connection_id = ?', [connectionId]);
  return result.affectedRows;
}
