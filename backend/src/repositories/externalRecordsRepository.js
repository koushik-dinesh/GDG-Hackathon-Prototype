// Normalized external records (Phase 3A). Written only by services/integrations/ingest.js.
import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

export const toRecord = (row) => ({
  id: row.id,
  provider: row.provider,
  sourceInstance: row.source_instance,
  recordType: row.record_type,
  externalId: row.external_id,
  externalKey: row.external_key,
  connectionId: row.connection_id,
  resourceId: row.resource_id,
  parentRecordId: row.parent_record_id,
  url: row.url,
  title: row.title,
  body: row.body,
  state: row.state,
  statusCategory: row.status_category,
  authorIdentityId: row.author_identity_id,
  projectId: row.project_id,
  projectLocked: Boolean(row.project_locked),
  metadata: parseJson(row.metadata),
  contentHash: row.content_hash,
  sourceCreatedAt: row.source_created_at,
  sourceUpdatedAt: row.source_updated_at,
  sourceDeletedAt: row.source_deleted_at,
  firstSeenAt: row.first_seen_at,
  lastSyncedAt: row.last_synced_at,
});

/** The record with this source identity, locked when forUpdate (inside a transaction). */
export async function findBySource(conn, { provider, sourceInstance, recordType, externalId }, { forUpdate = false } = {}) {
  const [rows] = await conn.query(
    `SELECT * FROM external_records WHERE provider = ? AND source_instance = ? AND record_type = ? AND external_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [provider, sourceInstance, recordType, externalId],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM external_records WHERE id = ?', [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

const CONTENT = [
  ['externalKey', 'external_key'],
  ['connectionId', 'connection_id'],
  ['resourceId', 'resource_id'],
  ['parentRecordId', 'parent_record_id'],
  ['url', 'url'],
  ['title', 'title'],
  ['body', 'body'],
  ['state', 'state'],
  ['statusCategory', 'status_category'],
  ['authorIdentityId', 'author_identity_id'],
  ['projectId', 'project_id'],
  ['metadata', 'metadata'],
  ['contentHash', 'content_hash'],
  ['sourceCreatedAt', 'source_created_at'],
  ['sourceUpdatedAt', 'source_updated_at'],
  ['sourceDeletedAt', 'source_deleted_at'],
];

const value = (field, v) => (field === 'metadata' && v !== null && v !== undefined ? JSON.stringify(v) : v ?? null);

export async function insert(conn, record) {
  const [result] = await conn.execute(
    `INSERT INTO external_records (provider, source_instance, record_type, external_id, ${CONTENT.map(([, c]) => c).join(', ')})
     VALUES (?, ?, ?, ?, ${CONTENT.map(() => '?').join(', ')})`,
    [record.provider, record.sourceInstance, record.recordType, record.externalId, ...CONTENT.map(([f]) => value(f, record[f]))],
  );
  return result.insertId;
}

/** Replaces the content columns and stamps last_synced_at. */
export async function updateContent(conn, id, record) {
  await conn.execute(
    `UPDATE external_records SET ${CONTENT.map(([, c]) => `${c} = ?`).join(', ')}, last_synced_at = NOW() WHERE id = ?`,
    [...CONTENT.map(([f]) => value(f, record[f])), id],
  );
}

/**
 * A resource's project mapping changed: records that follow the resource (project_locked = FALSE)
 * move with it, and so do their activities. Returns { records, activities } counts.
 */
export async function reassignResourceProject(conn, resourceId, projectId) {
  const [records] = await conn.execute(
    'UPDATE external_records SET project_id = ? WHERE resource_id = ? AND project_locked = FALSE AND NOT (project_id <=> ?)',
    [projectId, resourceId, projectId],
  );
  const [activities] = await conn.execute(
    `UPDATE activities a JOIN external_records r ON r.id = a.external_record_id
     SET a.project_id = r.project_id
     WHERE r.resource_id = ? AND NOT (a.project_id <=> r.project_id)`,
    [resourceId],
  );
  return { records: records.affectedRows, activities: activities.affectedRows };
}

// ---- Read side (API) -------------------------------------------------------------------------
// Lists never include the body; detail does. Sort key: source update time (falls back to when the
// record was last written), newest first, with id as tie-breaker for keyset pagination.
const SORT_AT = 'COALESCE(r.source_updated_at, r.last_synced_at)';

const toPerson = (row) =>
  row.author_identity_id
    ? { identityId: row.author_identity_id, login: row.author_login, displayName: row.author_display_name, userId: row.author_user_id }
    : null;

export const toRecordSummary = (row) => ({
  id: row.id,
  provider: row.provider,
  recordType: row.record_type,
  externalKey: row.external_key,
  url: row.url,
  title: row.title,
  state: row.state,
  statusCategory: row.status_category,
  projectId: row.project_id,
  resourceId: row.resource_id,
  parentRecordId: row.parent_record_id,
  author: toPerson(row),
  sourceCreatedAt: row.source_created_at,
  sourceUpdatedAt: row.source_updated_at,
  sourceDeletedAt: row.source_deleted_at,
  sortAt: row.sort_at,
});

const READ_SELECT = `
  SELECT r.id, r.provider, r.record_type, r.external_key, r.url, r.title, r.state, r.status_category, r.project_id,
         r.resource_id, r.parent_record_id, r.author_identity_id, r.source_created_at, r.source_updated_at,
         r.source_deleted_at, ${SORT_AT} AS sort_at,
         i.login AS author_login, i.display_name AS author_display_name, i.user_id AS author_user_id
  FROM external_records r LEFT JOIN external_identities i ON i.id = r.author_identity_id`;

/**
 * projectId: number (that project), null (records with no project; admins only), undefined (all).
 * before: { sortAt: Date, id } keyset cursor. Returns limit+1 rows so the caller can tell if more exist.
 */
export async function listForRead({ projectId, recordType, statusCategory, q, before, limit }) {
  const where = [];
  const params = [];
  if (projectId === null) where.push('r.project_id IS NULL');
  else if (projectId !== undefined) {
    where.push('r.project_id = ?');
    params.push(projectId);
  }
  if (recordType) {
    where.push('r.record_type = ?');
    params.push(recordType);
  }
  if (statusCategory) {
    where.push('r.status_category = ?');
    params.push(statusCategory);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    where.push('(r.title LIKE ? OR r.external_key LIKE ?)');
    params.push(like, like);
  }
  if (before) {
    where.push(`(${SORT_AT} < ? OR (${SORT_AT} = ? AND r.id < ?))`);
    params.push(before.sortAt, before.sortAt, before.id);
  }
  const [rows] = await pool.query(
    `${READ_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY sort_at DESC, r.id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  return rows.map(toRecordSummary);
}

/** One record for the detail view (summary + body + metadata), or null. */
export async function findForRead(id) {
  const [rows] = await pool.query(`${READ_SELECT.replace('SELECT r.id,', 'SELECT r.body, r.metadata, r.id,')} WHERE r.id = ?`, [id]);
  if (!rows[0]) return null;
  return { ...toRecordSummary(rows[0]), body: rows[0].body, metadata: parseJson(rows[0].metadata) };
}

/** Sets a record's project by hand (locks it against resource re-mapping) and moves its activities. */
export async function setProjectManually(conn, id, projectId) {
  await conn.execute('UPDATE external_records SET project_id = ?, project_locked = TRUE WHERE id = ?', [projectId, id]);
  await conn.execute('UPDATE activities SET project_id = ? WHERE external_record_id = ?', [projectId, id]);
}
