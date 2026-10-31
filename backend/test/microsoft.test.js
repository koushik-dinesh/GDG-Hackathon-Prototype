// Microsoft Teams and Outlook connectors (Microsoft Graph): delegated OAuth with tenant endpoints
// and form-encoded token requests, granted-scope checks, delta sync with paging, deletions
// (tombstones keep stored content), expired delta tokens, throttling, and the end-to-end path
// through the API and sync engine — all against a fake Graph on 127.0.0.1.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import * as queue from '../src/jobs/queue.js';
import { ProviderError } from '../src/services/integrations/errors.js';
import { createHttpClient } from '../src/services/integrations/http.js';
import { configureMicrosoft, htmlToText, resetMicrosoftSettings } from '../src/services/integrations/providers/microsoft/graph.js';
import outlook, { eventEnvelopes } from '../src/services/integrations/providers/microsoft/outlook.js';
import teams, { messageEnvelopes } from '../src/services/integrations/providers/microsoft/teams.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { vault } from '../src/services/integrations/vault.js';
import { describeConnector } from './integrations/contract.js';
import { CLIENT_ID, CLIENT_SECRET, ME, TENANT, event, mail, post, remove, startFakeMicrosoft, team, touch } from './integrations/fakeMicrosoft.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
let fake;
let general;
let inbox;
let cal;
let creds = [];

function seed() {
  const s = fake.state;
  const t = team(s, { id: 'team-1', displayName: 'Payments', channels: [{ id: '19:general@thread.tacv2', displayName: 'General' }, { id: '19:ops@thread.tacv2', displayName: 'Ops' }] });
  general = t.channels[0];
  post(s, general, { id: '1700000000001', text: 'PAY-42 is blocking the refund release', at: ago(2), replies: [{ id: '1700000000101', text: 'On it', at: ago(2) }] });
  post(s, general, { id: '1700000000002', text: 'Retro notes are in the wiki', subject: 'Retro', at: ago(1) });
  post(s, general, { id: '1700000000003', text: 'Deploy window moved to Friday', at: ago(1) });
  inbox = { id: 'AAMkInbox', displayName: 'Inbox', messages: [] };
  s.folders.push(inbox, { id: 'AAMkArchive', displayName: 'Archive', messages: [] });
  mail(s, inbox, { id: 'msg-1', subject: 'Refund escalation from Acme', from: 'cfo@acme.test', at: ago(3), preview: 'Customers report partial refunds failing' });
  mail(s, inbox, { id: 'msg-2', subject: 'Invoice', from: 'billing@vendor.test', at: ago(2) });
  mail(s, inbox, { id: 'msg-3', subject: 'Old thread', from: 'old@acme.test', at: ago(400) });
  cal = { id: 'AAMkCal', name: 'Calendar', events: [] };
  s.calendars.push(cal);
  event(s, cal, { id: 'ev-1', subject: 'Refund escalation review', start: ago(1), end: new Date(Date.now() - DAY + 3_600_000).toISOString() });
  event(s, cal, { id: 'ev-2', subject: 'Payments planning', start: new Date(Date.now() + 2 * DAY).toISOString(), end: new Date(Date.now() + 2 * DAY + 3_600_000).toISOString() });
}

function makeCtx(connector, connection, resource) {
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
        for (const c of await connector.refreshCredentials(ctx)) store.set(c.kind, c.value);
        return store.get(k) ?? null;
      },
    },
    store,
  };
  return ctx;
}

async function runStream(connector, ctx, resource, stream, cursor = null, since = new Date(Date.now() - 90 * DAY)) {
  const all = [];
  let done = false;
  for (let i = 0; !done && i < 30; i++) {
    const page = await connector.syncStream(ctx, { resource, stream, cursor, phase: cursor ? 'incremental' : 'backfill', since });
    all.push(...page.envelopes);
    ({ cursor, done } = page);
  }
  return { envelopes: all, cursor };
}

