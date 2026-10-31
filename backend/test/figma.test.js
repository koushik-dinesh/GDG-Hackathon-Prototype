// Figma connector: OAuth with Basic-auth token requests, team access check, 403 "Invalid token"
// refresh-and-retry, files changed since the watermark with comments and versions, passcode
// webhooks (file lookup, deletions), and the end-to-end path through the API, sync engine and
// webhook worker — against a fake Figma on 127.0.0.1.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext } from '../src/jobs/runner.js';
import { createHttpClient } from '../src/services/integrations/http.js';
import figma, { configureFigma, resetFigmaSettings } from '../src/services/integrations/providers/figma/index.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { describeConnector } from './integrations/contract.js';
import { CLIENT_ID, CLIENT_SECRET, TEAM_ID, file, project, startFakeFigma } from './integrations/fakeFigma.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const PASSCODE = 'figma-webhook-passcode-0123456789';
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
let fake;
let design;
let creds = [];

function seed() {
  const s = fake.state;
  design = project(s, { id: 501, name: 'Payments design' });
  project(s, { id: 502, name: 'Brand' });
  file(design, {
    key: 'KEYcheckout',
    name: 'Checkout refunds flow',
    modified: ago(1),
    comments: [
      { id: 'cm1', message: 'Matches PAY-42?', user: { id: 'u2', handle: 'raj' }, created_at: ago(1), resolved_at: null, parent_id: '' },
      { id: 'cm2', message: 'Done', user: { id: 'u3', handle: 'mia' }, created_at: ago(1), resolved_at: ago(0.5), parent_id: 'cm1' },
    ],
    versions: [
      { id: '9001', label: 'Ready for dev', description: 'Final refund screens', created_at: ago(1), user: { id: 'u3', handle: 'mia' } },
      { id: '9000', label: '', description: '', created_at: ago(2), user: { id: 'u3', handle: 'mia' } },
    ],
  });
  file(design, { key: 'KEYold', name: 'Old exploration', modified: ago(200) });
}

function makeCtx(connection, resource) {
  const store = new Map(creds);
  const ctx = {
    connection,
    resource,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: (options) => createHttpClient(options),
    credentials: {
      peek: async (k) => store.get(k) ?? null,
      get: async (k) => store.get(k) ?? null,
      async refresh(k) {
        for (const c of await figma.refreshCredentials(ctx)) store.set(c.kind, c.value);
        return store.get(k) ?? null;
      },
    },
    store,
  };
  return ctx;
}

const hook = (body, passcode = PASSCODE) => {
  const raw = JSON.stringify({ passcode, webhook_id: '77', timestamp: new Date().toISOString(), ...body });
  return { raw, headers: { 'content-type': 'application/json' } };
};

before(async () => {
  fake = await startFakeFigma();
  configureFigma({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, teamId: TEAM_ID, webhookPasscode: PASSCODE, authUrl: fake.url, apiUrl: fake.url, appPublicUrl: 'http://localhost:5173' });
  seed();
  fake.state.codes.add('contract-code');
  creds = (await figma.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } })).credentials.map((c) => [c.kind, c.value]);
});
after(async () => {
  resetFigmaSettings();
  await fake.close();
});

describeConnector(figma, {
  connectParams: { code: 'contract-code' },
  makeCtx,
  validWebhook: () => {
    const h = hook({ event_type: 'FILE_COMMENT', file_key: 'KEYcheckout', file_name: 'Checkout refunds flow', comment_id: 'cm1' });
    return { headers: h.headers, rawBody: Buffer.from(h.raw) };
  },
  maxChunks: 10,
  passcodeOnly: true,
  failingCall: (c, ctx) => {
    fake.state.failNext.push({ match: /projects$/, status: 500 });
    return c.listResources(ctx);
  },
});

