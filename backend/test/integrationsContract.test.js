import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { assertConnector, connectorProblems } from '../src/services/integrations/contract.js';
import { ProviderError } from '../src/services/integrations/errors.js';
import fake, { fakeService, resetFakeService, signedFakeWebhook } from '../src/services/integrations/providers/fake/index.js';
import { createRegistry, registry } from '../src/services/integrations/registry.js';
import { describeConnector } from './integrations/contract.js';

const makeCtx = (connection, resource) => ({
  connection,
  resource,
  credentials: { get: async () => null },
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

beforeEach(resetFakeService);
after(resetFakeService);

describeConnector(fake, {
  connectParams: { accountId: 'fake-org' },
  makeCtx: (connection, resource) => makeCtx({ ...connection, externalAccountId: connection.externalAccountId ?? 'fake-org' }, resource),
  validWebhook: () =>
    signedFakeWebhook({
      action: 'updated',
      account: { id: 'fake-org' },
      resource: { externalId: '101', name: 'fake-org/api' },
      item: { id: '1001', number: 1, title: 'Payment API v2', state: 'open', author: 'u1', updatedAt: '2026-10-02T09:00:00.000Z' },
    }),
  failingCall: (c, ctx) => {
    fakeService.failNext.listResources = 'transient';
    return c.listResources(ctx);
  },
});

describe('connector contract checks', () => {
  const valid = () => ({ ...fake, capabilities: { ...fake.capabilities } });

  it('accepts a complete connector', () => {
    assert.deepEqual(connectorProblems(valid()), []);
    assert.equal(assertConnector(valid()).id, 'fake');
  });

  it('names every missing or malformed part', () => {
    const c = valid();
    c.id = 'Bad Id';
    delete c.syncStream;
    delete c.verifyWebhook;
    c.disconnect = 'nope';
    c.capabilities.install = 'magic';
    const problems = connectorProblems(c);
    assert.ok(problems.some((p) => p.startsWith('id must match')));
    assert.ok(problems.includes('syncStream() is required'));
    assert.ok(problems.includes('verifyWebhook() is required'));
    assert.ok(problems.includes('disconnect must be a function when present'));
    assert.ok(problems.some((p) => p.startsWith('capabilities.install')));
    assert.throws(() => assertConnector(c), /Invalid connector "Bad Id"/);
  });

  it('only requires the methods of the declared capabilities', () => {
    const pollingOnly = valid();
    pollingOnly.capabilities.webhooks = false;
    delete pollingOnly.verifyWebhook;
    delete pollingOnly.parseWebhook;
    delete pollingOnly.handleWebhook;
    assert.deepEqual(connectorProblems(pollingOnly), []);
    const neither = valid();
    neither.capabilities.webhooks = false;
    neither.capabilities.polling = false;
    assert.ok(connectorProblems(neither).includes('a connector must support webhooks, polling or both'));
  });
});

describe('provider registry', () => {
  it('registers the fake provider in tests and describes it without configuration values', () => {
    const entry = registry.list().find((p) => p.id === 'fake');
    assert.deepEqual(entry, {
      id: 'fake',
      displayName: 'Fake provider',
      capabilities: { install: 'api_token', webhooks: true, polling: true, credentials: true },
      available: true,
      problem: null,
    });
    assert.equal(registry.get('fake'), fake);
    assert.equal(registry.get('asana'), null);
    assert.equal(registry.problem('asana'), 'Unknown provider');
    assert.equal(registry.problem('github'), 'GITHUB_APP_ID is not set', 'GitHub is registered and unavailable until configured');
  });

  it('marks providers unavailable when their config or the encryption key is missing', () => {
    const misconfigured = { ...fake, id: 'other', configProblem: () => 'OTHER_APP_ID is not set' };
    const reg = createRegistry([fake, misconfigured], { keyConfigured: () => false });
    assert.equal(reg.problem('fake'), 'CREDENTIALS_ENCRYPTION_KEY is not set');
    assert.equal(reg.problem('other'), 'OTHER_APP_ID is not set');
    assert.equal(reg.getAvailable('fake'), null);
    assert.equal(reg.get('fake'), fake);
    const noCreds = { ...fake, id: 'nocreds', capabilities: { ...fake.capabilities, credentials: false } };
    assert.equal(createRegistry([noCreds], { keyConfigured: () => false }).getAvailable('nocreds'), noCreds);
  });

  it('rejects invalid or duplicate connectors at startup', () => {
    assert.throws(() => createRegistry([{ id: 'x' }]), /Invalid connector/);
    assert.throws(() => createRegistry([fake, fake]), /Duplicate connector id "fake"/);
  });
});

describe('fake provider behaviour', () => {
  const ctx = makeCtx({ id: 1, externalAccountId: 'fake-org' });

  it('pages a resource oldest-first and resumes from its cursor', async () => {
    const resource = { externalId: '101', name: 'fake-org/api' };
    const first = await fake.syncStream(ctx, { resource, stream: 'items', cursor: null });
    assert.equal(first.done, false);
    assert.deepEqual(first.envelopes.filter((e) => e.type === 'record').map((e) => e.externalId), ['1001', '1002']);
    const second = await fake.syncStream(ctx, { resource, stream: 'items', cursor: first.cursor });
    assert.equal(second.done, true);
    assert.deepEqual(second.envelopes.filter((e) => e.type === 'record').map((e) => e.externalId), ['1003']);
    const idle = await fake.syncStream(ctx, { resource, stream: 'items', cursor: second.cursor });
    assert.deepEqual(idle, { envelopes: [], cursor: second.cursor, phase: 'incremental', done: true });
  });

  it('produces deterministic activity keys so webhook and sync events match', async () => {
    const resource = { externalId: '101', name: 'fake-org/api' };
    const item = fakeService.items[101][0];
    const page = await fake.syncStream(ctx, { resource, stream: 'items', cursor: null });
    const viaWebhook = await fake.handleWebhook(ctx, { eventType: 'item', payload: { resource, item } });
    const key = (envs) => envs.find((e) => e.type === 'activity' && e.recordRef.externalId === item.id).dedupeKey;
    assert.equal(key(page.envelopes), key(viaWebhook.envelopes));
  });

  it('injects failures once, as ProviderError', async () => {
    fakeService.failNext.syncStream = 'rate_limited';
    await assert.rejects(fake.syncStream(ctx, { resource: { externalId: '101', name: 'x' }, stream: 'items' }), (err) => {
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, 'rate_limited');
      assert.ok(err.waitMs() > 0 && err.waitMs() <= 60_000);
      return true;
    });
    await fake.syncStream(ctx, { resource: { externalId: '101', name: 'x' }, stream: 'items' });
  });

  it('maps account lifecycle webhooks and rejects a wrong secret', async () => {
    assert.deepEqual(await fake.handleWebhook(ctx, { eventType: 'account', action: 'suspended' }), { envelopes: [], lifecycle: { status: 'suspended' } });
    const forged = signedFakeWebhook({ action: 'x' }, { secret: 'not-the-secret' });
    assert.equal(fake.verifyWebhook(forged), false);
  });
});

describe('provider errors', () => {
  it('carry retryability, a public message and a wait time', () => {
    const transient = new ProviderError('transient', 'GET /x -> 502', { status: 502 });
    assert.equal(transient.retryable, true);
    assert.equal(new ProviderError('auth', 'GET /x -> 401').retryable, false);
    assert.match(new ProviderError('auth', 'x').publicMessage, /reconnect/);
    const resetAt = new Date(Date.now() + 5000);
    assert.ok(new ProviderError('rate_limited', 'x', { resetAt }).waitMs() <= 5000);
    assert.equal(new ProviderError('rate_limited', 'x', { retryAfterMs: 1234 }).waitMs(), 1234);
    assert.throws(() => new ProviderError('nope', 'x'), /Unknown provider error kind/);
  });
});
