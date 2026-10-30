// Phase 3A step 10: secret-leak regression. Runs the whole integration lifecycle with recognisable
// secrets and checks that none of them appears in API responses, log lines, job payloads, audit
// rows, delivery rows, or in the credentials table as plaintext.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import { processNext } from '../src/jobs/runner.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import { buildContext } from '../src/services/integrations/context.js';
import fake, { fakeService, resetFakeService, signedFakeWebhook } from '../src/services/integrations/providers/fake/index.js';
import { setLogLevelForTests } from '../src/utils/logger.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const TOKEN = 'LEAKCHECK-TOKEN-7f3a9c';
const REFRESHED = 'LEAKCHECK-REFRESHED-91bd';
const WEBHOOK_SECRET = 'LEAKCHECK-WEBHOOK-SECRET-55e1';
const SECRETS = [TOKEN, REFRESHED, WEBHOOK_SECRET];

const app = createApp();
const responses = [];
const logLines = [];
let restore;
let cookie;
let stateSeen;

async function call(method, url, body) {
  const res = await request(app)[method](url).set('Cookie', cookie).send(body);
  responses.push(JSON.stringify({ status: res.status, body: res.body, headers: res.headers }));
  return res;
}
const work = async () => {
  for (let i = 0; i < 20; i++) {
    await pool.query("UPDATE jobs SET run_at = NOW() WHERE status = 'pending'");
    if (!(await processNext('leak', handlersFor(['integration.sync', 'integration.webhook', 'integration.maintenance'])))) return;
  }
};

before(async () => {
  await resetDatabase();
  resetFakeService();
  fakeService.webhookSecret = WEBHOOK_SECRET;
  // The fake provider hands out our recognisable tokens.
  const originalConnect = fake.completeConnect;
  const originalRefresh = fake.refreshCredentials;
  fake.completeConnect = async (...args) => {
    const r = await originalConnect.apply(fake, args);
    return { ...r, credentials: [{ kind: 'api_token', value: TOKEN, expiresAt: new Date(Date.now() + 60_000) }] };
  };
  fake.refreshCredentials = async () => [{ kind: 'api_token', value: REFRESHED, expiresAt: new Date(Date.now() + 3600_000) }];

  // Capture every log line.
  setLogLevelForTests('debug');
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    if (String(chunk).startsWith('{"time"')) {
      logLines.push(String(chunk));
      return true;
    }
    return out(chunk, ...rest);
  };
  process.stderr.write = (chunk, ...rest) => {
    if (String(chunk).startsWith('{"time"')) {
      logLines.push(String(chunk));
      return true;
    }
    return err(chunk, ...rest);
  };
  restore = () => {
    process.stdout.write = out;
    process.stderr.write = err;
    fake.completeConnect = originalConnect;
    fake.refreshCredentials = originalRefresh;
    setLogLevelForTests('error');
    resetFakeService();
  };

  await createUser({ email: 'leak@check.test', role: 'admin' });
  cookie = await loginCookie(app, 'leak@check.test');
});
after(async () => {
  restore?.();
  await closeDatabase();
});

