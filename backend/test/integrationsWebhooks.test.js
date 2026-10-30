// Phase 3A step 7: webhook ingress, processing, redelivery, replay and retention (fake provider).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext } from '../src/jobs/runner.js';
import * as authStates from '../src/repositories/integrationAuthStatesRepository.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as resources from '../src/repositories/integrationResourcesRepository.js';
import * as deliveries from '../src/repositories/webhookDeliveriesRepository.js';
import { fakeService, resetFakeService, signedFakeWebhook } from '../src/services/integrations/providers/fake/index.js';
import * as scheduler from '../src/services/integrations/scheduler.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { vault } from '../src/services/integrations/vault.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
let connectionId;
let resourceId;
const workerHandlers = handlersFor(['integration.webhook', 'integration.maintenance']);

const itemEvent = (o = {}, item = {}) => ({
  action: 'updated',
  account: { id: 'fake-org' },
  resource: { externalId: '101', name: 'fake-org/api' },
  item: { id: '1001', number: 1, title: 'Payment API (from webhook)', state: 'open', author: 'u1', updatedAt: '2026-10-10T09:00:00.000Z', ...item },
  ...o,
});

function post(body, { deliveryId, event = 'item', secret, headers: extra = {}, rawBody: overrideBody } = {}) {
  const signed = signedFakeWebhook(body, { deliveryId, event, secret });
  const req = request(app).post('/api/v1/webhooks/fake');
  for (const [k, v] of Object.entries({ ...signed.headers, ...extra })) if (v !== undefined) req.set(k, v);
  // Strings go on the wire as-is (superagent would JSON-serialize a Buffer for a JSON content type).
  return req.send((overrideBody ?? signed.rawBody).toString('utf8'));
}

const count = async (sql, params = []) => (await pool.query(sql, params))[0][0].n;
const deliveryRow = async (deliveryId) => (await pool.query('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', [deliveryId]))[0][0];
// Runs queued jobs until none are left, skipping retry backoff waits (bounded).
const runAll = async () => {
  for (let round = 0; round < 10; round++) {
    await pool.query("UPDATE jobs SET run_at = NOW() WHERE status = 'pending'");
    if (!(await processNext('w1', workerHandlers))) return;
    while (await processNext('w1', workerHandlers));
  }
};
const recordTitle = async (externalId = '1001') => (await pool.query('SELECT title FROM external_records WHERE external_id = ?', [externalId]))[0][0]?.title;

before(async () => {
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@hooks.test', role: 'admin' });
  ids.manager = await createUser({ email: 'manager@hooks.test', role: 'manager' });
  ids.adminCookie = await loginCookie(app, 'admin@hooks.test');
  ids.managerCookie = await loginCookie(app, 'manager@hooks.test');
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.admin]);
  ids.project = p.insertId;
});
after(closeDatabase);
beforeEach(async () => {
  resetFakeService();
  for (const t of ['jobs', 'record_links', 'activities', 'external_records', 'external_identities', 'webhook_deliveries', 'integration_resources', 'integration_connections', 'integration_auth_states']) {
    await pool.query(`DELETE FROM ${t}`);
  }
  connectionId = await connections.create(pool, { provider: 'fake', sourceInstance: 'fake.test', externalAccountId: 'fake-org', displayName: 'Fake', status: 'active' });
  await vault.put({ connectionId, kind: 'api_token', value: 'fake-token-hooks' });
  resourceId = await resources.upsert(pool, connectionId, { resourceType: 'repository', externalId: '101', name: 'fake-org/api' });
  await resources.update(pool, resourceId, { isEnabled: true, projectId: ids.project });
  await resources.upsert(pool, connectionId, { resourceType: 'repository', externalId: '102', name: 'fake-org/web' });
});

