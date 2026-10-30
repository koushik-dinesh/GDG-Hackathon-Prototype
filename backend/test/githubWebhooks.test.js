// Phase 3B: GitHub webhooks end to end over HTTP: signature checks, queued processing, duplicates,
// ordering, installation lifecycle and repository access changes (fake GitHub + real database).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import { processNext } from '../src/jobs/runner.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import { vault } from '../src/services/integrations/vault.js';
import { addInstallation, addRepo, at, pull, review, user } from './integrations/fakeGithub.js';
import { githubDelivery, setupGithub } from './integrations/githubFixture.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
let env;
let cookie;
let repo;
let connectionId;
let resourceId;
let projectId;
const installation = { id: 7001 };

const count = async (sql, params = []) => (await pool.query(sql, params))[0][0].n;
const deliveryRow = async (id) => (await pool.query('SELECT * FROM webhook_deliveries WHERE delivery_id = ?', [id]))[0][0];
const record = async (recordType, externalId) => (await pool.query('SELECT * FROM external_records WHERE record_type = ? AND external_id = ?', [recordType, externalId]))[0][0];
const runWorker = async () => {
  for (let i = 0; i < 20; i++) {
    await pool.query("UPDATE jobs SET run_at = NOW() WHERE status = 'pending'");
    if (!(await processNext('w', handlersFor(['integration.webhook'])))) return;
  }
};

function send(event, body, opts) {
  const d = githubDelivery(event, body, opts);
  return request(app).post('/api/v1/webhooks/github').set(d.headers).send(d.raw);
}

