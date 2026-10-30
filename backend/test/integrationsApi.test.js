// Phase 3A step 4: connection lifecycle and the admin integrations API (fake provider, no network).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { createConnectionService } from '../src/services/integrations/connections.js';
import fake, { fakeService, resetFakeService } from '../src/services/integrations/providers/fake/index.js';
import { createRegistry } from '../src/services/integrations/registry.js';
import { vault } from '../src/services/integrations/vault.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const responses = []; // every response body, for the leak check

const as = (who) => {
  const send = async (req) => {
    const res = await req;
    responses.push(JSON.stringify(res.body ?? {}));
    return res;
  };
  return {
    get: (url) => send(request(app).get(url).set('Cookie', cookies[who])),
    post: (url, body) => send(request(app).post(url).set('Cookie', cookies[who]).send(body)),
    patch: (url, body) => send(request(app).patch(url).set('Cookie', cookies[who]).send(body)),
  };
};

const stateFrom = (redirectUrl) => new URL(redirectUrl).searchParams.get('state');

async function connect(who = 'admin', params = { accountId: 'fake-org' }) {
  const start = await as(who).post('/api/v1/integrations/fake/connect');
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return as(who).post('/api/v1/integrations/fake/callback', { state: stateFrom(start.body.redirectUrl), params });
}

before(async () => {
  await resetDatabase();
  for (const [key, role] of [
    ['admin', 'admin'],
    ['admin2', 'admin'],
    ['manager', 'manager'],
    ['emp', 'employee'],
  ]) {
    ids[key] = await createUser({ email: `${key}@int.test`, role, fullName: `Int ${key}` });
    cookies[key] = await loginCookie(app, `${key}@int.test`);
  }
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.admin]);
  ids.project = p.insertId;
  const [a] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Old', ?, 'archived')", [ids.admin]);
  ids.archived = a.insertId;
});
after(closeDatabase);
beforeEach(async () => {
  resetFakeService();
  await pool.query('DELETE FROM webhook_deliveries');
  await pool.query('DELETE FROM integration_resources');
  await pool.query('DELETE FROM integration_connections');
  await pool.query('DELETE FROM integration_auth_states');
});

describe('access control', () => {
  it('is admin-only', async () => {
    for (const who of ['manager', 'emp']) {
      assert.equal((await as(who).get('/api/v1/integrations/providers')).status, 403);
      assert.equal((await as(who).post('/api/v1/integrations/fake/connect')).status, 403);
      assert.equal((await as(who).get('/api/v1/integrations')).status, 403);
    }
    assert.equal((await request(app).get('/api/v1/integrations')).status, 401);
  });

  it('lists providers with availability and no configuration values', async () => {
    const res = await as('admin').get('/api/v1/integrations/providers');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.providers.map((p) => [p.id, p.available]), [['github', false], ['fake', true]], 'GitHub is listed but not configured in tests');
    assert.equal(res.body.providers[0].problem, 'GITHUB_APP_ID is not set');
  });
});

