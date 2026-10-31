// Jira Cloud connector: OAuth 2.0 connect and rotating refresh, JQL sync with paging and extra
// comments, issue links, webhooks (signature, events, deletion), and the end-to-end path through
// the API, the sync engine and the webhook worker against a fake Atlassian on 127.0.0.1.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext } from '../src/jobs/runner.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import { ProviderError } from '../src/services/integrations/errors.js';
import { createHttpClient } from '../src/services/integrations/http.js';
import jira, { jqlTime, signatureFor } from '../src/services/integrations/providers/jira/index.js';
import { adfToText, issueEnvelopes, statusCategoryOf } from '../src/services/integrations/providers/jira/mappers.js';
import { configureJira, resetJiraSettings, settings } from '../src/services/integrations/providers/jira/settings.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { vault } from '../src/services/integrations/vault.js';
import { describeConnector } from './integrations/contract.js';
import { CLOUD_ID, SITE_URL, blocks, issue, person, project, startFakeJira } from './integrations/fakeJira.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const WEBHOOK_SECRET = 'jira-webhook-secret-0123456789abcdef';
const DAY = 86_400_000;
const at = (daysAgo, h = 10) => new Date(Date.now() - daysAgo * DAY + h * 3_600_000 - 10 * 3_600_000).toISOString().replace('Z', '+0000');

let fake;
let pay;
let contractCreds = [];
const app = createApp();
const ids = {};
const cookies = {};

function seed() {
  const s = fake.state;
  pay = project(s, { id: 10000, key: 'PAY', name: 'Payments' });
  project(s, { id: 10001, key: 'WEB', name: 'Website' });
  const a = issue(s, pay, { id: 101, number: 1, summary: 'Refunds fail for partial captures', updated: at(400), status: 'progress', assignee: person('acc-mia', 'Mia'), labels: ['blocked'], description: 'Partial refunds time out.' });
  const b = issue(s, pay, { id: 102, number: 2, summary: 'Ship refund retries', updated: at(3), comments: [1, 2, 3, 4].map((n) => ({ id: `c${n}`, text: `Note ${n}`, at: at(3, 10 + n) })) });
  issue(s, pay, { id: 103, number: 3, summary: 'Old finished work', updated: at(300), status: 'done' });
  issue(s, pay, { id: 104, number: 4, summary: 'Retry sub-task', updated: at(2), parent: b });
  blocks(a, b);
}

/** A ctx like the framework's with in-memory credentials, for the connector-only tests. */
function makeCtx(connection, resource) {
  const store = new Map(connection.creds ?? []);
  const ctx = {
    connection: { ...connection, settings: { cloudId: CLOUD_ID, ...(connection.settings ?? {}) } },
    resource,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: (options) => createHttpClient(options),
    credentials: {
      peek: async (kind) => store.get(kind) ?? null,
      async get(kind) {
        if (!store.has(kind)) for (const c of await jira.refreshCredentials(ctx)) store.set(c.kind, c.value);
        return store.get(kind) ?? null;
      },
      async refresh(kind) {
        for (const c of await jira.refreshCredentials(ctx)) store.set(c.kind, c.value);
        return store.get(kind) ?? null;
      },
    },
    store,
  };
  return ctx;
}

/** Tokens straight from the fake, for connector-level tests. */
async function tokens() {
  const r = await jira.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } });
  return r.credentials.map((c) => [c.kind, c.value]);
}

function jiraDelivery(body, { id = `wh-${Math.random().toString(36).slice(2)}`, secret = WEBHOOK_SECRET } = {}) {
  const raw = JSON.stringify(body);
  return { raw, headers: { 'content-type': 'application/json', 'x-atlassian-webhook-identifier': id, 'x-hub-signature': signatureFor(secret, Buffer.from(raw)) } };
}

before(async () => {
  fake = await startFakeJira();
  configureJira({ clientId: 'jira-client-id-123', clientSecret: 'jira-client-secret-456', siteUrl: SITE_URL, webhookSecret: WEBHOOK_SECRET, authUrl: fake.url, apiUrl: fake.url, redirectUri: 'http://localhost:5173/integrations/jira/setup' });
  seed();
  fake.state.codes.set('contract-code', true);
  contractCreds = await tokens();
});
after(async () => {
  resetJiraSettings();
  await fake.close();
});

