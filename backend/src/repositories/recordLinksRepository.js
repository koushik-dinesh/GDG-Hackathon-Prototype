// Typed links between records (Phase 3A). Endpoints are polymorphic and have no foreign keys;
// services/integrations/links.js validates them and canonicalizes symmetric links before insert.
import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

export const toLink = (row) => ({
  id: row.id,
  from: { type: row.from_type, id: row.from_id },
  to: { type: row.to_type, id: row.to_id },
  linkType: row.link_type,
  origin: row.origin,
  status: row.status,
  confidence: row.confidence === null ? null : Number(row.confidence),
  evidence: parseJson(row.evidence),
  createdBy: row.created_by,
  reviewedBy: row.reviewed_by,
  reviewedAt: row.reviewed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Inserts unless the same (from, to, type) link exists. Returns { id, inserted }.
 * (ER_DUP_ENTRY, not affectedRows: mysql2's FOUND_ROWS makes a no-op upsert look like an insert.)
 */
export async function insertIfNew(conn, l) {
  try {
    const [result] = await conn.execute(
      `INSERT INTO record_links (from_type, from_id, to_type, to_id, link_type, origin, status, confidence, evidence, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [l.from.type, l.from.id, l.to.type, l.to.id, l.linkType, l.origin, l.status, l.confidence ?? null, l.evidence ? JSON.stringify(l.evidence) : null, l.createdBy ?? null],
    );
    return { id: result.insertId, inserted: true };
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
  }
  const [rows] = await conn.query(
    'SELECT id FROM record_links WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND link_type = ?',
    [l.from.type, l.from.id, l.to.type, l.to.id, l.linkType],
  );
  return { id: rows[0].id, inserted: false };
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM record_links WHERE id = ?', [id]);
  return rows[0] ? toLink(rows[0]) : null;
}

/** Links touching an endpoint, in either direction. */
export async function listFor({ type, id }, conn = pool) {
  const [rows] = await conn.query(
    'SELECT * FROM record_links WHERE (from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?) ORDER BY id',
    [type, id, type, id],
  );
  return rows.map(toLink);
}

/** Removes every link touching these endpoints (call when the internal rows are deleted). */
export async function deleteForEndpoints(conn, type, ids) {
  if (!ids.length) return 0;
  const [result] = await conn.query('DELETE FROM record_links WHERE (from_type = ? AND from_id IN (?)) OR (to_type = ? AND to_id IN (?))', [type, ids, type, ids]);
  return result.affectedRows;
}

export async function setReview(conn, id, { status, reviewedBy }) {
  await conn.execute('UPDATE record_links SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?', [status, reviewedBy, id]);
}

export async function listByStatus(status, { limit = 100 } = {}, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM record_links WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?', [status, limit]);
  return rows.map(toLink);
}

/** An existing link between the two endpoints of this type, in either stored direction. */
export async function findBetween(conn, { from, to, linkType }) {
  const [rows] = await conn.query(
    `SELECT * FROM record_links WHERE link_type = ? AND ((from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?)
       OR (from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?))`,
    [linkType, from.type, from.id, to.type, to.id, to.type, to.id, from.type, from.id],
  );
  return rows[0] ? toLink(rows[0]) : null;
}

/** Any link between the two endpoints, whatever its type, direction or status. */
export async function anyBetween(conn, a, b) {
  const [rows] = await conn.query(
    `SELECT id FROM record_links WHERE (from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?)
       OR (from_type = ? AND from_id = ? AND to_type = ? AND to_id = ?) LIMIT 1`,
    [a.type, a.id, b.type, b.id, b.type, b.id, a.type, a.id],
  );
  return rows.length > 0;
}

/** Withdraws inferred suggestions touching an endpoint (e.g. its record was deleted at the source). */
export async function withdrawSuggestions(conn, { type, id }) {
  const [result] = await conn.execute(
    `UPDATE record_links SET status = 'rejected', reviewed_at = NOW()
     WHERE status = 'suggested' AND origin IN ('rule', 'ai') AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?))`,
    [type, id, type, id],
  );
  return result.affectedRows;
}
