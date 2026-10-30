// Phase 3A step 6: sync engine, scheduler, worker isolation and "sync now" (fake provider).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext, runJob } from '../src/jobs/runner.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as resources from '../src/repositories/integrationResourcesRepository.js';
import * as cursors from '../src/repositories/syncCursorsRepository.js';
import { fakeService, resetFakeService } from '../src/services/integrations/providers/fake/index.js';
import { createRegistry } from '../src/services/integrations/registry.js';
import * as scheduler from '../src/services/integrations/scheduler.js';
import { createSyncEngine, syncEngine } from '../src/services/integrations/sync.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
let connectionId;
let resourceId;
let otherResourceId;

const count = async (sql, params = []) => (await pool.query(sql, params))[0][0].n;
const recordCount = () => count('SELECT COUNT(*) AS n FROM external_records');
const conn = () => connections.findById(connectionId);
const res = (id = resourceId) => resources.findById(id);

before(async () => {
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@sync.test', role: 'admin' });
  ids.manager = await createUser({ email: 'manager@sync.test', role: 'manager' });
  ids.adminCookie = await loginCookie(app, 'admin@sync.test');
  ids.managerCookie = await loginCookie(app, 'manager@sync.test');
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.admin]);
  ids.project = p.insertId;
});
after(closeDatabase);
beforeEach(async () => {
  resetFakeService();
  for (const t of ['jobs', 'record_links', 'activities', 'external_records', 'external_identities', 'integration_resources', 'integration_connections']) {
    await pool.query(`DELETE FROM ${t}`);
  }
  connectionId = await connections.create(pool, { provider: 'fake', sourceInstance: 'fake.test', externalAccountId: 'fake-org', displayName: 'Fake', status: 'active' });
  resourceId = await resources.upsert(pool, connectionId, { resourceType: 'repository', externalId: '101', name: 'fake-org/api' });
  await resources.update(pool, resourceId, { isEnabled: true, projectId: ids.project, nextSyncAt: new Date(Date.now() - 1000) });
  otherResourceId = await resources.upsert(pool, connectionId, { resourceType: 'repository', externalId: '102', name: 'fake-org/web' });
});

describe('sync engine', () => {
  it('backfills a resource, then switches the stream to incremental and marks everything healthy', async () => {
    const result = await syncEngine.syncResource(resourceId);
    assert.deepEqual([result.status, result.chunks, result.records], ['done', 2, 3]);
    assert.equal(await recordCount(), 3);
    const cursor = await cursors.find(resourceId, 'items');
    assert.equal(cursor.phase, 'incremental');
    assert.deepEqual(cursor.cursor, { after: { updatedAt: '2026-10-01T09:03:00.000Z', id: '1003' } });
    assert.equal(cursor.highWatermark.toISOString(), '2026-10-01T09:03:00.000Z');

    const r = await res();
    assert.ok(r.lastSyncedAt && r.initialSyncCompletedAt);
    assert.equal(r.lastErrorMessage, null);
    const minutes = (r.nextSyncAt.getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 14 && minutes <= 15.1, `next sync in ${minutes} min`);
    const c = await conn();
    assert.deepEqual([c.health, c.consecutiveFailures], ['healthy', 0]);
    assert.ok(c.lastSyncStartedAt && c.lastSyncSucceededAt);

    const again = await syncEngine.syncResource(resourceId);
    assert.deepEqual([again.status, again.chunks, again.records], ['done', 1, 0], 'caught up: one empty chunk');
  });

  it('picks up new changes incrementally', async () => {
    await syncEngine.syncResource(resourceId);
    fakeService.items[101].push({ id: '1004', number: 4, title: 'Disputes', state: 'open', author: 'u2', updatedAt: '2026-10-05T10:00:00.000Z' });
    fakeService.items[101][0] = { ...fakeService.items[101][0], title: 'Payment API v2', updatedAt: '2026-10-06T10:00:00.000Z' };
    fakeService.items[101].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const r = await syncEngine.syncResource(resourceId);
    assert.equal(r.records, 2);
    const [[row]] = await pool.query("SELECT title FROM external_records WHERE external_id = '1001'");
    assert.equal(row.title, 'Payment API v2');
  });

  it('yields after its budget and resumes from the saved cursor', async () => {
    const engine = createSyncEngine({ budget: { ms: 60_000, requests: 100, chunks: 1 } });
    await assert.rejects(engine.syncResource(resourceId), (err) => err instanceof queue.RescheduleJob && err.delayMs === 0);
    assert.equal(await recordCount(), 2, 'the first chunk is committed');
    assert.equal((await cursors.find(resourceId, 'items')).phase, 'incremental');
    const done = await engine.syncResource(resourceId);
    assert.equal(done.status, 'done');
    assert.equal(await recordCount(), 3);
  });

  it('skips disabled, removed or paused work without touching the provider', async () => {
    await resources.update(pool, resourceId, { isEnabled: false });
    assert.equal((await syncEngine.syncResource(resourceId)).status, 'skipped');
    await resources.update(pool, resourceId, { isEnabled: true });
    await connections.update(pool, connectionId, { isEnabled: false });
    assert.equal((await syncEngine.syncResource(resourceId)).status, 'skipped');
    await connections.update(pool, connectionId, { isEnabled: true, status: 'disconnected' });
    assert.equal((await syncEngine.syncResource(resourceId)).status, 'skipped');
    assert.equal((await syncEngine.syncResource(999999)).status, 'missing');
    assert.equal(await recordCount(), 0);
  });
});