describeConnector(jira, {
  connectParams: { code: 'contract-code' },
  makeCtx: (connection, resource) => makeCtx({ ...connection, creds: contractCreds }, resource),
  validWebhook: () => {
    const d = jiraDelivery({ webhookEvent: 'jira:issue_updated', timestamp: Date.now(), issue: fake.state.issues[0], user: person('acc-ana', 'Ana') });
    return { headers: d.headers, rawBody: Buffer.from(d.raw) };
  },
  maxChunks: 20,
  failingCall: (c, ctx) => {
    fake.state.failNext.push({ match: /GET .*\/project\/search/, status: 503 });
    return c.listResources(ctx);
  },
});

describe('Jira connector', () => {
  it('builds the Atlassian consent URL with offline access and the state', async () => {
    const { redirectUrl } = await jira.beginConnect({ state: 'state-abc-123' });
    const u = new URL(redirectUrl);
    assert.equal(u.origin + u.pathname, `${fake.url}/authorize`);
    assert.deepEqual(
      ['client_id', 'audience', 'response_type', 'prompt', 'state', 'redirect_uri'].map((k) => u.searchParams.get(k)),
      ['jira-client-id-123', 'api.atlassian.com', 'code', 'consent', 'state-abc-123', 'http://localhost:5173/integrations/jira/setup'],
    );
    assert.match(u.searchParams.get('scope'), /offline_access/);
  });

  it('refuses declined consent, other sites and missing offline access', async () => {
    await assert.rejects(jira.completeConnect(makeCtx({ id: null }), { params: { error: 'access_denied' } }), (e) => e instanceof ProviderError && /declined/.test(e.publicMessage));
    await assert.rejects(jira.completeConnect(makeCtx({ id: null }), { params: { code: 'never-issued' } }), (e) => e.kind === 'auth');
    const saved = fake.state.sites;
    fake.state.sites = [{ ...saved[0], url: 'https://other.atlassian.net' }];
    await assert.rejects(jira.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } }), (e) => e.kind === 'forbidden' && /acme\.atlassian\.net/.test(e.publicMessage));
    fake.state.sites = saved;
    fake.state.issueRefresh = false;
    await assert.rejects(jira.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } }), (e) => /offline access/.test(e.publicMessage));
    fake.state.issueRefresh = true;
  });

  it('rotates the refresh token and fails cleanly once the grant is revoked', async () => {
    const ctx = makeCtx({ id: 1, creds: await tokens() });
    const firstRefresh = ctx.store.get('refresh_token');
    const fresh = await jira.refreshCredentials(ctx);
    const next = fresh.find((c) => c.kind === 'refresh_token').value;
    assert.notEqual(next, firstRefresh, 'a new refresh token each time');
    assert.ok(fresh.find((c) => c.kind === 'access_token').expiresAt > new Date());
    // The old refresh token no longer works (rotation).
    await assert.rejects(jira.refreshCredentials(ctx), (e) => e.kind === 'auth' && /connect Jira again/i.test(e.publicMessage));
    // A revoked access token: one forced refresh and retry, then success.
    ctx.store.set('refresh_token', next);
    fake.state.access.clear();
    assert.equal((await jira.health(ctx)).status, 'healthy');
    fake.revokeAll();
    await assert.rejects(jira.health(ctx), (e) => e.kind === 'auth');
  });

  it('maps issues: status category, key, ADF text, labels, links both ways and sub-tasks', () => {
    const [a, b, , sub] = fake.state.issues;
    const ea = issueEnvelopes('acme.atlassian.net', SITE_URL, a);
    const rec = ea.find((e) => e.type === 'record');
    assert.deepEqual([rec.externalKey, rec.statusCategory, rec.body, rec.url], ['PAY-1', 'in_progress', 'Partial refunds time out.', `${SITE_URL}/browse/PAY-1`]);
    assert.deepEqual(rec.metadata.labels, ['blocked']);
    assert.deepEqual(rec.metadata.assignees, [{ id: 'acc-mia', login: 'Mia' }]);
    const linkA = ea.filter((e) => e.type === 'link');
    const linkB = issueEnvelopes('acme.atlassian.net', SITE_URL, b).filter((e) => e.type === 'link' && e.linkType === 'blocks');
    assert.deepEqual(linkA.map((l) => [l.fromRef.externalId, l.linkType, l.toRef.externalId]), [['101', 'blocks', '102']]);
    assert.deepEqual(linkB.map((l) => [l.fromRef.externalId, l.toRef.externalId]), [['101', '102']], 'the same link from the other side');
    assert.ok(issueEnvelopes('s', SITE_URL, sub).some((e) => e.type === 'link' && e.linkType === 'includes' && e.fromRef.externalId === '102'));
    assert.equal(statusCategoryOf({ statusCategory: { key: 'done' } }), 'done');
    assert.equal(adfToText('wiki text from a v2 webhook'), 'wiki text from a v2 webhook');
    assert.equal(adfToText(null), null);
  });

  it('writes JQL times in the API user’s time zone', () => {
    assert.equal(jqlTime('2026-10-31T23:30:00Z', 'UTC'), '2026-10-31 23:30');
    assert.equal(jqlTime('2026-10-31T23:30:00Z', 'Asia/Kolkata'), '2026-11-01 05:00');
    assert.equal(jqlTime('2026-07-01T12:00:00Z', 'America/New_York'), '2026-07-01 08:00');
  });

  it('syncs open issues of any age, recent changes, and comments beyond the inline ones', async () => {
    const ctx = makeCtx({ id: 1, creds: await tokens() });
    const resource = (await jira.listResources(ctx)).find((r) => r.name === 'PAY');
    assert.deepEqual(resource.metadata, { key: 'PAY', name: 'Payments', projectType: 'software' });
    const all = [];
    let cursor = null;
    let done = false;
    for (let i = 0; !done && i < 20; i++) {
      const page = await jira.syncStream(ctx, { resource, stream: 'issues', cursor, phase: 'backfill', since: new Date(Date.now() - 90 * DAY) });
      all.push(...page.envelopes);
      ({ cursor, done } = page);
    }
    const keys = new Set(all.filter((e) => e.type === 'record' && e.recordType === 'issue').map((e) => e.externalKey));
    assert.deepEqual([...keys].sort(), ['PAY-1', 'PAY-2', 'PAY-4'], 'old open PAY-1 included; old finished PAY-3 not');
    const comments = new Set(all.filter((e) => e.type === 'record' && e.recordType === 'comment').map((e) => e.externalId));
    assert.deepEqual([...comments].sort(), ['c1', 'c2', 'c3', 'c4'], 'comments 3 and 4 fetched separately');
    assert.ok(cursor.watermark, 'a watermark for the next incremental run');

    // Incremental: only issues updated since the watermark (minus overlap).
    issue(fake.state, pay, { id: 105, number: 5, summary: 'New this hour', updated: new Date().toISOString().replace('Z', '+0000') });
    const inc = await jira.syncStream(ctx, { resource, stream: 'issues', cursor, phase: 'incremental' });
    const jql = fake.state.calls.filter((c) => c.sig.endsWith('/search/jql')).at(-1).query.jql;
    assert.match(jql, /^project = "PAY" AND updated >= "\d{4}-\d\d-\d\d \d\d:\d\d" ORDER BY updated ASC$/);
    assert.ok(inc.envelopes.some((e) => e.type === 'record' && e.externalKey === 'PAY-5'));
    assert.ok(!inc.envelopes.some((e) => e.type === 'record' && e.externalKey === 'PAY-1'));
  });

  it('verifies webhook signatures with the configured secret only', () => {
    const d = jiraDelivery({ webhookEvent: 'jira:issue_created', issue: fake.state.issues[0] });
    assert.equal(jira.verifyWebhook({ headers: d.headers, rawBody: Buffer.from(d.raw) }), true);
    const wrong = jiraDelivery({ webhookEvent: 'jira:issue_created' }, { secret: 'another-secret-0123456789abcdef' });
    assert.equal(jira.verifyWebhook({ headers: wrong.headers, rawBody: Buffer.from(wrong.raw) }), false);
    configureJira({ webhookSecret: undefined });
    assert.equal(jira.verifyWebhook({ headers: d.headers, rawBody: Buffer.from(d.raw) }), false, 'no secret = webhooks refused (polling only)');
    configureJira({ webhookSecret: WEBHOOK_SECRET });
  });

  it('turns webhook events into records, assignments and deletions', async () => {
    const [a] = fake.state.issues;
    const handle = (eventType, body) => jira.handleWebhook(null, { eventType, payload: { webhookEvent: eventType, timestamp: Date.parse('2026-10-31T10:00:00Z'), user: person('acc-ana', 'Ana'), ...body } });
    const updated = await handle('jira:issue_updated', { issue: a, changelog: { id: '9001', items: [{ field: 'assignee', to: 'acc-raj', toString: 'Raj' }] } });
    assert.deepEqual(updated.resourceRef, { resourceType: 'project', externalId: '10000' });
    const assigned = updated.envelopes.find((e) => e.type === 'activity' && e.activityType === 'assigned');
    assert.deepEqual([assigned.dedupeKey, assigned.summary], ['jira:acme.atlassian.net:changelog:9001:assignee', 'Ana assigned PAY-1 to Raj']);
    const deleted = await handle('jira:issue_deleted', { issue: a });
    assert.equal(deleted.envelopes.find((e) => e.type === 'record').deleted, true);
    const comment = await handle('comment_deleted', { issue: a, comment: { id: 'c9', author: person('acc-raj', 'Raj'), body: 'gone', created: '2026-10-30T10:00:00.000+0000' } });
    assert.deepEqual(comment.envelopes.filter((e) => e.type === 'record').map((e) => [e.recordType, e.deleted, e.parentRef.externalId]), [['comment', true, '101']]);
    assert.deepEqual((await handle('project_created', { issue: a })).envelopes, []);
    assert.equal(jira.parseWebhook({ headers: { 'x-atlassian-webhook-identifier': 'abc' }, body: { webhookEvent: 'jira:issue_created' } }).externalAccountId, 'acme.atlassian.net');
    assert.throws(() => jira.parseWebhook({ headers: {}, body: { webhookEvent: 'x' } }), ProviderError);
  });

  it('is unavailable until configured, naming the missing setting only', () => {
    const saved = { ...settings };
    configureJira({ clientSecret: undefined });
    assert.equal(jira.configProblem(), 'JIRA_CLIENT_SECRET is not set');
    configureJira({ clientSecret: saved.clientSecret, redirectUri: undefined });
    assert.match(jira.configProblem(), /APP_PUBLIC_URL/);
    configureJira(saved);
    assert.equal(jira.configProblem(), null);
  });
});