describe('Figma connector', () => {
  it('connects as the configured team and refuses accounts that cannot read it', async () => {
    const ok = await figma.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } });
    assert.deepEqual([ok.account.externalAccountId, ok.account.login, ok.settings.webhooks], [TEAM_ID, 'ada', true]);
    configureFigma({ teamId: '111' });
    await assert.rejects(figma.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } }), (e) => e.kind === 'forbidden' && /team 111/.test(e.publicMessage));
    configureFigma({ teamId: TEAM_ID });
  });

  it('refreshes after 403 “Invalid token” and retries', async () => {
    const ctx = makeCtx({ id: 1 });
    fake.state.access.clear();
    assert.equal((await figma.health(ctx)).status, 'healthy');
    assert.equal(ctx.store.get('refresh_token'), creds.find(([k]) => k === 'refresh_token')[1], 'not rotated');
  });

  it('syncs changed files with their comments and versions, then nothing until a file changes', async () => {
    const ctx = makeCtx({ id: 1 });
    const resource = (await figma.listResources(ctx)).find((r) => r.name === 'Payments design');
    const run = async (cursor) => {
      const all = [];
      let done = false;
      for (let i = 0; !done && i < 10; i++) {
        const page = await figma.syncStream(ctx, { resource, stream: 'files', cursor, phase: 'backfill', since: new Date(Date.now() - 90 * DAY) });
        all.push(...page.envelopes);
        ({ cursor, done } = page);
      }
      return { all, cursor };
    };
    const first = await run(null);
    const recs = first.all.filter((e) => e.type === 'record');
    assert.deepEqual(recs.map((e) => [e.recordType, e.externalId]).sort(), [
      ['comment', 'cm1'],
      ['comment', 'cm2'],
      ['design_file', 'KEYcheckout'],
      ['version', 'KEYcheckout/9000'],
      ['version', 'KEYcheckout/9001'],
    ]);
    assert.equal(recs.find((e) => e.externalId === 'cm2').statusCategory, 'done', 'resolved comment');
    assert.equal(first.all.filter((e) => e.type === 'activity' && e.activityType === 'updated').length, 1, 'only named versions are activities');
    const second = await run(first.cursor);
    assert.deepEqual(second.all, []);
  });

  it('accepts webhooks only with the passcode and re-reads everything but the file key', async () => {
    const ok = hook({ event_type: 'FILE_COMMENT', file_key: 'KEYcheckout', file_name: 'Tampered name' });
    assert.equal(figma.verifyWebhook({ rawBody: Buffer.from(ok.raw) }), true);
    assert.equal(figma.verifyWebhook({ rawBody: Buffer.from(hook({ event_type: 'PING' }, 'wrong-passcode-0123456789abcd').raw) }), false);
    assert.equal(figma.verifyWebhook({ rawBody: Buffer.from('not json') }), false);
    const parsed = figma.parseWebhook({ body: JSON.parse(ok.raw) });
    assert.equal(parsed.externalAccountId, TEAM_ID);
    const result = await figma.handleWebhook(makeCtx({ id: 1 }), { ...parsed, payload: JSON.parse(ok.raw) });
    assert.deepEqual(result.resourceRef, { resourceType: 'project', externalId: '501' });
    assert.equal(result.envelopes.find((e) => e.type === 'record' && e.recordType === 'design_file').title, 'Checkout refunds flow', 'name from the API, not the payload');
    assert.deepEqual((await figma.handleWebhook(makeCtx({ id: 1 }), { payload: { event_type: 'FILE_DELETE', file_key: '../../etc' } })).envelopes, []);
    // A delete for a file that still exists changes nothing.
    assert.equal((await figma.handleWebhook(makeCtx({ id: 1 }), { payload: { event_type: 'FILE_DELETE', file_key: 'KEYcheckout' } })).envelopes.some((e) => e.deleted), false);
    assert.deepEqual((await figma.handleWebhook(makeCtx({ id: 1 }), { payload: { event_type: 'PING' } })).envelopes, []);
  });

  it('detects deleted files during sync', async () => {
    const ctx = makeCtx({ id: 1 });
    const resource = (await figma.listResources(ctx)).find((r) => r.name === 'Payments design');
    let cursor = null;
    for (let i = 0, done = false; !done && i < 10; i++) ({ cursor, done } = await figma.syncStream(ctx, { resource, stream: 'files', cursor, phase: 'backfill', since: new Date(Date.now() - 365 * DAY) }));
    const removed = design.files.splice(design.files.findIndex((f) => f.key === 'KEYold'), 1);
    const page = await figma.syncStream(ctx, { resource, stream: 'files', cursor, phase: 'incremental' });
    assert.deepEqual(page.envelopes, [{ type: 'record', recordType: 'design_file', externalId: 'KEYold', title: null, body: null, deleted: true }]);
    design.files.push(...removed);
  });
});

// ---- end to end ---------------------------------------------------------------------------------

const app = createApp();
const cookies = {};
const ids = {};
const as = (who) => ({
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
});
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

describe('Figma end to end', () => {
  before(async () => {
    await resetDatabase();
    ids.admin = await createUser({ email: 'admin@fig.test', role: 'admin', fullName: 'Fig admin' });
    cookies.admin = await loginCookie(app, 'admin@fig.test');
    const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.admin]);
    ids.P = p.insertId;
    fake.reset();
    seed();
  });
  after(closeDatabase);

  it('connects, syncs a project, and applies a signed deletion webhook keeping the file’s name', async () => {
    const start = await as('admin').post('/api/v1/integrations/figma/connect');
    const state = new URL(start.body.redirectUrl).searchParams.get('state');
    const res = await as('admin').post('/api/v1/integrations/figma/callback', { state, params: { code: fake.grantCode() } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const resource = res.body.resources.find((r) => r.name === 'Payments design');
    await as('admin').patch(`/api/v1/integrations/${res.body.connection.id}/resources/${resource.id}`, { isEnabled: true, projectId: ids.P });
    await syncAll(resource.id);
    const counts = Object.fromEntries((await pool.query("SELECT record_type, COUNT(*) AS n FROM external_records WHERE provider = 'figma' GROUP BY record_type"))[0].map((r) => [r.record_type, r.n]));
    assert.deepEqual(counts, { comment: 2, design_file: 1, version: 2 });

    assert.equal((await request(app).post('/api/v1/webhooks/figma').set('content-type', 'application/json').send(hook({ event_type: 'FILE_DELETE', file_key: 'KEYcheckout' }, 'wrong-passcode-0123456789abcd').raw)).status, 401);
    // The file is deleted at Figma, then the webhook arrives.
    design.files.splice(design.files.findIndex((f) => f.key === 'KEYcheckout'), 1);
    const d = hook({ event_type: 'FILE_DELETE', file_key: 'KEYcheckout' });
    assert.equal((await request(app).post('/api/v1/webhooks/figma').set(d.headers).send(d.raw)).status, 202);
    while (await processNext('figma-test', handlersFor(['integration.webhook'])));
    const row = (await pool.query("SELECT title, source_deleted_at FROM external_records WHERE provider = 'figma' AND external_id = 'KEYcheckout'"))[0][0];
    assert.equal(row.title, 'Checkout refunds flow');
    assert.ok(row.source_deleted_at);
  });
});
