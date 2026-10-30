// Fake provider (Phase 3A): a complete connector with no network, used by the test suite and,
// with INTEGRATIONS_FAKE_PROVIDER=true outside production, to try the Integrations screens.
// It is the reference for how a connector maps a provider to the normalized envelopes.
//
// Its "service" is the in-memory `fakeService` below. Tests may change it (accounts, items,
// failures); `resetFakeService()` restores the defaults.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../../../../config/index.js';
import { ProviderError } from '../../errors.js';

const PAGE_SIZE = 2;
const SOURCE = 'fake.test';

function defaultService() {
  const t = (minutes) => new Date(Date.UTC(2026, 9, 1, 9, minutes)).toISOString();
  return {
    webhookSecret: 'fake-webhook-secret',
    health: 'healthy',
    // Next call to a named operation throws this ProviderError kind once ({ op: kind }).
    failNext: {},
    disconnected: [],
    accounts: {
      'fake-org': {
        login: 'fake-org',
        type: 'Organization',
        displayName: 'Fake Org',
        resources: [
          { externalId: '101', name: 'fake-org/api', private: true },
          { externalId: '102', name: 'fake-org/web', private: false },
        ],
      },
    },
    people: { u1: { login: 'ana', displayName: 'Ana Garcia' }, u2: { login: 'raj', displayName: 'Raj Patel' } },
    // resource externalId -> items (ordered by updatedAt)
    items: {
      101: [
        { id: '1001', number: 1, title: 'Payment API', state: 'open', author: 'u1', updatedAt: t(1) },
        { id: '1002', number: 2, title: 'Refund flow', state: 'closed', author: 'u2', updatedAt: t(2) },
        { id: '1003', number: 3, title: 'Webhook retries', state: 'open', author: 'u1', updatedAt: t(3) },
      ],
      102: [{ id: '2001', number: 1, title: 'Checkout page', state: 'open', author: 'u2', updatedAt: t(4) }],
    },
  };
}

export const fakeService = defaultService();
export function resetFakeService() {
  for (const key of Object.keys(fakeService)) delete fakeService[key];
  Object.assign(fakeService, defaultService());
}

function maybeFail(op) {
  const kind = fakeService.failNext[op];
  if (!kind) return;
  delete fakeService.failNext[op];
  throw new ProviderError(kind, `fake ${op} failed (${kind})`, kind === 'rate_limited' ? { resetAt: new Date(Date.now() + 60_000) } : {});
}

const STATUS = { open: 'todo', closed: 'done' };

/** Normalized envelopes for one item (record + identity + activity). */
function itemEnvelopes(resource, item, origin) {
  const person = fakeService.people[item.author];
  return [
    { type: 'identity', externalUserId: item.author, login: person?.login ?? null, displayName: person?.displayName ?? null, isBot: false },
    {
      type: 'record',
      recordType: 'issue',
      externalId: item.id,
      externalKey: `${resource.name}#${item.number}`,
      url: `https://${SOURCE}/${resource.name}/issues/${item.number}`,
      title: item.title,
      body: item.body ?? null,
      state: item.state,
      statusCategory: STATUS[item.state] ?? 'unknown',
      authorRef: { externalUserId: item.author },
      sourceCreatedAt: item.createdAt ?? item.updatedAt,
      sourceUpdatedAt: item.updatedAt,
      metadata: { number: item.number, origin },
    },
    {
      type: 'activity',
      dedupeKey: `${SOURCE}:issue:${item.id}:updated:${Date.parse(item.updatedAt)}`,
      activityType: 'updated',
      recordRef: { recordType: 'issue', externalId: item.id },
      actorRef: { externalUserId: item.author },
      occurredAt: item.updatedAt,
      summary: `${person?.login ?? item.author} updated ${resource.name}#${item.number}`,
      details: { state: item.state },
    },
  ];
}

function sign(secret, rawBody) {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** Headers + raw body of a correctly signed fake webhook (for tests and local demos). */
export function signedFakeWebhook(body, { deliveryId = randomBytes(8).toString('hex'), event = 'item', secret = fakeService.webhookSecret } = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    rawBody,
    headers: { 'content-type': 'application/json', 'x-fake-delivery': deliveryId, 'x-fake-event': event, 'x-fake-signature': sign(secret, rawBody) },
  };
}