// ---- end to end: API, vault, sync engine, ingest, webhook worker ------------------------------

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
});
const one = async (sql, params = []) => (await pool.query(sql, params))[0][0];

async function syncAll(resourceId) {
  for (let i = 0; i < 40; i++) {
    try {
      return await syncEngine.syncResource(resourceId);
    } catch (err) {
      if (!(err instanceof queue.RescheduleJob) || err.delayMs !== 0) throw err;
    }
  }
  throw new Error('sync did not finish');
}

describe('Jira end to end', () => {
  let connectionId;
  let resourceId;

  before(async () => {
    await resetDatabase();
    for (const [key, role] of [
      ['admin', 'admin'],
      ['manager', 'manager'],
    ]) {
      ids[key] = await createUser({ email: `${key}@jira.test`, role, fullName: `Jira ${key}` });
      cookies[key] = await loginCookie(app, `${key}@jira.test`);
    }
    const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.manager]);
    ids.P = p.insertId;
    fake.reset();
    seed();
  });
  after(closeDatabase);

  it('connects through the API, stores encrypted tokens and lists projects', async () => {
    assert.equal((await as('manager').post('/api/v1/integrations/jira/connect')).status, 403);
    const start = await as('admin').post('/api/v1/integrations/jira/connect');
    assert.equal(start.status, 200);
    const state = new URL(start.body.redirectUrl).searchParams.get('state');
    const res = await as('admin').post('/api/v1/integrations/jira/callback', { state, params: { code: fake.grantCode() } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    connectionId = res.body.connection.id;
    const c = await connections.findById(connectionId);
    assert.deepEqual([c.provider, c.sourceInstance, c.externalAccountId, c.settings.cloudId], ['jira', 'acme.atlassian.net', 'acme.atlassian.net', CLOUD_ID]);
    const access = await vault.get(connectionId, 'access_token');
    assert.match(access.value, /^jira_at_/);
    const [[row]] = await pool.query("SELECT ciphertext FROM integration_credentials WHERE connection_id = ? AND kind = 'refresh_token'", [connectionId]);
    assert.ok(!row.ciphertext.toString('latin1').includes('jira_rt_'), 'stored encrypted');
    assert.deepEqual(res.body.resources.map((r) => [r.name, r.isEnabled]), [['PAY', false], ['WEB', false]]);
    resourceId = res.body.resources.find((r) => r.name === 'PAY').id;
    // A used state never works twice.
    assert.equal((await as('admin').post('/api/v1/integrations/jira/callback', { state, params: { code: fake.grantCode() } })).status, 400);
  });

  it('syncs an enabled project into records, identities, links and activities, idempotently', async () => {
    await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { isEnabled: true, projectId: ids.P });
    await syncAll(resourceId);
    const issues = (await pool.query("SELECT external_key, project_id, status_category FROM external_records WHERE provider = 'jira' AND record_type = 'issue' ORDER BY external_key"))[0];
    assert.deepEqual(issues.map((r) => [r.external_key, r.project_id, r.status_category]), [
      ['PAY-1', ids.P, 'in_progress'],
      ['PAY-2', ids.P, 'todo'],
      ['PAY-4', ids.P, 'todo'],
    ]);
    assert.equal((await one("SELECT COUNT(*) AS n FROM external_records WHERE provider = 'jira' AND record_type = 'comment'")).n, 4);
    const link = await one("SELECT link_type, origin, status FROM record_links WHERE link_type = 'blocks'");
    assert.deepEqual([link.link_type, link.origin, link.status], ['blocks', 'source', 'confirmed']);
    assert.ok((await one("SELECT COUNT(*) AS n FROM external_identities WHERE provider = 'jira'")).n >= 3);
    const before = (await one('SELECT COUNT(*) AS n FROM activities')).n;
    await syncEngine.syncResource(resourceId).catch(() => {});
    await syncAll(resourceId);
    assert.equal((await one('SELECT COUNT(*) AS n FROM activities')).n, before, 'a second sync adds nothing');
    // Correlation was queued for the new records (Phase 5) and insights see the blocker label (Phase 7).
    assert.ok((await one("SELECT COUNT(*) AS n FROM jobs WHERE type = 'correlation.evaluate'")).n >= 3);
    const insights = await as('manager').get('/api/v1/insights');
    assert.ok(insights.body.blockers.some((b) => b.kind === 'record_labelled_blocked' && b.item.key === 'PAY-1'));
    assert.ok(insights.body.dependencies.some((d) => d.blocker.title.startsWith('PAY-1') && d.blocked.title.startsWith('PAY-2')));
  });

  it('accepts signed webhooks, rejects bad ones, and applies deletions', async () => {
    const bad = jiraDelivery({ webhookEvent: 'jira:issue_deleted' }, { secret: 'wrong-secret-0123456789abcdefgh' });
    assert.equal((await request(app).post('/api/v1/webhooks/jira').set(bad.headers).send(bad.raw)).status, 401);
    const [a] = fake.state.issues;
    const d = jiraDelivery({ webhookEvent: 'jira:issue_deleted', timestamp: Date.now(), issue: a, user: person('acc-ana', 'Ana') }, { id: 'wh-delete-1' });
    assert.equal((await request(app).post('/api/v1/webhooks/jira').set(d.headers).send(d.raw)).status, 202);
    assert.equal((await request(app).post('/api/v1/webhooks/jira').set(d.headers).send(d.raw)).body.duplicate, true);
    while (await processNext('jira-test', handlersFor(['integration.webhook'])));
    const rec = await one("SELECT source_deleted_at FROM external_records WHERE provider = 'jira' AND external_key = 'PAY-1'");
    assert.ok(rec.source_deleted_at, 'deleted at the source, row kept');
    const delivery = await one("SELECT status, connection_id FROM webhook_deliveries WHERE delivery_id = 'wh-delete-1'");
    assert.deepEqual([delivery.status, delivery.connection_id], ['processed', connectionId]);
  });

  it('marks the connection for reconnecting when the grant is revoked, and never leaks tokens', async () => {
    const access = (await vault.get(connectionId, 'access_token')).value;
    const refresh = (await vault.get(connectionId, 'refresh_token')).value;
    fake.revokeAll();
    await assert.rejects(syncAll(resourceId));
    const c = await connections.findById(connectionId);
    assert.deepEqual([c.status, c.health], ['error', 'failing']);
    const detail = await as('admin').get(`/api/v1/integrations/${connectionId}`);
    const text = JSON.stringify(detail.body);
    for (const secret of [access, refresh, 'jira-client-secret-456', WEBHOOK_SECRET]) assert.ok(!text.includes(secret));
    const disconnect = await as('admin').post(`/api/v1/integrations/${connectionId}/disconnect`, {});
    assert.equal(disconnect.status, 200);
    assert.equal(await vault.get(connectionId, 'access_token'), null, 'tokens deleted on disconnect');
    assert.equal((await one("SELECT COUNT(*) AS n FROM external_records WHERE provider = 'jira'")).n > 0, true, 'synced data kept');
  });
});
