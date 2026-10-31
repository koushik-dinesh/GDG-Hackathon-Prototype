// Google Meet connector: Workspace-domain OAuth with offline access and granular-consent checks,
// non-rotating refresh tokens, Meet-only calendar events with sync tokens (cancellations as
// tombstones, expired tokens), conference records with participants and transcripts, revocation
// on disconnect, and the end-to-end path through the API and sync engine — against a fake Google.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import * as queue from '../src/jobs/queue.js';
import { createHttpClient } from '../src/services/integrations/http.js';
import googleMeet, { configureGoogle, resetGoogleSettings } from '../src/services/integrations/providers/google/meet.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { vault } from '../src/services/integrations/vault.js';
import { describeConnector } from './integrations/contract.js';
import { CLIENT_ID, CLIENT_SECRET, DOMAIN, calendar, change, conference, meetEvent, startFakeGoogle } from './integrations/fakeGoogle.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const DAY = 86_400_000;
const iso = (offsetDays, h = 0) => new Date(Date.now() + offsetDays * DAY + h * 3_600_000).toISOString();
let fake;
let primary;
let creds = [];

function seed() {
  const s = fake.state;
  primary = calendar(s, { id: `ada@${DOMAIN}`, summary: 'Ada', primary: true });
  calendar(s, { id: 'team@group.calendar.google.com', summary: 'Team' });
  meetEvent(s, primary, { id: 'ev1', summary: 'Refund escalation review', start: iso(-2), end: iso(-2, 1), code: 'abc-defg-hij' });
  meetEvent(s, primary, { id: 'ev2', summary: 'Payments planning', start: iso(2), end: iso(2, 1), code: 'kln-opqr-stu' });
  meetEvent(s, primary, { id: 'ev3', summary: 'Lunch', start: iso(1), end: iso(1, 1) }); // no Meet
  conference(s, { id: 'conf-1', code: 'abc-defg-hij', start: iso(-2), end: iso(-2, 1), participants: 4, transcript: true });
  conference(s, { id: 'conf-2', code: 'zzz-zzzz-zzz', start: iso(-1), participants: 2 }); // still live
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
        for (const c of await googleMeet.refreshCredentials(ctx)) store.set(c.kind, c.value);
        return store.get(k) ?? null;
      },
    },
    store,
  };
  return ctx;
}

async function run(ctx, resource, stream, cursor = null) {
  const all = [];
  let done = false;
  for (let i = 0; !done && i < 30; i++) {
    const page = await googleMeet.syncStream(ctx, { resource, stream, cursor, phase: cursor ? 'incremental' : 'backfill', since: new Date(Date.now() - 30 * DAY) });
    all.push(...page.envelopes);
    ({ cursor, done } = page);
  }
  return { envelopes: all, cursor };
}

before(async () => {
  fake = await startFakeGoogle();
  configureGoogle({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, domain: DOMAIN, authUrl: fake.url, tokenUrl: `${fake.url}/token`, calendarUrl: fake.url, meetUrl: fake.url, appPublicUrl: 'http://localhost:5173' });
  seed();
  fake.state.codes.set('contract-code', 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/meetings.space.readonly');
  creds = (await googleMeet.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } })).credentials.map((c) => [c.kind, c.value]);
});
after(async () => {
  resetGoogleSettings();
  await fake.close();
});

describeConnector(googleMeet, {
  connectParams: { code: 'contract-code' },
  makeCtx,
  maxChunks: 20,
  failingCall: (c, ctx) => {
    fake.state.failNext.push({ match: /calendarList/, status: 500 });
    return c.listResources(ctx);
  },
});