const header = (headers, name) => {
  if (typeof headers?.get === 'function') return headers.get(name);
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
};

export default {
  id: 'fake',
  displayName: 'Fake provider',
  sourceInstance: SOURCE,
  capabilities: { install: 'api_token', webhooks: true, polling: true, credentials: true },

  configProblem: () => null,

  beginConnect({ state }) {
    // A real provider would show its own consent screen; the fake one goes straight back.
    const base = config.email.appPublicUrl ?? 'http://localhost:5173';
    const url = new URL('/integrations/fake/setup', base);
    url.searchParams.set('account_id', 'fake-org');
    url.searchParams.set('state', state);
    return { redirectUrl: url.toString() };
  },

  async completeConnect(ctx, { params }) {
    maybeFail('completeConnect');
    const account = fakeService.accounts[params?.accountId];
    if (!account) throw new ProviderError('not_found', 'Unknown fake account');
    return {
      account: { externalAccountId: params.accountId, login: account.login, type: account.type, displayName: account.displayName },
      settings: { scopes: ['read'] },
      credentials: [{ kind: 'api_token', value: `fake-token-${randomBytes(12).toString('hex')}` }],
    };
  },

  async refreshCredentials() {
    maybeFail('refreshCredentials');
    return [{ kind: 'api_token', value: `fake-token-${randomBytes(12).toString('hex')}` }];
  },

  async disconnect(ctx, { uninstall = false } = {}) {
    fakeService.disconnected.push({ externalAccountId: ctx.connection.externalAccountId, uninstall });
  },

  async listResources(ctx) {
    maybeFail('listResources');
    const account = fakeService.accounts[ctx.connection.externalAccountId];
    if (!account) throw new ProviderError('auth', 'Fake account no longer exists');
    return account.resources.map((r) => ({
      resourceType: 'repository',
      externalId: r.externalId,
      name: r.name,
      url: `https://${SOURCE}/${r.name}`,
      metadata: { private: r.private },
    }));
  },

  async health() {
    return { status: fakeService.health };
  },

  streams: () => ['items'],

  /**
   * One page per call, oldest change first. The cursor is { after } (last updatedAt + id seen),
   * so repeating a call with the same cursor returns the same page (idempotent).
   */
  async syncStream(ctx, { resource, stream, cursor }) {
    maybeFail('syncStream');
    if (stream !== 'items') throw new ProviderError('invalid_request', `Unknown stream ${stream}`);
    const all = fakeService.items[resource.externalId] ?? [];
    const after = cursor?.after;
    const newer = all.filter((i) => !after || i.updatedAt > after.updatedAt || (i.updatedAt === after.updatedAt && i.id > after.id));
    const page = newer.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return {
      envelopes: page.flatMap((item) => itemEnvelopes(resource, item, 'sync')),
      cursor: last ? { after: { updatedAt: last.updatedAt, id: last.id } } : cursor ?? null,
      phase: 'incremental',
      done: newer.length <= PAGE_SIZE,
    };
  },

  verifyWebhook({ headers, rawBody }) {
    const given = header(headers, 'x-fake-signature');
    if (typeof given !== 'string' || !Buffer.isBuffer(rawBody)) return false;
    const expected = Buffer.from(sign(fakeService.webhookSecret, rawBody));
    const actual = Buffer.from(given);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  },

  parseWebhook({ headers, body }) {
    const deliveryId = header(headers, 'x-fake-delivery');
    const eventType = header(headers, 'x-fake-event');
    if (!deliveryId || !eventType) throw new ProviderError('invalid_request', 'Missing fake delivery headers');
    return { deliveryId, eventType, action: body?.action ?? null, externalAccountId: body?.account?.id ?? null };
  },

  async handleWebhook(ctx, { eventType, action, payload }) {
    maybeFail('handleWebhook');
    if (eventType === 'account') {
      const status = { suspended: 'suspended', unsuspended: 'active', deleted: 'disconnected' }[action];
      return { envelopes: [], lifecycle: status ? { status } : undefined };
    }
    if (eventType === 'item' && payload?.item && payload?.resource) {
      return {
        envelopes: itemEnvelopes(payload.resource, payload.item, 'webhook'),
        resourceRef: { resourceType: 'repository', externalId: String(payload.resource.externalId) },
      };
    }
    return { envelopes: [] };
  },
};
