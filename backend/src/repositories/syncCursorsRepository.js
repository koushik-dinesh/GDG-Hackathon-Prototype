// Sync checkpoints (Phase 3A): one row per resource and stream. The cursor itself is opaque to
// the framework; connectors define what goes in it.
import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

export const toCursor = (row) => ({
  resourceId: row.resource_id,
  stream: row.stream,
  phase: row.phase,
  cursor: parseJson(row.cursor_state),
  highWatermark: row.high_watermark,
  lastRunAt: row.last_run_at,
  completedAt: row.completed_at ?? null,
  lastErrorMessage: row.last_error_message,
  updatedAt: row.updated_at,
});

export async function find(resourceId, stream, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(
    `SELECT * FROM integration_sync_cursors WHERE resource_id = ? AND stream = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [resourceId, stream],
  );
  return rows[0] ? toCursor(rows[0]) : null;
}

export async function listForResource(resourceId, conn = pool) {
  const [rows] = await conn.query('SELECT * FROM integration_sync_cursors WHERE resource_id = ? ORDER BY stream', [resourceId]);
  return rows.map(toCursor);
}

/**
 * Saves a checkpoint (insert or replace). Call it in the same transaction as the data the chunk
 * produced, so progress is never lost or applied twice. high_watermark never moves backwards.
 */
export async function save(conn, { resourceId, stream, phase, cursor, highWatermark, lastErrorMessage = null, completed = false }) {
  await conn.execute(
    `INSERT INTO integration_sync_cursors (resource_id, stream, phase, cursor_state, high_watermark, last_run_at, completed_at, last_error_message)
     VALUES (?, ?, ?, ?, ?, NOW(), ${completed ? 'NOW()' : 'NULL'}, ?) AS new
     ON DUPLICATE KEY UPDATE
       phase = new.phase,
       cursor_state = new.cursor_state,
       high_watermark = GREATEST(COALESCE(integration_sync_cursors.high_watermark, new.high_watermark), COALESCE(new.high_watermark, integration_sync_cursors.high_watermark)),
       last_run_at = new.last_run_at,
       completed_at = new.completed_at,
       last_error_message = new.last_error_message`,
    [resourceId, stream, phase, cursor === undefined || cursor === null ? null : JSON.stringify(cursor), highWatermark ?? null, lastErrorMessage],
  );
}

/** The resource's run finished: the next run starts every stream again. */
export async function clearCompletion(resourceId, conn = pool) {
  await conn.execute('UPDATE integration_sync_cursors SET completed_at = NULL WHERE resource_id = ?', [resourceId]);
}
