// correlation.evaluate: runs the correlation matchers for one record, task or meeting and stores
// suggestions (services/correlation). Payload: { type, id }.
import { withTransaction } from '../../db/transaction.js';
import { evaluate } from '../../services/correlation/index.js';
import { notifySuggestions } from '../../services/notifications/triggers.js';
import { logger } from '../../utils/logger.js';

export const correlationEvaluate = {
  async run(job) {
    const { type, id } = job.payload;
    const result = await withTransaction(async (conn) => {
      const r = await evaluate(conn, { type, id });
      // Phase 10: those who can decide new suggestions hear about them (at most once a day).
      // A notification problem never costs the suggestions themselves.
      if (r.suggested) await notifySuggestions(conn, r.projectPairs).catch((err) => logger.error('suggestion notification failed', { error: err.message }));
      return r;
    });
    if (result.suggested || result.withdrawn) logger.info('correlation evaluated', { type, id, suggested: result.suggested, withdrawn: result.withdrawn });
  },
};
