// People and bots in source systems (Phase 3A), optionally matched to a WorkAgent user.
import { pool } from '../db/pool.js';

export const toIdentity = (row) => ({
  id: row.id,
  provider: row.provider,
  sourceInstance: row.source_instance,
  externalUserId: row.external_user_id,
  login: row.login,
  displayName: row.display_name,
  email: row.email,
  isBot: Boolean(row.is_bot),
  userId: row.user_id,
  matchMethod: row.match_method,
  matchedBy: row.matched_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Inserts the identity or refreshes its profile fields. Values the provider did not send (null)
 * keep what is stored, and the user match is never touched here. Returns { id, inserted }.
 */
export async function upsert(conn, { provider, sourceInstance, externalUserId, login, displayName, email, isBot }) {
  const key = [provider, sourceInstance, externalUserId];
  const profile = [login ?? null, displayName ?? null, email ?? null, Boolean(isBot)];
  try {
    const [result] = await conn.execute(
      `INSERT INTO external_identities (provider, source_instance, external_user_id, login, display_name, email, is_bot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [...key, ...profile],
    );
    return { id: result.insertId, inserted: true };
  } catch (err) {
    // ER_DUP_ENTRY rather than ON DUPLICATE KEY: mysql2's FOUND_ROWS hides whether a row was inserted.
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
  await conn.execute(
    `UPDATE external_identities
     SET login = COALESCE(?, login), display_name = COALESCE(?, display_name), email = COALESCE(?, email), is_bot = ?
     WHERE provider = ? AND source_instance = ? AND external_user_id = ?`,
    [...profile, ...key],
  );
  const [rows] = await conn.query('SELECT id FROM external_identities WHERE provider = ? AND source_instance = ? AND external_user_id = ?', key);
  return { id: rows[0].id, inserted: false };
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM external_identities WHERE id = ?', [id]);
  return rows[0] ? toIdentity(rows[0]) : null;
}

export async function findBySource(conn, { provider, sourceInstance, externalUserId }) {
  const [rows] = await conn.query(
    'SELECT * FROM external_identities WHERE provider = ? AND source_instance = ? AND external_user_id = ?',
    [provider, sourceInstance, externalUserId],
  );
  return rows[0] ? toIdentity(rows[0]) : null;
}

/** Sets the automatic match only if nobody has matched the identity yet. Returns true if set. */
export async function setAutoMatch(conn, id, { userId, method }) {
  const [result] = await conn.execute(
    "UPDATE external_identities SET user_id = ?, match_method = ? WHERE id = ? AND match_method = 'none' AND user_id IS NULL",
    [userId, method, id],
  );
  return result.affectedRows === 1;
}