describe('provider failures', () => {
  it('rate limits pause the whole connection and reschedule without using an attempt', async () => {
    fakeService.failNext.syncStream = 'rate_limited';
    await assert.rejects(syncEngine.syncResource(resourceId), (err) => err instanceof queue.RescheduleJob && err.delayMs > 50_000 && err.delayMs <= 60_000);
    const c = await conn();
    assert.ok(c.pausedUntil > new Date());
    assert.deepEqual(await scheduler.dueResourceIds(), [], 'paused connections are not scheduled');
    await assert.rejects(syncEngine.syncResource(resourceId), (err) => err instanceof queue.RescheduleJob && /paused/.test(err.message));

    // Through the queue: the attempt is given back.
    await connections.update(pool, connectionId, { pausedUntil: null });
    fakeService.failNext.syncStream = 'rate_limited';
    const jobId = await queue.enqueue('integration.sync', { resourceId }, { dedupeKey: scheduler.syncDedupeKey(resourceId) });
    await processNext('w1', handlersFor(['integration.sync']));
    const job = await queue.findById(jobId);
    assert.deepEqual([job.status, job.attempts], ['pending', 0]);
  });

  it('transient errors retry and degrade health; three in a row mark it failing; success recovers', async () => {
    for (let i = 1; i <= 3; i++) {
      fakeService.failNext.syncStream = 'transient';
      await assert.rejects(syncEngine.syncResource(resourceId), (err) => err.kind === 'transient' && err.retryable === true);
      const c = await conn();
      assert.deepEqual([c.consecutiveFailures, c.health], [i, i >= 3 ? 'failing' : 'degraded']);
    }
    await syncEngine.syncResource(resourceId);
    const c = await conn();
    assert.deepEqual([c.consecutiveFailures, c.health, c.lastErrorCode], [0, 'healthy', null]);
  });

  it('auth errors stop the job and put the connection in error', async () => {
    fakeService.failNext.syncStream = 'auth';
    await assert.rejects(syncEngine.syncResource(resourceId), (err) => err instanceof queue.PermanentJobError);
    const c = await conn();
    assert.deepEqual([c.status, c.health, c.lastErrorCode], ['error', 'failing', 'auth']);
    const r = await res();
    assert.match(r.lastErrorMessage, /reconnect/);
    assert.ok(r.nextSyncAt > new Date(Date.now() + 14 * 60_000), 'not retried in a tight loop');
  });

  it('removed resources and suspended connections stop quietly', async () => {
    fakeService.failNext.syncStream = 'not_found';
    assert.equal((await syncEngine.syncResource(resourceId)).status, 'stopped');
    assert.equal((await res()).accessStatus, 'removed');

    await resources.update(pool, resourceId, { accessStatus: 'accessible' });
    fakeService.failNext.syncStream = 'suspended';
    assert.equal((await syncEngine.syncResource(resourceId)).status, 'stopped');
    assert.equal((await conn()).status, 'suspended');
  });

  it('a provider that is no longer configured fails permanently with a visible reason', async () => {
    const engine = createSyncEngine({ registry: createRegistry([]) });
    await assert.rejects(engine.syncResource(resourceId), queue.PermanentJobError);
    assert.match((await res()).lastErrorMessage, /Provider unavailable/);
  });

  it('a job that finally fails records the error and waits a full interval', async () => {
    fakeService.failNext.syncStream = 'invalid_response';
    const jobId = await queue.enqueue('integration.sync', { resourceId }, { dedupeKey: scheduler.syncDedupeKey(resourceId) });
    await processNext('w1', handlersFor(['integration.sync']));
    assert.equal((await queue.findById(jobId)).status, 'failed');
    const r = await res();
    assert.match(r.lastErrorMessage, /unexpected response/);
    assert.ok(r.nextSyncAt > new Date(Date.now() + 14 * 60_000));
  });
});