before(async () => {
  await resetDatabase();
  env = await setupGithub();
  await createUser({ email: 'admin@ghw.test', role: 'admin' });
  cookie = await loginCookie(app, 'admin@ghw.test');
  const [[admin]] = await pool.query("SELECT id FROM users WHERE email = 'admin@ghw.test'");
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [admin.id]);
  projectId = p.insertId;
});
after(async () => {
  await env.teardown();
  await closeDatabase();
});
beforeEach(async () => {
  env.gh.reset();
  addInstallation(env.gh.state, { id: 7001, login: 'acme' });
  repo = addRepo(env.gh.state, 7001, { id: 501, fullName: 'acme/payments' });
  addRepo(env.gh.state, 7001, { id: 502, fullName: 'acme/web' });
  for (const t of ['jobs', 'record_links', 'activities', 'external_records', 'external_identities', 'webhook_deliveries', 'integration_resources', 'integration_connections']) await pool.query(`DELETE FROM ${t}`);
  const start = await request(app).post('/api/v1/integrations/github/connect').set('Cookie', cookie);
  const state = new URL(start.body.redirectUrl).searchParams.get('state');
  const res = await request(app).post('/api/v1/integrations/github/callback').set('Cookie', cookie).send({ state, params: { installationId: '7001' } });
  connectionId = res.body.connection.id;
  resourceId = res.body.resources.find((r) => r.name === 'acme/payments').id;
  await request(app).patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`).set('Cookie', cookie).send({ isEnabled: true, projectId });
});

const issuePayload = (o = {}, issue = {}) => ({
  action: 'opened',
  installation,
  repository: repo.meta,
  sender: user(1, 'ana'),
  issue: { id: 1, number: 10, title: 'Checkout fails', body: 'Steps…', state: 'open', user: user(1, 'ana'), assignees: [], labels: [], created_at: at(10), updated_at: at(10), closed_at: null, html_url: 'https://github.com/acme/payments/issues/10', ...issue },
  ...o,
});

describe('ingress security', () => {
  it('accepts correctly signed deliveries and queues them without calling GitHub', async () => {
    const before = env.gh.state.calls.length;
    const res = await send('issues', issuePayload(), { deliveryId: 'g-1' });
    assert.deepEqual([res.status, res.body.duplicate], [202, false]);
    assert.equal(env.gh.state.calls.length, before, 'no GitHub API call inside the request');
    const row = await deliveryRow('g-1');
    assert.deepEqual([row.status, row.event_type, row.action, row.external_account_id, row.connection_id], ['received', 'issues', 'opened', '7001', connectionId]);
  });

  it('rejects bad signatures, foreign Apps and malformed requests without storing them', async () => {
    assert.equal((await send('issues', issuePayload(), { secret: 'x'.repeat(30) })).status, 401);
    const d = githubDelivery('issues', issuePayload());
    const { 'x-hub-signature-256': _signature, ...unsigned } = d.headers;
    assert.equal((await request(app).post('/api/v1/webhooks/github').set(unsigned).send(d.raw)).status, 401);
    assert.equal((await request(app).post('/api/v1/webhooks/github').set(d.headers).send(d.raw.replace('Checkout', 'Hacked'))).status, 401);
    assert.equal((await send('issues', issuePayload(), { appId: '1' })).status, 400, 'deliveries for another GitHub App');
    const noDelivery = githubDelivery('issues', issuePayload());
    delete noDelivery.headers['x-github-delivery'];
    assert.equal((await request(app).post('/api/v1/webhooks/github').set(noDelivery.headers).send(noDelivery.raw)).status, 400);
    assert.equal(await count('SELECT COUNT(*) AS n FROM webhook_deliveries'), 0);
  });

  it('acknowledges duplicate deliveries once', async () => {
    await send('issues', issuePayload(), { deliveryId: 'g-dup' });
    const again = await send('issues', issuePayload(), { deliveryId: 'g-dup' });
    assert.equal(again.body.duplicate, true);
    await runWorker();
    assert.equal(await count("SELECT COUNT(*) AS n FROM jobs WHERE type = 'integration.webhook'"), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records'), 1);
  });
});

describe('processing', () => {
  it('turns issue, PR, review, comment and push events into records and activities', async () => {
    await send('issues', issuePayload(), { deliveryId: 'e-1' });
    const pr = pull(repo, 11, { updated: at(11), title: 'Fix checkout' });
    await send('pull_request', { action: 'opened', installation, repository: repo.meta, pull_request: pr, sender: user(2, 'raj') }, { deliveryId: 'e-2' });
    const rv = review(repo, 11, { submitted: at(11, 12), state: 'CHANGES_REQUESTED' });
    await send('pull_request_review', { action: 'submitted', installation, repository: repo.meta, pull_request: pr, review: rv }, { deliveryId: 'e-3' });
    await send(
      'issue_comment',
      { action: 'created', installation, repository: repo.meta, issue: { number: 11, pull_request: {} }, comment: { id: 77, user: user(1, 'ana'), body: 'Please add a test', created_at: at(11, 13), updated_at: at(11, 13), html_url: 'https://github.com/acme/payments/pull/11#issuecomment-77' } },
      { deliveryId: 'e-4' },
    );
    await send(
      'pull_request_review_comment',
      { action: 'created', installation, repository: repo.meta, pull_request: pr, comment: { id: 88, user: user(1, 'ana'), body: 'Rename this', path: 'src/x.js', line: 3, created_at: at(11, 14), updated_at: at(11, 14), html_url: 'https://github.com/acme/payments/pull/11#discussion_r88', pull_request_url: 'https://api.github.com/repos/acme/payments/pulls/11' } },
      { deliveryId: 'e-5' },
    );
    await send(
      'push',
      { ref: 'refs/heads/fix-checkout', installation, repository: repo.meta, sender: user(2, 'raj'), commits: [{ id: 'f00d123', message: 'Fix checkout rounding', timestamp: at(11, 15), author: { name: 'Raj', username: 'raj' }, distinct: true }] },
      { deliveryId: 'e-6' },
    );
    await send('ping', { zen: 'Keep it logically awesome.', installation }, { deliveryId: 'e-7' });
    await runWorker();

    for (const id of ['e-1', 'e-2', 'e-3', 'e-4', 'e-5', 'e-6', 'e-7']) assert.equal((await deliveryRow(id)).status, 'processed', id);
    const prRow = await record('pull_request', '501#11');
    assert.equal(prRow.project_id, projectId);
    assert.equal((await record('review', String(rv.id))).state, 'changes_requested');
    assert.equal((await record('comment', '77')).parent_record_id, prRow.id);
    assert.equal((await record('review_comment', '88')).parent_record_id, prRow.id);
    const commitRow = await record('commit', '501:f00d123');
    assert.equal(commitRow.title, 'Fix checkout rounding');
    const [[a]] = await pool.query("SELECT a.origin, a.project_id, d.delivery_id FROM activities a JOIN webhook_deliveries d ON d.id = a.webhook_delivery_id WHERE a.activity_type = 'review_submitted'");
    assert.deepEqual([a.origin, a.project_id, a.delivery_id], ['webhook', projectId, 'e-3']);
  });

  it('never lets an older event overwrite newer data, and redelivery stays idempotent', async () => {
    await send('issues', issuePayload({ action: 'edited' }, { title: 'Newest title', updated_at: at(20) }), { deliveryId: 'o-new' });
    await send('issues', issuePayload({ action: 'edited' }, { title: 'Older title', updated_at: at(15) }), { deliveryId: 'o-old' });
    await runWorker();
    assert.equal((await record('issue', '501#10')).title, 'Newest title');
    const activities = await count('SELECT COUNT(*) AS n FROM activities');
    const replay = await request(app).post(`/api/v1/integrations/webhook-deliveries/${(await deliveryRow('o-new')).id}/replay`).set('Cookie', cookie);
    assert.equal(replay.status, 202);
    await runWorker();
    assert.equal(await count('SELECT COUNT(*) AS n FROM activities'), activities, 'replay adds nothing');
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records'), 1);
  });

  it('ignores events for repositories that are not enabled', async () => {
    const web = env.gh.state.repos['acme/web'].meta;
    await send('issues', issuePayload({ repository: web }), { deliveryId: 'off-1' });
    await runWorker();
    assert.equal((await deliveryRow('off-1')).status, 'ignored');
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records'), 0);
  });

  it('recovers from temporary failures while processing', async () => {
    // installation_repositories triggers a resource refresh (a GitHub API call): fail it once.
    env.gh.state.failNext.push({ match: /GET \/installation\/repositories/, status: 502 });
    await send('installation_repositories', { action: 'added', installation, repositories_added: [{ id: 503, full_name: 'acme/mobile' }] }, { deliveryId: 'r-1' });
    addRepo(env.gh.state, 7001, { id: 503, fullName: 'acme/mobile' });
    await runWorker();
    const row = await deliveryRow('r-1');
    assert.deepEqual([row.status, row.attempts], ['processed', 2]);
    const detail = await request(app).get(`/api/v1/integrations/${connectionId}`).set('Cookie', cookie);
    const mobile = detail.body.resources.find((r) => r.name === 'acme/mobile');
    assert.deepEqual([mobile.isEnabled, mobile.accessStatus], [false, 'accessible'], 'new repositories arrive disabled');
    assert.equal(detail.body.resources.find((r) => r.id === resourceId).projectId, projectId, 'existing mapping kept');
  });
});

describe('installation lifecycle', () => {
  it('follows suspension, reactivation, removed repositories and uninstall', async () => {
    await send('installation', { action: 'suspend', installation }, { deliveryId: 'l-1' });
    await runWorker();
    assert.equal((await connections.findById(connectionId)).status, 'suspended');

    await send('installation', { action: 'unsuspend', installation }, { deliveryId: 'l-2' });
    await runWorker();
    assert.equal((await connections.findById(connectionId)).status, 'active');

    delete env.gh.state.repos['acme/web'];
    await send('installation_repositories', { action: 'removed', installation, repositories_removed: [{ id: 502 }] }, { deliveryId: 'l-3' });
    await runWorker();
    const detail = await request(app).get(`/api/v1/integrations/${connectionId}`).set('Cookie', cookie);
    assert.equal(detail.body.resources.find((r) => r.name === 'acme/web').accessStatus, 'removed');

    await send('installation', { action: 'deleted', installation }, { deliveryId: 'l-4' });
    await runWorker();
    const c = await connections.findById(connectionId);
    assert.deepEqual([c.status, c.isEnabled], ['disconnected', false]);
    assert.equal(await vault.get(connectionId, 'installation_token'), null, 'credentials deleted');
  });
});