describe('ingress', () => {
  it('stores a signed delivery and queues it by id only', async () => {
    const res = await post(itemEvent(), { deliveryId: 'd-1' });
    assert.deepEqual([res.status, res.body], [202, { received: true, duplicate: false }]);
    const row = await deliveryRow('d-1');
    assert.deepEqual([row.status, row.event_type, row.action, row.external_account_id, row.connection_id], ['received', 'item', 'updated', 'fake-org', connectionId]);
    assert.match(row.payload_sha256, /^[0-9a-f]{64}$/);
    const [[job]] = await pool.query("SELECT * FROM jobs WHERE type = 'integration.webhook'");
    assert.equal(job.id, row.job_id);
    const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
    assert.deepEqual(payload, { deliveryId: row.id }, 'the job carries the row id, never the webhook body');
    assert.ok((await connections.findById(connectionId)).lastWebhookAt);
  });

  it('rejects unsigned, forged, non-JSON and unknown-provider requests without storing anything', async () => {
    const body = itemEvent();
    assert.equal((await post(body, { secret: 'wrong-secret' })).status, 401);
    assert.equal((await post(body, { headers: { 'x-fake-signature': undefined } })).status, 401);
    const tampered = Buffer.from(JSON.stringify({ ...body, action: 'deleted' }));
    assert.equal((await post(body, { rawBody: tampered })).status, 401, 'signature over the exact bytes');
    assert.equal((await post(body, { headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request(app).post('/api/v1/webhooks/github').set('content-type', 'application/json').send('{}')).status, 404);
    assert.equal(await count('SELECT COUNT(*) AS n FROM webhook_deliveries'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM jobs'), 0);
  });

  it('rejects malformed signed payloads and oversized bodies', async () => {
    const raw = Buffer.from('{not json');
    const signed = signedFakeWebhook({}, { deliveryId: 'd-bad' });
    const { createHmac } = await import('node:crypto');
    const sig = `sha256=${createHmac('sha256', fakeService.webhookSecret).update(raw).digest('hex')}`;
    const res = await request(app).post('/api/v1/webhooks/fake').set({ ...signed.headers, 'x-fake-signature': sig }).send(raw.toString('utf8'));
    assert.equal(res.status, 400);
    assert.equal((await post(itemEvent(), { headers: { 'x-fake-delivery': undefined } })).status, 400, 'missing delivery id');

    const big = Buffer.alloc(config.integrations.webhookMaxBytes + 1, 'a');
    const tooBig = await request(app).post('/api/v1/webhooks/fake').set('content-type', 'application/json').send(big.toString('utf8'));
    assert.equal(tooBig.status, 413);
    assert.equal(await count('SELECT COUNT(*) AS n FROM webhook_deliveries'), 0);
  });

  it('acknowledges duplicates without storing or queueing them twice', async () => {
    await post(itemEvent(), { deliveryId: 'd-dup' });
    const again = await post(itemEvent(), { deliveryId: 'd-dup' });
    assert.deepEqual([again.status, again.body.duplicate], [202, true]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE delivery_id = 'd-dup'"), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM jobs WHERE type = 'integration.webhook'"), 1);
  });
});

describe('processing', () => {
  it('ingests envelopes for an enabled resource, traceable to the delivery', async () => {
    await post(itemEvent(), { deliveryId: 'd-ok' });
    await runAll();
    const row = await deliveryRow('d-ok');
    assert.deepEqual([row.status, row.attempts], ['processed', 1]);
    assert.ok(row.processed_at);
    assert.equal(await recordTitle(), 'Payment API (from webhook)');
    const [[a]] = await pool.query('SELECT origin, webhook_delivery_id, project_id FROM activities');
    assert.deepEqual([a.origin, a.webhook_delivery_id, a.project_id], ['webhook', row.id, ids.project]);
  });

  it('ignores events for resources that are not enabled, paused connections and unknown accounts', async () => {
    await post(itemEvent({ resource: { externalId: '102', name: 'fake-org/web' } }), { deliveryId: 'd-off' });
    await post(itemEvent({ account: { id: 'someone-else' } }), { deliveryId: 'd-unknown' });
    await runAll();
    assert.equal((await deliveryRow('d-off')).status, 'ignored');
    assert.match((await deliveryRow('d-off')).last_error_message, /not enabled/);
    assert.equal((await deliveryRow('d-unknown')).status, 'ignored');

    await connections.update(pool, connectionId, { isEnabled: false });
    await post(itemEvent(), { deliveryId: 'd-paused' });
    await runAll();
    assert.equal((await deliveryRow('d-paused')).status, 'ignored');
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records'), 0);
  });

  it('binds a delivery that arrived before its connection existed', async () => {
    await post(itemEvent({ account: { id: 'late-org' } }), { deliveryId: 'd-late' });
    assert.equal((await deliveryRow('d-late')).connection_id, null);
    const lateId = await connections.create(pool, { provider: 'fake', sourceInstance: 'fake.test', externalAccountId: 'late-org', displayName: 'Late', status: 'active' });
    const r = await resources.upsert(pool, lateId, { resourceType: 'repository', externalId: '101', name: 'late-org/api' });
    await resources.update(pool, r, { isEnabled: true });
    await runAll();
    const row = await deliveryRow('d-late');
    assert.deepEqual([row.status, row.connection_id], ['processed', lateId]);
  });

  it('never lets an older webhook overwrite newer synced data', async () => {
    fakeService.items[101][0] = { ...fakeService.items[101][0], title: 'Synced newest', updatedAt: '2026-10-20T00:00:00.000Z' };
    fakeService.items[101].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    await syncEngine.syncResource(resourceId);
    await post(itemEvent({}, { updatedAt: '2026-10-10T09:00:00.000Z', title: 'Old webhook' }), { deliveryId: 'd-old' });
    await runAll();
    assert.equal((await deliveryRow('d-old')).status, 'processed');
    assert.equal(await recordTitle(), 'Synced newest');
  });

  it('retries transient failures, marks permanent ones failed, and accepts a provider redelivery', async () => {
    fakeService.failNext.handleWebhook = 'transient';
    await post(itemEvent(), { deliveryId: 'd-retry' });
    await runAll();
    assert.equal((await deliveryRow('d-retry')).status, 'processed', 'second attempt succeeded');
    assert.equal((await deliveryRow('d-retry')).attempts, 2);

    fakeService.failNext.handleWebhook = 'invalid_response';
    await post(itemEvent({}, { id: '1009', title: 'Broken' }), { deliveryId: 'd-fail' });
    await runAll();
    const failed = await deliveryRow('d-fail');
    assert.equal(failed.status, 'failed');
    assert.match(failed.last_error_message, /unexpected response/);

    const redelivered = await post(itemEvent({}, { id: '1009', title: 'Broken' }), { deliveryId: 'd-fail' });
    assert.equal(redelivered.body.duplicate, false, 'a failed delivery with the same id is processed again');
    await runAll();
    assert.equal((await deliveryRow('d-fail')).status, 'processed');
    assert.equal(await recordTitle('1009'), 'Broken');
  });

  it('applies provider lifecycle events; an uninstall deletes the credentials', async () => {
    await post({ action: 'suspended', account: { id: 'fake-org' } }, { event: 'account', deliveryId: 'd-susp' });
    await runAll();
    assert.equal((await connections.findById(connectionId)).status, 'suspended');
    await connections.update(pool, connectionId, { status: 'active' });
    await post({ action: 'deleted', account: { id: 'fake-org' } }, { event: 'account', deliveryId: 'd-del' });
    await runAll();
    const c = await connections.findById(connectionId);
    assert.deepEqual([c.status, c.isEnabled], ['disconnected', false]);
    assert.equal(await vault.get(connectionId, 'api_token'), null);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'integration.provider_disconnected'"), 1);
  });
});

describe('replay and retention', () => {
  const replay = (cookie, id) => request(app).post(`/api/v1/integrations/webhook-deliveries/${id}/replay`).set('Cookie', cookie);

  it('replays a processed delivery idempotently, audited, admin-only', async () => {
    await post(itemEvent(), { deliveryId: 'd-replay' });
    await runAll();
    const row = await deliveryRow('d-replay');
    assert.equal((await replay(ids.managerCookie, row.id)).status, 403);
    const res = await replay(ids.adminCookie, row.id);
    assert.deepEqual([res.status, res.body.delivery.status], [202, 'received']);
    assert.equal((await replay(ids.adminCookie, row.id)).status, 409, 'already queued');
    await runAll();
    assert.equal((await deliveryRow('d-replay')).status, 'processed');
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records'), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM activities'), 1, 'no duplicate activity');
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'integration.webhook_replayed'"), 1);
    assert.equal((await replay(ids.adminCookie, 999999)).status, 404);
  });

  it('purges old payloads (then replay is refused) and expired connect states', async () => {
    await post(itemEvent(), { deliveryId: 'd-old-payload' });
    await runAll();
    const row = await deliveryRow('d-old-payload');
    await pool.execute('UPDATE webhook_deliveries SET received_at = DATE_SUB(NOW(), INTERVAL 30 DAY) WHERE id = ?', [row.id]);
    await authStates.create(pool, { provider: 'fake', purpose: 'install', stateHash: 'e'.repeat(64), userId: ids.admin, ttlSeconds: 1 });
    await pool.execute('UPDATE integration_auth_states SET expires_at = DATE_SUB(NOW(), INTERVAL 2 DAY)');

    assert.equal(await scheduler.enqueueMaintenance(), true);
    assert.equal(await scheduler.enqueueMaintenance(), false, 'one maintenance job at a time');
    await runAll();
    assert.equal(await deliveries.findPayload(row.id), null);
    assert.equal(await count('SELECT COUNT(*) AS n FROM integration_auth_states'), 0);
    assert.equal((await replay(ids.adminCookie, row.id)).status, 409);
    const listed = await request(app).get(`/api/v1/integrations/${connectionId}/webhook-deliveries`).set('Cookie', ids.adminCookie);
    assert.deepEqual([listed.body.deliveries[0].hasPayload, listed.body.deliveries[0].status], [false, 'processed']);
    assert.ok(!JSON.stringify(listed.body).includes('Payment API'), 'listings never include payloads');
  });

  it('a purged payload that still needs processing fails permanently', async () => {
    await post(itemEvent(), { deliveryId: 'd-purged-early' });
    const row = await deliveryRow('d-purged-early');
    await pool.execute('UPDATE webhook_deliveries SET payload = NULL, payload_purged_at = NOW() WHERE id = ?', [row.id]);
    await runAll();
    assert.equal((await deliveryRow('d-purged-early')).status, 'failed');
    assert.equal((await queue.findById(row.job_id)).status, 'failed');
  });
});
