import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { recordInternalActivities } from './activities/internal.js';
import { scheduleForAudit } from './correlation/schedule.js';

/**
 * Writes an audit entry on `conn` and throws on failure. Use inside a transaction when the
 * audit row must commit or roll back together with the change it describes.
 * Changes that are also work events (task completed, meeting conducted, …) add an activity
 * in the same transaction (Phase 4, services/activities/internal.js).
 */
export async function recordAudit(conn, { actorUserId = null, action, entityType, entityId = null, before = null, after = null, ip = null }) {
  const [result] = await conn.execute(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_json, after_json, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [actorUserId, action, entityType, entityId, before && JSON.stringify(before), after && JSON.stringify(after), ip],
  );
  try {
    await recordInternalActivities(conn, { auditId: result.insertId, action, entityId, actorUserId, before, after });
    // Phase 5: tasks and meetings that changed are re-evaluated for relationship suggestions.
    await scheduleForAudit(conn, { action, entityId });
  } catch (err) {
    // A failed statement doesn't abort the MySQL transaction; the change itself stands.
    logger.error('internal activity not recorded', { action, entityId, error: err.message });
  }
  return result.insertId;
}

// Records an audit entry. Audit failures are logged but never break the request.
export async function audit(entry) {
  try {
    await recordAudit(pool, entry);
  } catch (err) {
    logger.error('audit write failed', { action: entry.action, error: err.message });
  }
}
