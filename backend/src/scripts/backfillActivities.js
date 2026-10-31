// Creates WorkAgent activities for history recorded before Phase 4, from the audit log.
// Usage: npm run activities:backfill   (safe to run again: activity keys are deterministic)
import { pool } from '../db/pool.js';
import { backfillFromAudit } from '../services/activities/internal.js';
import { logger } from '../utils/logger.js';

try {
  logger.info('activity backfill finished', await backfillFromAudit(pool));
} catch (err) {
  logger.error('activity backfill failed', { error: err.message });
  process.exitCode = 1;
} finally {
  await pool.end();
}