describe('secret-leak regression', () => {
  it('runs the whole lifecycle', async () => {
    const start = await call('post', '/api/v1/integrations/fake/connect');
    stateSeen = new URL(start.body.redirectUrl).searchParams.get('state');
    const connected = await call('post', '/api/v1/integrations/fake/callback', { state: stateSeen, params: { accountId: 'fake-org' } });
    assert.equal(connected.status, 201);
    const { connection, resources } = connected.body;

    // Credentials are refreshed when they expire (the token expires in 60 s: inside the refresh window).
    assert.equal(await buildContext(fake, await connections.findById(connection.id)).credentials.get('api_token'), REFRESHED);

    await call('patch', `/api/v1/integrations/${connection.id}/resources/${resources[0].id}`, { isEnabled: true });
    await call('post', `/api/v1/integrations/${connection.id}/sync`);
    await work();

    const hook = signedFakeWebhook(
      { action: 'updated', account: { id: 'fake-org' }, resource: { externalId: '101', name: 'fake-org/api' }, item: { id: '1001', number: 1, title: 'x', state: 'open', author: 'u1', updatedAt: '2026-10-29T00:00:00Z' } },
      { deliveryId: 'leak-1' },
    );
    const req = request(app).post('/api/v1/webhooks/fake');
    for (const [k, v] of Object.entries(hook.headers)) req.set(k, v);
    responses.push(JSON.stringify((await req.send(hook.rawBody.toString('utf8'))).body));
    await work();
    const [[delivery]] = await pool.query("SELECT id FROM webhook_deliveries WHERE delivery_id = 'leak-1'");
    await call('post', `/api/v1/integrations/webhook-deliveries/${delivery.id}/replay`);
    await work();

    for (const url of ['/api/v1/integrations', `/api/v1/integrations/${connection.id}`, `/api/v1/integrations/${connection.id}/webhook-deliveries`, '/api/v1/integrations/identities', '/api/v1/external-records', '/api/v1/activities']) {
      assert.equal((await call('get', url)).status, 200, url);
    }
    // A failing provider call (its error goes through logs and the connection row).
    fakeService.failNext.syncStream = 'auth';
    await call('post', `/api/v1/integrations/${connection.id}/sync`);
    await work();
    await call('post', `/api/v1/integrations/${connection.id}/disconnect`, {});
    assert.ok(logLines.length > 10, 'logs were captured');
  });

  it('leaves no secret in responses, logs, jobs, audit or delivery rows', async () => {
    const [jobs] = await pool.query('SELECT payload, last_error FROM jobs');
    const [audit] = await pool.query('SELECT action, before_json, after_json FROM audit_logs');
    const [conns] = await pool.query('SELECT * FROM integration_connections');
    const [deliveries] = await pool.query('SELECT * FROM webhook_deliveries');
    const places = {
      responses: responses.join('\n'),
      logs: logLines.join(''),
      jobs: JSON.stringify(jobs),
      audit: JSON.stringify(audit),
      connections: JSON.stringify(conns),
      deliveries: JSON.stringify(deliveries),
    };
    for (const [where, text] of Object.entries(places)) {
      // The connect state must reach the browser (it is in the redirect URL of the connect
      // response) but nowhere else: not logs, jobs, audit or stored rows.
      const checked = where === 'responses' ? SECRETS : [...SECRETS, stateSeen];
      for (const secret of checked) assert.ok(!text.includes(secret), `${secret.slice(0, 12)}… leaked into ${where}`);
    }
    const [states] = await pool.query('SELECT state_hash FROM integration_auth_states');
    assert.ok(states.length > 0 && !JSON.stringify(states).includes(stateSeen), 'only the hash of the state is stored');
  });

  it('stores credentials only as ciphertext', async () => {
    // Disconnect deleted them; reconnect to inspect a stored row.
    const start = await call('post', '/api/v1/integrations/fake/connect');
    const res = await call('post', '/api/v1/integrations/fake/callback', { state: new URL(start.body.redirectUrl).searchParams.get('state'), params: { accountId: 'fake-org' } });
    assert.equal(res.status, 200);
    const [rows] = await pool.query('SELECT * FROM integration_credentials');
    assert.ok(rows.length > 0);
    const dump = rows.map((r) => Object.values(r).map((v) => (Buffer.isBuffer(v) ? v.toString('latin1') : String(v))).join('|')).join('\n');
    for (const secret of SECRETS) assert.ok(!dump.includes(secret));
  });

  it('only the vault imports the credentials repository', async () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const offenders = [];
    async function walk(dir) {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) await walk(`${path}/`);
        else if (entry.name.endsWith('.js') && !path.endsWith('services/integrations/vault.js')) {
          if ((await readFile(path, 'utf8')).includes('integrationCredentialsRepository')) offenders.push(path.slice(root.length));
        }
      }
    }
    await walk(root);
    assert.deepEqual(offenders, []);
  });
});
