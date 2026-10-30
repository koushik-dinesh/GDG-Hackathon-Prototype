// integration.sync: syncs one integration resource for one bounded chunk (services/integrations/sync.js).
// Payload: { resourceId }. The engine reschedules itself until the resource is caught up.
import { syncEngine } from '../../services/integrations/sync.js';

export const integrationSync = {
  async run(job) {
    await syncEngine.syncResource(job.payload.resourceId);
  },
  async onFailure(job, err, { final }) {
    if (final) await syncEngine.onFinalFailure(job.payload.resourceId, err);
  },
};