describe('connecting', () => {
  it('connects through a single-use state, stores credentials and lists resources disabled', async () => {
    const res = await connect();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const { connection, resources } = res.body;
    assert.equal(connection.status, 'active');
    assert.equal(connection.isEnabled, true);
    assert.equal(connection.externalAccountId, 'fake-org');
    assert.equal(connection.displayName, 'Fake Org');
    assert.equal(connection.connectedBy, ids.admin);
    assert.deepEqual(resources.map((r) => [r.name, r.isEnabled, r.accessStatus]), [
      ['fake-org/api', false, 'accessible'],
      ['fake-org/web', false, 'accessible'],
    ]);
    assert.match((await vault.get(connection.id, 'api_token')).value, /^fake-token-/);

    const detail = await as('admin').get(`/api/v1/integrations/${connection.id}`);
    assert.deepEqual(detail.body.credentialKinds.map((c) => c.kind), ['api_token']);
    assert.deepEqual(detail.body.recentDeliveries, []);

    const [[audit]] = await pool.query("SELECT * FROM audit_logs WHERE action = 'integration.connected' AND entity_id = ?", [connection.id]);
    assert.equal(audit.actor_user_id, ids.admin);
    assert.ok(!JSON.stringify(audit.after_json).includes('fake-token-'));
  });

  it('refuses reused, foreign, expired and unknown states', async () => {
    const start = await as('admin').post('/api/v1/integrations/fake/connect');
    const state = stateFrom(start.body.redirectUrl);
    const callback = (who, s = state) => as(who).post('/api/v1/integrations/fake/callback', { state: s, params: { accountId: 'fake-org' } });

    assert.equal((await callback('admin2')).body.error?.code, 'INVALID_STATE', 'another admin cannot use it');
    assert.equal((await callback('admin')).status, 201);
    assert.equal((await callback('admin')).body.error?.code, 'INVALID_STATE', 'single use');

    const start2 = await as('admin').post('/api/v1/integrations/fake/connect');
    await pool.execute('UPDATE integration_auth_states SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND)');
    assert.equal((await callback('admin', stateFrom(start2.body.redirectUrl))).body.error?.code, 'INVALID_STATE', 'expired');
    assert.equal((await callback('admin', 'x'.repeat(43))).body.error?.code, 'INVALID_STATE');
    assert.equal((await as('admin').post('/api/v1/integrations/jira/connect')).status, 404, 'unknown provider');
    assert.equal((await as('admin').post('/api/v1/integrations/github/connect')).status, 503, 'known but not configured');
    assert.equal((await as('admin').post('/api/v1/integrations/fake/callback', { state: 'short' })).status, 400);
  });

  it('reports provider failures safely and still consumes the state', async () => {
    const start = await as('admin').post('/api/v1/integrations/fake/connect');
    const state = stateFrom(start.body.redirectUrl);
    const res = await as('admin').post('/api/v1/integrations/fake/callback', { state, params: { accountId: 'nobody' } });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'PROVIDER_ERROR');
    const retry = await as('admin').post('/api/v1/integrations/fake/callback', { state, params: { accountId: 'fake-org' } });
    assert.equal(retry.body.error.code, 'INVALID_STATE');

    fakeService.accounts['fake-org'].displayName = '';
    const invalid = await connect();
    assert.equal(invalid.status, 502, 'a connector returning an invalid result is a provider error');
    assert.equal(invalid.body.error.code, 'PROVIDER_ERROR');
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM integration_connections');
    assert.equal(n, 0);
  });

  it('keeps the connection when listing resources fails after connecting', async () => {
    fakeService.failNext.listResources = 'transient';
    const res = await connect();
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.resources, []);
    assert.match(res.body.resourceError, /temporarily unavailable/);
    assert.equal(res.body.connection.lastErrorCode, 'transient');
    const refreshed = await as('admin').post(`/api/v1/integrations/${res.body.connection.id}/resources/refresh`);
    assert.equal(refreshed.body.resources.length, 2);
  });

  it('reconnecting the same account reuses the row and replaces the credentials', async () => {
    const first = (await connect()).body.connection;
    const firstToken = (await vault.get(first.id, 'api_token')).value;
    await as('admin').post(`/api/v1/integrations/${first.id}/disconnect`);
    const again = await connect('admin2');
    assert.equal(again.status, 200);
    assert.equal(again.body.reconnected, true);
    assert.equal(again.body.connection.id, first.id);
    assert.equal(again.body.connection.status, 'active');
    assert.equal(again.body.connection.connectedBy, ids.admin2);
    assert.equal(again.body.connection.disconnectedAt, null);
    assert.notEqual((await vault.get(first.id, 'api_token')).value, firstToken);
  });

  it('is unavailable without the encryption key', async () => {
    const service = createConnectionService({ registry: createRegistry([fake], { keyConfigured: () => false }) });
    await assert.rejects(service.startConnect({ providerId: 'fake', actor: { id: ids.admin } }), (err) => err.status === 503 && /CREDENTIALS_ENCRYPTION_KEY/.test(err.message));
  });
});