describe('Google Meet connector', () => {
  it('asks for offline, read-only access limited to the Workspace domain', async () => {
    const u = new URL((await googleMeet.beginConnect({ state: 'state-123456' })).redirectUrl);
    assert.deepEqual(['access_type', 'prompt', 'hd'].map((k) => u.searchParams.get(k)), ['offline', 'consent', DOMAIN]);
    assert.match(u.searchParams.get('scope'), /calendar\.readonly .*meetings\.space\.readonly/);
  });

  it('refuses partial consent and accounts of other domains', async () => {
    await assert.rejects(googleMeet.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode('openid email https://www.googleapis.com/auth/calendar.readonly') } }), (e) => e.kind === 'forbidden' && /partly granted/.test(e.publicMessage));
    fake.state.account = 'mallory@gmail.test';
    await assert.rejects(googleMeet.completeConnect(makeCtx({ id: null }), { params: { code: fake.grantCode() } }), (e) => e.kind === 'forbidden' && /acme\.test/.test(e.publicMessage));
    fake.state.account = `ada@${DOMAIN}`;
  });

  it('keeps the refresh token across refreshes (Google does not rotate it)', async () => {
    const ctx = makeCtx({ id: 1 });
    const before = ctx.store.get('refresh_token');
    const fresh = await googleMeet.refreshCredentials(ctx);
    assert.equal(fresh.find((c) => c.kind === 'refresh_token').value, before);
  });

  it('syncs only Meet events, then changes and cancellations by sync token', async () => {
    const ctx = makeCtx({ id: 1 });
    const res = (await googleMeet.listResources(ctx)).find((r) => r.metadata.primary);
    const first = await run(ctx, res, 'events');
    const recs = first.envelopes.filter((e) => e.type === 'record');
    assert.deepEqual(recs.map((e) => [e.externalId.split('/')[1], e.externalKey, e.statusCategory]).sort(), [
      ['ev1', 'abc-defg-hij', 'done'],
      ['ev2', 'kln-opqr-stu', 'todo'],
    ]);
    assert.equal(recs[0].metadata.joinUrl.startsWith('https://meet.google.com/'), true);
    assert.ok(first.cursor.syncToken);

    change(fake.state, primary.events[1], { status: 'cancelled' });
    change(fake.state, primary.events[0], { summary: 'Refund escalation review (notes)' });
    const second = await run(ctx, res, 'events', first.cursor);
    assert.deepEqual(second.envelopes.filter((e) => e.type === 'record').map((e) => [e.externalId.split('/')[1], Boolean(e.deleted), e.title]).sort(), [
      ['ev1', false, 'Refund escalation review (notes)'],
      ['ev2', true, null],
    ]);
    fake.state.syncTokens.clear();
    const restarted = await run(ctx, res, 'events', second.cursor);
    assert.equal(restarted.envelopes.filter((e) => e.type === 'record').length, 1, '410: full sync from the window again');
  });

  it('records conferences with participants and transcripts on the primary calendar only', async () => {
    const ctx = makeCtx({ id: 1 });
    const [primaryRes, team] = await googleMeet.listResources(ctx);
    const { envelopes, cursor } = await run(ctx, primaryRes, 'conferences');
    const recs = Object.fromEntries(envelopes.filter((e) => e.type === 'record').map((e) => [e.externalId, e]));
    assert.deepEqual([recs['conf-1'].externalKey, recs['conf-1'].statusCategory, recs['conf-1'].metadata.participants], ['abc-defg-hij', 'done', 4]);
    assert.equal(recs['conf-1'].metadata.transcripts[0].document, 'https://docs.google.com/document/d/t1');
    assert.equal(recs['conf-2'].statusCategory, 'in_progress');
    assert.ok(envelopes.some((e) => e.type === 'activity' && e.activityType === 'conducted'));
    assert.equal(cursor.watermark, fake.state.conferences[1].startTime, 'next run revisits the live conference');
    assert.deepEqual((await run(ctx, team, 'conferences')).envelopes, []);
  });

  it('revokes the grant at Google when disconnecting', async () => {
    const ctx = makeCtx({ id: 1 });
    await googleMeet.disconnect(ctx);
    assert.deepEqual(fake.state.revoked, [ctx.store.get('refresh_token')]);
    await assert.rejects(googleMeet.refreshCredentials(ctx), (e) => e.kind === 'auth');
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

describe('Google Meet end to end', () => {
  before(async () => {
    await resetDatabase();
    ids.admin = await createUser({ email: 'admin@gm.test', role: 'admin', fullName: 'GM admin' });
    ids.mia = await createUser({ email: `mia@${DOMAIN}`, role: 'manager', fullName: 'Mia' });
    cookies.admin = await loginCookie(app, 'admin@gm.test');
    const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.mia]);
    ids.P = p.insertId;
    fake.reset();
    seed();
  });
  after(closeDatabase);

  it('connects, syncs Meet events and conferences into a project, matching organizers by e-mail', async () => {
    const start = await as('admin').post('/api/v1/integrations/google_meet/connect');
    const state = new URL(start.body.redirectUrl).searchParams.get('state');
    const res = await as('admin').post('/api/v1/integrations/google_meet/callback', { state, params: { code: fake.grantCode() } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const resource = res.body.resources.find((r) => r.metadata.primary);
    await as('admin').patch(`/api/v1/integrations/${res.body.connection.id}/resources/${resource.id}`, { isEnabled: true, projectId: ids.P });
    await syncAll(resource.id);
    const rows = (await pool.query("SELECT record_type, external_key, project_id FROM external_records WHERE provider = 'google_meet' ORDER BY record_type, external_key"))[0];
    assert.deepEqual(rows.map((r) => [r.record_type, r.external_key, r.project_id]), [
      ['calendar_event', 'abc-defg-hij', ids.P],
      ['calendar_event', 'kln-opqr-stu', ids.P],
      ['conference', 'abc-defg-hij', ids.P],
      ['conference', 'zzz-zzzz-zzz', ids.P],
    ]);
    const mia = (await pool.query("SELECT user_id FROM external_identities WHERE provider = 'google_meet' AND external_user_id = ?", [`mia@${DOMAIN}`]))[0][0];
    assert.equal(mia.user_id, ids.mia);
    assert.match((await vault.get(res.body.connection.id, 'refresh_token')).value, /^1\/\/fake_/);
  });
});
