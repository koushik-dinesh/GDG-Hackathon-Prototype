// Queues correlation re-evaluation (Phase 5) when something that matchers look at appears or
// changes: synced records (ingest), approved tasks and meetings (audit hook). One pending job per
// subject (dedupe key), so a burst of changes is evaluated once.
import * as queue from '../../jobs/queue.js';

export const CORRELATION_JOB = 'correlation.evaluate';
const dedupeKey = ({ type, id }) => `correlation:${type}:${id}`;

/** Queues an evaluation; with `conn` it commits with the change. Duplicates are ignored. */
export async function queueEvaluation(conn, ref) {
  try {
    await queue.enqueue(CORRELATION_JOB, { type: ref.type, id: ref.id }, { dedupeKey: dedupeKey(ref), conn });
    return true;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return false;
    throw err;
  }
}

// Audit actions that change what a task or meeting says or where it belongs.
const TASK_ACTIONS = ['action_item.approved', 'action_item.updated', 'action_item.project_changed'];
const MEETING_ACTIONS = ['meeting.created', 'meeting.updated', 'transcript.uploaded', 'transcript.imported_from_vexa', 'meeting.review_completed'];

/** Evaluations an audited change calls for (called from services/audit.js). */
export async function scheduleForAudit(conn, { action, entityId }) {
  if (TASK_ACTIONS.includes(action)) return queueEvaluation(conn, { type: 'action_item', id: entityId });
  if (MEETING_ACTIONS.includes(action)) {
    await queueEvaluation(conn, { type: 'meeting', id: entityId });
    if (action === 'meeting.review_completed') {
      const [items] = await conn.query("SELECT id FROM action_items WHERE meeting_id = ? AND review_status = 'approved'", [entityId]);
      for (const i of items) await queueEvaluation(conn, { type: 'action_item', id: i.id });
    }
    return true;
  }
  return false;
}