before(async () => {
  fake = await startFakeMicrosoft();
  configureMicrosoft({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, tenantId: TENANT, loginUrl: fake.url, graphUrl: fake.url, appPublicUrl: 'http://localhost:5173' });
  seed();
  fake.state.codes.set('contract-teams', 'offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All');
  fake.state.codes.set('contract-outlook', 'offline_access User.Read Mail.Read Calendars.Read');
  creds = (await teams.completeConnect(makeCtx(teams, { id: null }), { params: { code: fake.grantCode() } })).credentials.map((c) => [c.kind, c.value]);
});
after(async () => {
  resetMicrosoftSettings();
  await fake.close();
});

for (const [connector, code] of [
  [teams, 'contract-teams'],
  [outlook, 'contract-outlook'],
]) {
  describeConnector(connector, {
    connectParams: { code },
    makeCtx: (connection, resource) => makeCtx(connector, connection, resource),
    maxChunks: 20,
    failingCall: (c, ctx) => {
      fake.state.failNext.push({ match: /GET \/v1\.0\/me/, status: 503 });
      return c.listResources(ctx);
    },
  });
}

describe('Microsoft Graph connectors', () => {
  it('signs in through the tenant’s endpoints with the needed scopes', async () => {
    for (const [c, scope] of [
      [teams, 'ChannelMessage.Read.All'],
      [outlook, 'Mail.Read'],
    ]) {
      const u = new URL((await c.beginConnect({ state: 'state-xyz-123' })).redirectUrl);
      assert.equal(u.pathname, `/${TENANT}/oauth2/v2.0/authorize`);
      assert.match(u.searchParams.get('scope'), new RegExp(`offline_access .*${scope.replace('.', '\\.')}`));
      assert.equal(u.searchParams.get('redirect_uri'), `http://localhost:5173/integrations/${c.id}/setup`);
    }
  });

  it('reports missing admin consent instead of connecting with partial access', async () => {
    fake.state.grantScopes = 'offline_access User.Read';
    await assert.rejects(teams.completeConnect(makeCtx(teams, { id: null }), { params: { code: fake.grantCode() } }), (e) => e.kind === 'forbidden' && /admin consent/.test(e.publicMessage));
    fake.state.grantScopes = null;
    const ok = await outlook.completeConnect(makeCtx(outlook, { id: null }), { params: { code: fake.grantCode() } });
    assert.deepEqual([ok.account.externalAccountId, ok.account.login, ok.settings.tenantId], [ME.id, ME.userPrincipalName, TENANT]);
    assert.equal(outlook.sourceInstance, `microsoft:${TENANT}`);
  });

  it('lists every channel of the joined teams', async () => {
    const r = await teams.listResources(makeCtx(teams, { id: 1 }));
    assert.deepEqual(r.map((x) => [x.resourceType, x.name]), [['channel', 'Payments / General'], ['channel', 'Payments / Ops']]);
    assert.deepEqual([r[0].metadata.teamId, r[0].metadata.channelId], ['team-1', '19:general@thread.tacv2']);
  });

  it('syncs channel posts and replies, then only changes, with deletions as tombstones', async () => {
    const ctx = makeCtx(teams, { id: 1 });
    const [resource] = await teams.listResources(ctx);
    const first = await runStream(teams, ctx, resource, 'messages');
    const recs = first.envelopes.filter((e) => e.type === 'record');
    assert.deepEqual(recs.map((e) => e.externalId).sort(), ['19:general@thread.tacv2/1700000000001', '19:general@thread.tacv2/1700000000002', '19:general@thread.tacv2/1700000000003', '19:general@thread.tacv2/1700000000101']);
    const reply = recs.find((e) => e.externalId.endsWith('101'));
    assert.equal(reply.parentRef.externalId, '19:general@thread.tacv2/1700000000001');
    assert.equal(recs.find((e) => e.externalId.endsWith('001')).body, 'PAY-42 is blocking the refund release');
    assert.equal(recs.find((e) => e.externalId.endsWith('002')).title, 'Retro');
    assert.ok(first.cursor.delta, 'the run ends on a delta link');

    remove(fake.state, general.messages, '1700000000002');
    touch(fake.state, general.messages[2], { body: { contentType: 'html', content: '<p>Deploy window moved to <b>Monday</b></p>' }, lastModifiedDateTime: new Date().toISOString() });
    const second = await runStream(teams, ctx, resource, 'messages', first.cursor);
    const changed = second.envelopes.filter((e) => e.type === 'record' && !e.parentRef);
    assert.deepEqual(changed.map((e) => [e.externalId.split('/')[1], Boolean(e.deleted), e.title]).sort(), [
      ['1700000000002', true, null],
      ['1700000000003', false, 'Deploy window moved to Monday'],
    ]);
  });

  it('starts over when Graph forgets a delta token, and pauses on throttling', async () => {
    const ctx = makeCtx(outlook, { id: 1 });
    const folder = (await outlook.listResources(ctx)).find((r) => r.name === 'Mail: Inbox');
    const run = await runStream(outlook, ctx, folder, 'messages');
    fake.state.deltaTokens.clear(); // e.g. after 7 days without a sync
    const again = await runStream(outlook, ctx, folder, 'messages', run.cursor);
    assert.equal(again.envelopes.filter((e) => e.type === 'record').length, 2, 'fresh run from the window');
    fake.state.failNext.push({ match: /messages\/delta/, status: 429, headers: { 'retry-after': '7' } });
    await assert.rejects(outlook.syncStream(ctx, { resource: folder, stream: 'messages', cursor: null, phase: 'backfill', since: new Date(Date.now() - 30 * DAY) }), (e) => e instanceof ProviderError && e.kind === 'rate_limited' && e.retryAfterMs === 7000);
  });

  it('maps mail to preview-only records with addresses as people', async () => {
    const ctx = makeCtx(outlook, { id: 1 });
    const folder = (await outlook.listResources(ctx)).find((r) => r.name === 'Mail: Inbox');
    const { envelopes } = await runStream(outlook, ctx, folder, 'messages');
    const rec = envelopes.find((e) => e.type === 'record' && e.externalId === 'msg-1');
    assert.deepEqual([rec.title, rec.body, rec.metadata.from, rec.metadata.bodyStored], ['Refund escalation from Acme', 'Customers report partial refunds failing', 'cfo@acme.test', 'preview']);
    assert.ok(!envelopes.some((e) => e.externalId === 'msg-3'), 'older than the backfill window');
    assert.ok(envelopes.some((e) => e.type === 'identity' && e.externalUserId === 'cfo@acme.test' && e.email === 'cfo@acme.test'));
  });

  it('maps calendar events with times, status and the online meeting link', async () => {
    const ctx = makeCtx(outlook, { id: 1 });
    const calendar = (await outlook.listResources(ctx)).find((r) => r.resourceType === 'calendar');
    assert.deepEqual(outlook.streams(calendar), ['events']);
    const { envelopes } = await runStream(outlook, ctx, calendar, 'events');
    const recs = Object.fromEntries(envelopes.filter((e) => e.type === 'record').map((e) => [e.externalId, e]));
    assert.equal(recs['ev-1'].statusCategory, 'done', 'already ended');
    assert.equal(recs['ev-2'].statusCategory, 'todo');
    assert.match(recs['ev-2'].metadata.joinUrl, /meetup-join\/ev-2$/);
    assert.equal(recs['ev-2'].metadata.attendees, 2);
    const cancelled = eventEnvelopes('s', 'c', { ...cal.events[1], isCancelled: true }).find((e) => e.type === 'record');
    assert.deepEqual([cancelled.statusCategory, cancelled.state], ['cancelled', 'cancelled']);
  });

  it('ignores Teams system events and converts HTML', () => {
    assert.deepEqual(messageEnvelopes('s', 'c', { id: '1', messageType: 'systemEventMessage' }), []);
    assert.equal(htmlToText('<p>Hi &amp; welcome<br>to <b>PAY-42</b></p>'), 'Hi & welcome\nto PAY-42');
  });

  it('turns a rejected refresh into a reconnect error', async () => {
    const ctx = makeCtx(teams, { id: 1 });
    ctx.store.set('refresh_token', 'never-issued');
    await assert.rejects(teams.refreshCredentials(ctx), (e) => e.kind === 'auth' && /connect Microsoft 365 again/i.test(e.publicMessage));
  });
});

