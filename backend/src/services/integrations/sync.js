// Resource sync (docs/PHASE_3A_PLAN.md §8). One `integration.sync` job per resource:
//
// - Works through the connector's streams in bounded chunks (time, requests, chunk count). Each
//   chunk's envelopes and its cursor commit in one transaction, so a crash never loses progress
//   or applies it twice. When the budget runs out the job reschedules itself immediately, which
//   lets other job types (email, AI) run in between.
// - backfill -> incremental per stream; `since` is the backfill window or the high watermark
//   minus a small overlap (safe because ingest is idempotent).
// - Provider errors become job outcomes and connection health (§5.2). Rate limits pause the whole
//   connection (shared by every worker) and never consume a job attempt.
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';
import { PermanentJobError, RescheduleJob } from '../../jobs/queue.js';
import * as connections from '../../repositories/integrationConnectionsRepository.js';
import * as resources from '../../repositories/integrationResourcesRepository.js';
import * as cursors from '../../repositories/syncCursorsRepository.js';
import { logger } from '../../utils/logger.js';
import { buildContext } from './context.js';
import { CredentialsUnreadableError } from './crypto.js';
import { ProviderError } from './errors.js';
import { ingest } from './ingest.js';
import { registry as defaultRegistry } from './registry.js';

const OVERLAP_MS = 2 * 60 * 1000;
const MAX_CHUNKS_PER_JOB = 50;
const FAILING_AFTER = 3;

const later = (ms) => new Date(Date.now() + ms);
const message = (err) => String(err?.publicMessage ?? err?.message ?? err).slice(0, 500);

/** Marks the connection healthy after a successful run. */
async function recordSuccess(connectionId, rateLimit) {
  await connections.update(pool, connectionId, {
    health: 'healthy',
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastSyncSucceededAt: new Date(),
    rateLimitRemaining: rateLimit?.remaining ?? undefined,
  });
}

async function recordFailure(connection, err, extra = {}) {
  const failures = connection.consecutiveFailures + 1;
  await connections.update(pool, connection.id, {
    health: failures >= FAILING_AFTER ? 'failing' : 'degraded',
    consecutiveFailures: failures,
    lastErrorCode: err.kind ?? err.name ?? 'error',
    lastErrorMessage: message(err),
    ...extra,
  });
}

async function pauseConnection(connectionId, until) {
  await connections.update(pool, connectionId, { pausedUntil: until });
  return new RescheduleJob(Math.max(1000, until.getTime() - Date.now()), 'provider rate limit');
}

/**
 * Turns a failure into what the job should do. Returns an error to throw (RescheduleJob,
 * PermanentJobError or the original retryable error) or null when the job should just finish.
 */
async function handleFailure(err, { connection, resource }) {
  const resourceError = (msg) => resources.update(pool, resource.id, { lastErrorMessage: msg.slice(0, 500), nextSyncAt: later(config.integrations.syncIntervalMs) });

  if (err instanceof CredentialsUnreadableError) {
    await recordFailure(connection, Object.assign(err, { kind: 'credentials_unreadable', publicMessage: 'Stored credentials cannot be read; reconnect the integration' }), { status: 'error', health: 'failing' });
    await resourceError('Reconnect the integration: its stored credentials cannot be read');
    return new PermanentJobError(err.message);
  }
  if (!(err instanceof ProviderError)) return err; // database or programming error: retry with backoff

  switch (err.kind) {
    case 'rate_limited':
      return pauseConnection(connection.id, new Date(Date.now() + err.waitMs()));
    case 'transient':
      await recordFailure(connection, err);
      return err;
    case 'auth':
      await recordFailure(connection, err, { status: 'error', health: 'failing' });
      await resourceError(err.publicMessage);
      return new PermanentJobError(err.message, { publicMessage: err.publicMessage });
    case 'suspended':
      await connections.update(pool, connection.id, { status: 'suspended', lastErrorCode: 'suspended', lastErrorMessage: err.publicMessage });
      return null;
    case 'not_found':
      await resources.update(pool, resource.id, { accessStatus: 'removed', lastErrorMessage: err.publicMessage });
      return null;
    default:
      await recordFailure(connection, err);
      await resourceError(err.publicMessage);
      return new PermanentJobError(err.message, { publicMessage: err.publicMessage });
  }
}

