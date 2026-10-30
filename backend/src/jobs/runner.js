// Executes one claimed job with its handler: heartbeat while running, then complete or fail.
// Handlers are { run(job), onFailure?(job, error, { final }) }.
import { logger } from '../utils/logger.js';
import * as queue from './queue.js';

const HEARTBEAT_MS = 30_000;

export async function runJob(job, handlers) {
  const handler = handlers[job.type];
  const started = Date.now();
  const log = { jobId: job.id, type: job.type, attempt: job.attempts };

  const beat = setInterval(() => {
    queue.heartbeat(job).catch((err) => logger.warn('job heartbeat failed', { ...log, error: err.message }));
  }, HEARTBEAT_MS);
  beat.unref();

  try {
    if (!handler) throw new queue.PermanentJobError(`No handler registered for job type "${job.type}"`);
    await handler.run(job);
    await queue.complete(job);
    logger.info('job succeeded', { ...log, ms: Date.now() - started });
    return { ok: true };
  } catch (err) {
    if (err instanceof queue.RescheduleJob) {
      await queue.reschedule(job, err.delayMs);
      logger.debug('job rescheduled', { ...log, delayMs: err.delayMs, reason: err.message });
      return { ok: true, rescheduled: true };
    }
    const { final, status, owned } = await queue.fail(job, err);
    if (!owned) {
      // The lease expired and the job was recovered (maybe re-claimed by another worker). Running
      // the failure hook now could mark a meeting or email failed while the new owner works on it.
      logger.warn('job failed after its lease was lost; failure not recorded', { ...log, error: err.message, ms: Date.now() - started });
      return { ok: false, final: false, status: 'lost_lease' };
    }
    // Never log payloads or provider responses here; they may contain transcript text.
    logger[final ? 'error' : 'warn']('job failed', { ...log, status, final, error: err.message, ms: Date.now() - started });
    if (handler?.onFailure) {
      try {
        await handler.onFailure(job, err, { final });
      } catch (hookErr) {
        logger.error('job failure hook failed', { ...log, error: hookErr.message });
      }
    }
    return { ok: false, final, status };
  } finally {
    clearInterval(beat);
  }
}

/** Marks jobs whose lease expired as pending again, and runs failure hooks for ones that died. */
export async function recover(handlers) {
  const { requeued, dead } = await queue.recoverStaleJobs();
  for (const job of dead) {
    const handler = handlers[job.type];
    if (handler?.onFailure) {
      try {
        await handler.onFailure(job, new Error(job.lastError), { final: true });
      } catch (err) {
        logger.error('job failure hook failed', { jobId: job.id, error: err.message });
      }
    }
  }
  return { requeued, dead: dead.length };
}

/** Claims and runs at most one job. Returns false when the queue had nothing due. */
export async function processNext(workerId, handlers) {
  const job = await queue.claimNext(workerId, Object.keys(handlers));
  if (!job) return false;
  await runJob(job, handlers);
  return true;
}
