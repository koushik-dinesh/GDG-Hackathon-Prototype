// Activities (Phase 3A): append-only events keyed by meaning (dedupe_key).
import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

export const toActivity = (row) => ({
  id: row.id,
  dedupeKey: row.dedupe_key,
  provider: row.provider,
  activityType: row.activity_type,
  externalRecordId: row.external_record_id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  actorIdentityId: row.actor_identity_id,
  actorUserId: row.actor_user_id,
  projectId: row.project_id,
  occurredAt: row.occurred_at,
  summary: row.summary,
  details: parseJson(row.details),
  origin: row.origin,
  webhookDeliveryId: row.webhook_delivery_id,
  createdAt: row.created_at,
});

/**
 * Inserts unless an activity with the same dedupe_key exists. Returns true when inserted.
 * (Duplicate detection uses ER_DUP_ENTRY: mysql2 sets FOUND_ROWS, so affectedRows of an
 * ON DUPLICATE KEY no-op is 1, the same as an insert.)
 */
export async function insertIfNew(conn, a) {
  try {
    await insertActivity(conn, a);
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

async function insertActivity(conn, a) {
  await conn.execute(
    `INSERT INTO activities
       (dedupe_key, provider, activity_type, external_record_id, entity_type, entity_id, actor_identity_id, actor_user_id,
        project_id, occurred_at, summary, details, origin, webhook_delivery_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      a.dedupeKey,
      a.provider,
      a.activityType,
      a.externalRecordId ?? null,
      a.entityType ?? null,
      a.entityId ?? null,
      a.actorIdentityId ?? null,
      a.actorUserId ?? null,
      a.projectId ?? null,
      a.occurredAt,
      a.summary,
      a.details ? JSON.stringify(a.details) : null,
      a.origin,
      a.webhookDeliveryId ?? null,
    ],
  );
}

/** Keeps the activities of a record on the record's project. */
export async function syncProjectForRecord(conn, recordId, projectId) {
  await conn.execute('UPDATE activities SET project_id = ? WHERE external_record_id = ? AND NOT (project_id <=> ?)', [projectId, recordId, projectId]);
}

export async function listForRecord(recordId, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM activities WHERE external_record_id = ? ORDER BY occurred_at, id', [recordId]);
  return rows.map(toActivity);
}

// ---- Read side (API) -------------------------------------------------------------------------
const READ_SELECT = `
  SELECT a.id, a.provider, a.activity_type, a.external_record_id, a.project_id, a.occurred_at, a.summary, a.details, a.origin,
         i.id AS actor_identity_id, i.login AS actor_login, i.display_name AS actor_display_name, i.user_id AS actor_user_id,
         r.record_type, r.external_key, r.title AS record_title, r.url AS record_url
  FROM activities a
  LEFT JOIN external_identities i ON i.id = a.actor_identity_id
  LEFT JOIN external_records r ON r.id = a.external_record_id`;

export const toActivityView = (row) => ({
  id: row.id,
  provider: row.provider,
  activityType: row.activity_type,
  occurredAt: row.occurred_at,
  summary: row.summary,
  details: parseJson(row.details),
  origin: row.origin,
  projectId: row.project_id,
  actor: row.actor_identity_id
    ? { identityId: row.actor_identity_id, login: row.actor_login, displayName: row.actor_display_name, userId: row.actor_user_id }
    : null,
  record: row.external_record_id
    ? { id: row.external_record_id, recordType: row.record_type, externalKey: row.external_key, title: row.record_title, url: row.record_url }
    : null,
});

/**
 * Timeline, newest first. projectId: number | null (no project; admins) | undefined (all).
 * before: { occurredAt: Date, id }. Returns limit+1 rows.
 */
export async function listForRead({ projectId, recordId, before, limit }) {
  const where = [];
  const params = [];
  if (projectId === null) where.push('a.project_id IS NULL');
  else if (projectId !== undefined) {
    where.push('a.project_id = ?');
    params.push(projectId);
  }
  if (recordId) {
    where.push('a.external_record_id = ?');
    params.push(recordId);
  }
  if (before) {
    where.push('(a.occurred_at < ? OR (a.occurred_at = ? AND a.id < ?))');
    params.push(before.occurredAt, before.occurredAt, before.id);
  }
  const [rows] = await pool.query(
    `${READ_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  return rows.map(toActivityView);
}
