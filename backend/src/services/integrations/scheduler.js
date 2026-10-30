// Integration scheduler (docs/PHASE_3A_PLAN.md §8). Called from the worker loop: queues an
// `integration.sync` job for every resource that is due. Safe with several workers: the job's
// dedupe key allows only one active sync per resource.
import { pool } from '../../db/pool.js';
import * as queue from '../../jobs/queue.js';

export const syncDedupeKey = (resourceId) => `integration.sync:res:${resourceId}`;

/** Queues a sync for one resource unless one is already queued or running. Returns true if queued. */
export async function enqueueResourceSync(resourceId, conn = pool) {
  try {
    await queue.enqueue('integration.sync', { resourceId }, { dedupeKey: syncDedupeKey(resourceId), conn });
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

/** Resources that should be synced now: enabled, accessible, of an active, enabled, unpaused connection. */
export async function dueResourceIds({ limit = 50, connectionId } = {}) {
  const [rows] = await pool.query(
    `SELECT r.id FROM integration_resources r
     JOIN integration_connections c ON c.id = r.connection_id
     WHERE r.is_enabled = TRUE AND r.access_status = 'accessible'
       AND c.status = 'active' AND c.is_enabled = TRUE
       AND (c.paused_until IS NULL OR c.paused_until <= NOW())
       ${connectionId ? 'AND r.connection_id = ?' : 'AND (r.next_sync_at IS NULL OR r.next_sync_at <= NOW())'}
     ORDER BY r.next_sync_at IS NULL DESC, r.next_sync_at, r.id
     LIMIT ?`,
    connectionId ? [connectionId, limit] : [limit],
  );
  return rows.map((r) => r.id);
}

/** One scheduler pass. Returns how many sync jobs were queued. */
export async function tick({ limit = 50 } = {}) {
  let queued = 0;
  for (const id of await dueResourceIds({ limit })) {
    if (await enqueueResourceSync(id)) queued++;
  }
  return queued;
}

/**
 * Queues retention housekeeping unless it is already queued. The worker calls this every few
 * hours; the job is idempotent, so an extra run from a second worker is harmless.
 */
export async function enqueueMaintenance() {
  try {
    await queue.enqueue('integration.maintenance', {}, { dedupeKey: 'integration.maintenance' });
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

/** "Sync now" for a connection: queues every enabled resource regardless of next_sync_at. */
export async function syncConnectionNow(connectionId) {
  let queued = 0;
  for (const id of await dueResourceIds({ connectionId, limit: 1000 })) {
    if (await enqueueResourceSync(id)) queued++;
  }
  return queued;
}