// ---- end to end ---------------------------------------------------------------------------------

const app = createApp();
const cookies = {};
const ids = {};
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
async function connect(provider) {
  const start = await as('admin').post(`/api/v1/integrations/${provider}/connect`);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const state = new URL(start.body.redirectUrl).searchParams.get('state');
  const res = await as('admin').post(`/api/v1/integrations/${provider}/callback`, { state, params: { code: fake.grantCode() } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

describe('Teams and Outlook end to end', () => {
  before(async () => {
    await resetDatabase();
    ids.admin = await createUser({ email: 'admin@ms.test', role: 'admin', fullName: 'MS admin' });
    ids.cfo = await createUser({ email: 'cfo@acme.test', role: 'employee', fullName: 'Acme CFO' });
    cookies.admin = await loginCookie(app, 'admin@ms.test');
    const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.admin]);
    ids.P = p.insertId;
    fake.reset();
    seed();
  });
  after(closeDatabase);

  it('connects Outlook, syncs the inbox, matches senders to users by e-mail, and keeps deleted mail', async () => {
    const body = await connect('outlook');
    const inboxRes = body.resources.find((r) => r.name === 'Mail: Inbox');
    assert.ok(body.resources.some((r) => r.resourceType === 'calendar'));
    await as('admin').patch(`/api/v1/integrations/${body.connection.id}/resources/${inboxRes.id}`, { isEnabled: true, projectId: ids.P });
    await syncAll(inboxRes.id);
    const rows = (await pool.query("SELECT external_id, title, project_id FROM external_records WHERE provider = 'outlook' ORDER BY external_id"))[0];
    assert.deepEqual(rows.map((r) => [r.external_id, r.project_id]), [['msg-1', ids.P], ['msg-2', ids.P]]);
    const cfo = await one("SELECT user_id, match_method FROM external_identities WHERE provider = 'outlook' AND external_user_id = 'cfo@acme.test'");
    assert.deepEqual([cfo.user_id, cfo.match_method], [ids.cfo, 'email']);

    remove(fake.state, inbox.messages, 'msg-1');
    await syncAll(inboxRes.id);
    const gone = await one("SELECT title, source_deleted_at FROM external_records WHERE provider = 'outlook' AND external_id = 'msg-1'");
    assert.equal(gone.title, 'Refund escalation from Acme', 'the tombstone keeps the stored subject');
    assert.ok(gone.source_deleted_at);
    const token = (await vault.get(body.connection.id, 'access_token')).value;
    assert.match(token, /^ms_at_/);
    assert.ok(!JSON.stringify((await as('admin').get(`/api/v1/integrations/${body.connection.id}`)).body).includes(token));
  });

  it('connects Teams and links a channel post that mentions a Jira-style key (correlation queued)', async () => {
    const body = await connect('microsoft_teams');
    const ch = body.resources.find((r) => r.name === 'Payments / General');
    await as('admin').patch(`/api/v1/integrations/${body.connection.id}/resources/${ch.id}`, { isEnabled: true, projectId: ids.P });
    await syncAll(ch.id);
    assert.equal((await one("SELECT COUNT(*) AS n FROM external_records WHERE provider = 'microsoft_teams' AND record_type = 'message'")).n, 4);
    const reply = await one("SELECT parent_record_id FROM external_records WHERE provider = 'microsoft_teams' AND external_id LIKE '%/1700000000101'");
    assert.ok(reply.parent_record_id);
    assert.ok((await one("SELECT COUNT(*) AS n FROM jobs WHERE type = 'correlation.evaluate'")).n >= 4);
  });
});