describe('scheduling and isolation', () => {
  it('queues each due resource once, even with concurrent ticks', async () => {
    const [a, b] = await Promise.all([scheduler.tick(), scheduler.tick()]);
    assert.equal(a + b, 1);
    assert.equal(await scheduler.tick(), 0, 'already queued');
    assert.equal(await count("SELECT COUNT(*) AS n FROM jobs WHERE type = 'integration.sync'"), 1);

    await processNext('w1', handlersFor(['integration.sync']));
    assert.equal(await scheduler.tick(), 0, 'synced: next run is in the future');
    await resources.update(pool, otherResourceId, { isEnabled: true });
    assert.equal(await scheduler.tick(), 1, 'a newly enabled resource with no next_sync_at is due');
  });

  it('interleaves with other job types instead of starving them', async () => {
    const engine = createSyncEngine({ budget: { ms: 60_000, requests: 100, chunks: 1 } });
    const order = [];
    const handlers = {
      'integration.sync': { run: async (job) => { order.push('sync'); await engine.syncResource(job.payload.resourceId); } },
      'email.send': { run: async () => order.push('email') },
    };
    await queue.enqueue('integration.sync', { resourceId }, { dedupeKey: scheduler.syncDedupeKey(resourceId) });
    const emailId = await queue.enqueue('email.send', {});
    await pool.execute('UPDATE jobs SET run_at = DATE_SUB(NOW(), INTERVAL 5 SECOND) WHERE id = ?', [emailId]);
    await pool.execute("UPDATE jobs SET run_at = DATE_SUB(NOW(), INTERVAL 10 SECOND) WHERE type = 'integration.sync'");
    while (await processNext('w1', handlers));
    assert.deepEqual(order, ['sync', 'email', 'sync'], 'the rescheduled sync goes behind the waiting email');
    assert.equal(await recordCount(), 3);
  });

  it('WORKER_JOB_TYPES selects handlers and rejects unknown types', () => {
    assert.deepEqual(Object.keys(handlersFor(['integration.sync'])), ['integration.sync']);
    assert.ok(Object.keys(handlersFor([])).includes('ai.extract'));
    assert.throws(() => handlersFor(['integration.sync', 'nope']), /unknown job types: nope/);
  });
});

describe('sync now (API)', () => {
  const post = (cookie, url) => request(app).post(url).set('Cookie', cookie);

  it('queues every enabled resource of an active connection, once', async () => {
    await resources.update(pool, resourceId, { nextSyncAt: new Date(Date.now() + 3600_000) });
    const first = await post(ids.adminCookie, `/api/v1/integrations/${connectionId}/sync`);
    assert.deepEqual([first.status, first.body.queued], [202, 1], 'ignores next_sync_at; only enabled resources');
    assert.equal((await post(ids.adminCookie, `/api/v1/integrations/${connectionId}/sync`)).body.queued, 0, 'already queued');
    assert.equal((await post(ids.managerCookie, `/api/v1/integrations/${connectionId}/sync`)).status, 403);
    await connections.update(pool, connectionId, { isEnabled: false });
    assert.equal((await post(ids.adminCookie, `/api/v1/integrations/${connectionId}/sync`)).status, 409);
  });

  it('is audited', async () => {
    await post(ids.adminCookie, `/api/v1/integrations/${connectionId}/sync`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'integration.sync_requested' AND entity_id = ?", [connectionId]), 1);
  });
});

describe('runner integration', () => {
  it('runs the registered handler end to end', async () => {
    const jobId = await queue.enqueue('integration.sync', { resourceId }, { dedupeKey: scheduler.syncDedupeKey(resourceId) });
    const job = await queue.claimNext('w1', ['integration.sync']);
    assert.equal(job.id, jobId);
    assert.deepEqual(await runJob(job, handlersFor(['integration.sync'])), { ok: true });
    assert.equal((await queue.findById(jobId)).status, 'succeeded');
    assert.equal(await recordCount(), 3);
  });
});
