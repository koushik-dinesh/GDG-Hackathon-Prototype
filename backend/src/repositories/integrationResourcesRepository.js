// Integration resources (Phase 3A): the repositories, projects, channels or files a connection
// exposes. Syncing is opt-in per resource (is_enabled defaults to FALSE).
import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

export const toResource = (row) => ({
  id: row.id,
  connectionId: row.connection_id,
  resourceType: row.resource_type,
  externalId: row.external_id,
  name: row.name,
  url: row.url,
  accessStatus: row.access_status,
  isEnabled: Boolean(row.is_enabled),
  projectId: row.project_id,
  metadata: parseJson(row.metadata),
  nextSyncAt: row.next_sync_at,
  initialSyncCompletedAt: row.initial_sync_completed_at,
  lastSyncedAt: row.last_synced_at,
  lastErrorMessage: row.last_error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const COLUMNS = {
  name: 'name',
  url: 'url',
  accessStatus: 'access_status',
  isEnabled: 'is_enabled',
  projectId: 'project_id',
  metadata: 'metadata',
  nextSyncAt: 'next_sync_at',
  initialSyncCompletedAt: 'initial_sync_completed_at',
  lastSyncedAt: 'last_synced_at',
  lastErrorMessage: 'last_error_message',
};

/**
 * Inserts the resource or refreshes its name/url/metadata (renames happen at the source) and
 * marks it accessible again. Admin choices (is_enabled, project_id) are never touched here.
 * Returns the resource id.
 */
export async function upsert(conn, connectionId, { resourceType, externalId, name, url, metadata }) {
  const [result] = await conn.execute(
    `INSERT INTO integration_resources (connection_id, resource_type, external_id, name, url, metadata)
     VALUES (?, ?, ?, ?, ?, ?) AS new
     ON DUPLICATE KEY UPDATE
       id = LAST_INSERT_ID(integration_resources.id),
       name = new.name, url = new.url, metadata = new.metadata, access_status = 'accessible'`,
    [connectionId, resourceType, String(externalId), name, url ?? null, metadata ? JSON.stringify(metadata) : null],
  );
  return result.insertId;
}

export async function findById(id, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`SELECT * FROM integration_resources WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  return rows[0] ? toResource(rows[0]) : null;
}

export async function listForConnection(connectionId, conn = pool) {
  const [rows] = await conn.query(
    'SELECT * FROM integration_resources WHERE connection_id = ? ORDER BY access_status, name, id',
    [connectionId],
  );
  return rows.map(toResource);
}

/** Marks resources of this type that the provider no longer lists as removed. Returns how many. */
export async function markRemovedExcept(conn, connectionId, resourceType, keepExternalIds) {
  const keep = keepExternalIds.map(String);
  const [result] = await conn.query(
    `UPDATE integration_resources SET access_status = 'removed'
     WHERE connection_id = ? AND resource_type = ? AND access_status = 'accessible'
       ${keep.length ? 'AND external_id NOT IN (?)' : ''}`,
    keep.length ? [connectionId, resourceType, keep] : [connectionId, resourceType],
  );
  return result.affectedRows;
}

export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  for (const [field] of entries) {
    if (!COLUMNS[field]) throw new Error(`Unknown resource field: ${field}`);
  }
  if (entries.length === 0) return 0;
  const [result] = await conn.execute(
    `UPDATE integration_resources SET ${entries.map(([f]) => `${COLUMNS[f]} = ?`).join(', ')} WHERE id = ?`,
    [...entries.map(([f, v]) => (f === 'metadata' && v ? JSON.stringify(v) : v)), id],
  );
  return result.affectedRows;
}
