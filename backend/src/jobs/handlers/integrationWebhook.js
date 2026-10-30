// integration.webhook: processes one stored webhook delivery (services/integrations/webhooks.js).
// Payload: { deliveryId } (the webhook_deliveries row id; never the payload itself).
import { webhookService } from '../../services/integrations/webhooks.js';

export const integrationWebhook = {
  async run(job) {
    await webhookService.processDelivery(job.payload.deliveryId);
  },
  async onFailure(job, err, { final }) {
    if (final) await webhookService.onFinalFailure(job.payload.deliveryId, err);
  },
};
