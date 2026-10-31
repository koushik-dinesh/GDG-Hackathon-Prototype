// notifications.scan (Phase 10): hourly overdue-task, failed-job and daily-summary notifications. Idempotent: the
// notifications' dedupe keys make repeated scans harmless.
import { scan } from '../../services/notifications/triggers.js';
import { logger } from '../../utils/logger.js';

export const notificationsScan = {
  async run() {
    const stats = await scan();
    if (stats.overdue || stats.dead || stats.digests) logger.info('notifications scan', stats);
  },
};
