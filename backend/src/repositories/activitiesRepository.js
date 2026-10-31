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

// The read side (the unified feed) is services/activities/feed.js.