describe('managing a connection', () => {
  it('enables, maps and validates resources', async () => {
    const { connection, resources } = (await connect()).body;
    const [api, web] = resources;
    const url = (r) => `/api/v1/integrations/${connection.id}/resources/${r.id}`;

    const res = await as('admin').patch(url(api), { isEnabled: true, projectId: ids.project });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.resource.isEnabled, true);
    assert.equal(res.body.resource.projectId, ids.project);
    assert.ok(res.body.resource.nextSyncAt, 'enabling makes it due for sync');

    assert.equal((await as('admin').patch(url(api), { projectId: '' })).body.resource.projectId, null);
    assert.equal((await as('admin').patch(url(web), { projectId: ids.archived })).status, 400);
    assert.equal((await as('admin').patch(url(web), { projectId: 999999 })).status, 400);
    assert.equal((await as('admin').patch(url(web), {})).status, 400);
    assert.equal((await as('admin').patch(`/api/v1/integrations/${connection.id + 1}/resources/${web.id}`, { isEnabled: true })).status, 404);

    const [[audit]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'integration.resource_updated'");
    assert.equal(audit.n, 2);
  });

  it('marks resources the provider no longer lists as removed, and adds new ones', async () => {
    const { connection, resources } = (await connect()).body;
    await as('admin').patch(`/api/v1/integrations/${connection.id}/resources/${resources[1].id}`, { isEnabled: true });
    fakeService.accounts['fake-org'].resources = [
      { externalId: '101', name: 'fake-org/api-renamed', private: true },
      { externalId: '103', name: 'fake-org/mobile', private: false },
    ];
    const res = await as('admin').post(`/api/v1/integrations/${connection.id}/resources/refresh`);
    assert.deepEqual(res.body.resources.map((r) => [r.name, r.accessStatus, r.isEnabled]), [
      ['fake-org/api-renamed', 'accessible', false],
      ['fake-org/mobile', 'accessible', false],
      ['fake-org/web', 'removed', true],
    ]);
    const enableRemoved = await as('admin').patch(`/api/v1/integrations/${connection.id}/resources/${resources[1].id}`, { isEnabled: true });
    assert.equal(enableRemoved.status, 409);
  });

  it('pauses, renames and lists connections', async () => {
    const { connection } = (await connect()).body;
    const res = await as('admin').patch(`/api/v1/integrations/${connection.id}`, { isEnabled: false, displayName: 'Payments org' });
    assert.equal(res.body.connection.isEnabled, false);
    assert.equal(res.body.connection.displayName, 'Payments org');
    assert.equal((await as('admin').patch(`/api/v1/integrations/${connection.id}`, { status: 'active' })).status, 400, 'status is not editable');
    const listed = await as('admin').get('/api/v1/integrations?status=active');
    assert.deepEqual(listed.body.connections.map((c) => c.id), [connection.id]);
    assert.equal((await as('admin').get('/api/v1/integrations/999999')).status, 404);
    assert.deepEqual((await as('admin').get(`/api/v1/integrations/${connection.id}/webhook-deliveries`)).body.deliveries, []);
  });

  it('disconnects: deletes credentials, tells the provider, keeps the row, blocks re-enabling', async () => {
    const { connection, resources } = (await connect()).body;
    const res = await as('admin').post(`/api/v1/integrations/${connection.id}/disconnect`, { uninstall: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.connection.status, 'disconnected');
    assert.equal(res.body.connection.isEnabled, false);
    assert.equal(res.body.connection.disconnectedBy, ids.admin);
    assert.equal(await vault.get(connection.id, 'api_token'), null);
    assert.deepEqual(fakeService.disconnected, [{ externalAccountId: 'fake-org', uninstall: true }]);

    assert.equal((await as('admin').patch(`/api/v1/integrations/${connection.id}`, { isEnabled: true })).status, 409);
    assert.equal((await as('admin').post(`/api/v1/integrations/${connection.id}/resources/refresh`)).status, 409);
    assert.equal((await as('admin').patch(`/api/v1/integrations/${connection.id}/resources/${resources[0].id}`, { isEnabled: true })).status, 409);
    assert.equal((await as('admin').post(`/api/v1/integrations/${connection.id}/disconnect`)).status, 200, 'idempotent');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'integration.disconnected' AND entity_id = ?", [connection.id]);
    assert.equal(n, 1);
  });
});

describe('secrets', () => {
  it('never appear in any API response, audit row or job payload', async () => {
    const [rows] = await pool.query('SELECT before_json, after_json FROM audit_logs');
    const [jobs] = await pool.query('SELECT payload FROM jobs');
    const haystack = [...responses, ...rows.map((r) => JSON.stringify(r)), ...jobs.map((j) => JSON.stringify(j))].join('\n');
    assert.ok(responses.length > 20, 'the other tests ran first');
    assert.ok(!haystack.includes('fake-token-'), 'credential values leaked');
    assert.ok(!/ciphertext|auth_tag|"iv"/.test(responses.join('\n')), 'credential columns leaked');
  });
});
