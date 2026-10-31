// Queues relationship-suggestion evaluation (Phase 5) for existing records, approved tasks and
// meetings, e.g. after installing or adding a matcher. The worker does the evaluation.
// Usage: npm run correlation:queue   (safe to run again: one active job per subject)
import { pool } from '../db/pool.js';
import { queueEvaluation } from '../services/correlation/schedule.js';
import { logger } from '../utils/logger.js';

const SUBJECTS = [
  ['external_record', "SELECT id FROM external_records WHERE source_deleted_at IS NULL AND record_type <> 'repository'"],
  ['action_item', "SELECT id FROM action_items WHERE review_status = 'approved'"],
  ['meeting', 'SELECT id FROM meetings'],
];

try {
  const counts = {};
  for (const [type, sql] of SUBJECTS) {
    const [rows] = await pool.query(sql);
    counts[type] = { queued: 0, alreadyQueued: 0 };
    for (const { id } of rows) counts[type][(await queueEvaluation(pool, { type, id })) ? 'queued' : 'alreadyQueued'] += 1;
  }
  logger.info('correlation evaluation queued', counts);
} catch (err) {
  logger.error('correlation queueing failed', { error: err.message });
  process.exitCode = 1;
} finally {
  await pool.end();
}
