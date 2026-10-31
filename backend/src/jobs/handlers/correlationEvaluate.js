// correlation.evaluate: runs the correlation matchers for one record, task or meeting and stores
// suggestions (services/correlation). Payload: { type, id }.
import { withTransaction } from '../../db/transaction.js';
import { evaluate } from '../../services/correlation/index.js';
import { logger } from '../../utils/logger.js';

export const correlationEvaluate = {
  async run(job) {
    const { type, id } = job.payload;
    const result = await withTransaction((conn) => evaluate(conn, { type, id }));
    if (result.suggested || result.withdrawn) logger.info('correlation evaluated', { type, id, ...result });
  },
};
