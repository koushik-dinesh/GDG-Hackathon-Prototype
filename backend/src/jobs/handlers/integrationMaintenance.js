// integration.maintenance: retention housekeeping, queued by the integration scheduler a few times
// a day (idempotent). Deletes webhook payloads past WEBHOOK_PAYLOAD_RETENTION_DAYS (the delivery
// history stays) and expired connect states.
import { config } from '../../config/index.js';
import * as authStates from '../../repositories/integrationAuthStatesRepository.js';
import * as deliveries from '../../repositories/webhookDeliveriesRepository.js';
import { logger } from '../../utils/logger.js';

export const integrationMaintenance = {
  async run() {
    const purged = await deliveries.purgePayloadsOlderThan(config.integrations.webhookRetentionDays);
    const states = await authStates.deleteExpired();
    if (purged || states) logger.info('integration maintenance', { purgedPayloads: purged, deletedStates: states });
  },
};