export function createSyncEngine({ registry = defaultRegistry, budget: defaultBudget = config.integrations.chunkBudget } = {}) {
  /**
   * Syncs one resource for at most one budget. Resolves when the resource is caught up or there
   * is nothing to do; throws RescheduleJob to continue, or an error for the queue to handle.
   * Returns { status, chunks, stats } for logs and tests.
   */
  async function syncResource(resourceId, { budget = defaultBudget, signal } = {}) {
    const resource = await resources.findById(resourceId);
    if (!resource) return { status: 'missing' };
    const connection = await connections.findById(resource.connectionId);
    if (!resource.isEnabled || resource.accessStatus !== 'accessible' || connection.status !== 'active' || !connection.isEnabled) {
      return { status: 'skipped' };
    }
    if (connection.pausedUntil && connection.pausedUntil > new Date()) {
      throw new RescheduleJob(connection.pausedUntil.getTime() - Date.now(), 'connection paused by rate limit');
    }
    const connector = registry.getAvailable(connection.provider);
    if (!connector) {
      const problem = registry.problem(connection.provider);
      await resources.update(pool, resource.id, { lastErrorMessage: `Provider unavailable: ${problem}`.slice(0, 500), nextSyncAt: later(config.integrations.syncIntervalMs) });
      throw new PermanentJobError(`Provider ${connection.provider} unavailable: ${problem}`);
    }

    await connections.update(pool, connection.id, { lastSyncStartedAt: new Date() });
    const ctx = buildContext(connector, connection, { resource, signal });
    const started = Date.now();
    const totals = { records: 0, activities: 0 };
    let chunks = 0;
    const streams = connector.streams(resource);
    const done = new Set();

    try {
      while (done.size < streams.length) {
        for (const stream of streams) {
          if (done.has(stream)) continue;
          const overBudget =
            Date.now() - started >= budget.ms || ctx.httpStats().requests >= budget.requests || chunks >= (budget.chunks ?? MAX_CHUNKS_PER_JOB);
          if (overBudget) {
            logger.info('integration.sync budget used; continuing later', { resourceId, chunks, ...totals, requests: ctx.httpStats().requests, ms: Date.now() - started });
            throw new RescheduleJob(0, 'sync budget used');
          }

          const saved = await cursors.find(resource.id, stream);
          const phase = saved?.phase ?? 'backfill';
          const since =
            phase === 'incremental' && saved?.highWatermark
              ? new Date(saved.highWatermark.getTime() - OVERLAP_MS)
              : new Date(Date.now() - config.integrations.backfillDays * 86_400_000);

          const page = await connector.syncStream(ctx, { resource, stream, cursor: saved?.cursor ?? null, phase, since });
          chunks++;
          const nextPhase = page.done ? 'incremental' : page.phase ?? phase;
          const stats = await withTransaction(async (conn) => {
            const s = await ingest(conn, { connector, connection, resource, envelopes: page.envelopes, origin: 'sync' });
            const newest = page.envelopes
              .filter((e) => e.type === 'record' && e.sourceUpdatedAt)
              .map((e) => new Date(e.sourceUpdatedAt))
              .reduce((a, b) => (b > a ? b : a), null);
            await cursors.save(conn, { resourceId: resource.id, stream, phase: nextPhase, cursor: page.cursor ?? null, highWatermark: newest });
            return s;
          });
          totals.records += stats.records.inserted + stats.records.updated;
          totals.activities += stats.activities.inserted;
          if (page.done) done.add(stream);

          // Stop before the provider's limit runs out, not after.
          const rl = ctx.httpStats().rateLimit;
          if (rl?.remaining !== null && rl?.remaining !== undefined && rl.remaining < config.integrations.rateLimitReserve && done.size < streams.length) {
            await connections.update(pool, connection.id, { rateLimitRemaining: rl.remaining });
            throw await pauseConnection(connection.id, rl.resetAt ?? later(60_000));
          }
        }
      }
    } catch (err) {
      if (err instanceof RescheduleJob) throw err;
      const outcome = await handleFailure(err, { connection, resource });
      logger.warn('integration.sync failed', { resourceId, provider: connector.id, kind: err.kind ?? err.name, error: err.message });
      if (outcome) throw outcome;
      return { status: 'stopped', chunks, ...totals };
    }

    await resources.update(pool, resource.id, {
      lastSyncedAt: new Date(),
      nextSyncAt: later(config.integrations.syncIntervalMs),
      initialSyncCompletedAt: resource.initialSyncCompletedAt ?? new Date(),
      lastErrorMessage: null,
    });
    await recordSuccess(connection.id, ctx.httpStats().rateLimit);
    logger.info('integration.sync done', { resourceId, provider: connector.id, chunks, ...totals, ms: Date.now() - started });
    return { status: 'done', chunks, ...totals };
  }

  /** After the job gave up: show the error and wait a full interval before the next attempt. */
  async function onFinalFailure(resourceId, err) {
    await resources.update(pool, resourceId, {
      lastErrorMessage: message(err),
      nextSyncAt: later(config.integrations.syncIntervalMs),
    });
  }

  return { syncResource, onFinalFailure };
}

export const syncEngine = createSyncEngine();
