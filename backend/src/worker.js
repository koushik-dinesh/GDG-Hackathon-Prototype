// Background worker: polls the MySQL jobs table and runs handlers. Start with `npm run worker`.
// Several workers may run at once; claiming is safe (SKIP LOCKED).
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { handlersFor } from './jobs/handlers/index.js';
import { processNext, recover } from './jobs/runner.js';
import { claude } from './services/ai/claudeClient.js';
import { registry } from './services/integrations/registry.js';
import * as scheduler from './services/integrations/scheduler.js';
import { logger } from './utils/logger.js';

const workerId = `${hostname()}:${process.pid}`.slice(0, 64);
const RECOVER_EVERY_MS = 60_000;
const SCHEDULE_EVERY_MS = 60_000;
const MAINTENANCE_EVERY_MS = 6 * 60 * 60 * 1000;
// WORKER_JOB_TYPES lets a deployment dedicate workers (e.g. one only for integrations).
const handlers = handlersFor(config.jobs.workerTypes);
let stopping = false;

async function checkAi() {
  if (!handlers['ai.extract']) return;
  if (!claude.isConfigured()) {
    logger.warn('ANTHROPIC_API_KEY is not set; ai.extract jobs will fail until it is configured');
    return;
  }
  try {
    const model = await claude.verifyModel();
    logger.info('claude model verified', { model: model.id });
  } catch (err) {
    // Keep running: jobs fail with a clear error, and other job types are unaffected.
    logger.error('claude model check failed', { model: config.ai.model, error: err.message });
  }
}

async function main() {
  logger.info('worker starting', { workerId, types: Object.keys(handlers), pollMs: config.jobs.pollIntervalMs });
  await checkAi();
  const runsSync = Boolean(handlers['integration.sync']);
  if (runsSync) {
    const providers = registry.list();
    logger.info('integration providers', { providers: providers.map((p) => ({ id: p.id, available: p.available, problem: p.problem })) });
  }

  let lastRecover = 0;
  let lastSchedule = 0;
  let lastMaintenance = 0;
  const runsMaintenance = Boolean(handlers['integration.maintenance']);
  while (!stopping) {
    try {
      if (Date.now() - lastRecover > RECOVER_EVERY_MS) {
        await recover(handlers);
        lastRecover = Date.now();
      }
      // Only workers that run integration syncs schedule them (several such workers are fine).
      if (runsSync && Date.now() - lastSchedule > SCHEDULE_EVERY_MS) {
        const queued = await scheduler.tick();
        if (queued) logger.info('integration syncs queued', { queued });
        lastSchedule = Date.now();
      }
      if (runsMaintenance && Date.now() - lastMaintenance > MAINTENANCE_EVERY_MS) {
        await scheduler.enqueueMaintenance();
        lastMaintenance = Date.now();
      }
      const didWork = await processNext(workerId, handlers);
      if (!didWork) await sleep(config.jobs.pollIntervalMs);
    } catch (err) {
      // Database hiccups: log, back off, keep the worker alive.
      logger.error('worker loop error', { error: err.message });
      await sleep(Math.max(config.jobs.pollIntervalMs, 5000));
    }
  }
  await pool.end();
  logger.info('worker stopped', { workerId });
}

// Finish the current job, then exit. A second signal exits immediately; the job's lease
// expires and another worker picks it up.
function shutdown(signal) {
  if (stopping) process.exit(1);
  stopping = true;
  logger.info('worker stopping after current job', { signal });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  logger.error('worker crashed', { error: err.message });
  process.exit(1);
});
