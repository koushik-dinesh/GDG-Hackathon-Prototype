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
