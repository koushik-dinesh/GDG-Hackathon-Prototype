// Reusable connector contract suite (Phase 3A, docs/PHASE_3A_PLAN.md §12). Every connector runs it
// with its own fixtures: the fake provider in 3A, GitHub (recorded fixtures) in 3B.
// Not a *.test.js file, so it only runs when a test file calls describeConnector().
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectorProblems, ENVELOPE_TYPES } from '../../src/services/integrations/contract.js';
import { ProviderError } from '../../src/services/integrations/errors.js';

/**
 * @param connector the module under test
 * @param fixtures {
 *   connectParams,                      params completeConnect() accepts
 *   makeCtx(connection, resource?)      ctx with http/credentials/logger for this connector
 *   validWebhook()                      -> { headers, rawBody }  (correctly signed)
 *   maxChunks?                          upper bound for a full sync of the first resource
 * }
 */
export function describeConnector(connector, fixtures) {
  describe(`connector contract: ${connector.id}`, () => {
    const connection = { id: 1, externalAccountId: null, provider: connector.id, sourceInstance: connector.sourceInstance };

    it('satisfies the module contract', () => {
      assert.deepEqual(connectorProblems(connector), []);
      const p = connector.configProblem();
      assert.ok(p === null || typeof p === 'string');
    });

    it('starts a connection with a redirect that carries the state', async () => {
      const state = 'contract-state-123';
      const { redirectUrl } = await connector.beginConnect({ state });
      const url = new URL(redirectUrl);
      assert.ok(['https:', 'http:'].includes(url.protocol));
      assert.ok(redirectUrl.includes(state));
    });

    it('completes a connection with an account and well-formed credentials', async () => {
      const result = await connector.completeConnect(fixtures.makeCtx(connection), { params: fixtures.connectParams });
      assert.equal(typeof result.account.externalAccountId, 'string');
      assert.ok(result.account.displayName);
      for (const c of result.credentials ?? []) {
        assert.match(c.kind, /^[a-z][a-z0-9_]{1,31}$/);
        assert.equal(typeof c.value, 'string');
      }
      if (connector.capabilities.credentials) assert.ok(result.credentials?.length > 0, 'credential-storing connectors return credentials');
      connection.externalAccountId = result.account.externalAccountId;
    });

    it('lists resources in the normalized shape', async () => {
      const resources = await connector.listResources(fixtures.makeCtx(connection));
      assert.ok(Array.isArray(resources) && resources.length > 0);
      for (const r of resources) {
        assert.equal(typeof r.resourceType, 'string');
        assert.equal(typeof r.externalId, 'string');
        assert.equal(typeof r.name, 'string');
      }
    });

    it('reports health', async () => {
      const h = await connector.health(fixtures.makeCtx(connection));
      assert.ok(['healthy', 'degraded', 'failing'].includes(h.status));
    });

    if (connector.capabilities.polling) {
      it('syncs every stream in bounded, repeatable chunks until done', async () => {
        const [resource] = await connector.listResources(fixtures.makeCtx(connection));
        const ctx = fixtures.makeCtx(connection, resource);
        for (const stream of connector.streams(resource)) {
          let cursor = null;
          let done = false;
          let chunks = 0;
          while (!done) {
            assert.ok(++chunks <= (fixtures.maxChunks ?? 50), 'sync must finish');
            const page = await connector.syncStream(ctx, { resource, stream, cursor, phase: 'backfill' });
            assert.ok(Array.isArray(page.envelopes));
            assert.equal(typeof page.done, 'boolean');
            for (const e of page.envelopes) assert.ok(ENVELOPE_TYPES.includes(e.type), `envelope type ${e.type}`);
            const again = await connector.syncStream(ctx, { resource, stream, cursor, phase: 'backfill' });
            assert.deepEqual(again.envelopes, page.envelopes, 'the same cursor returns the same chunk');
            cursor = page.cursor;
            done = page.done;
          }
        }
      });
    }

    if (connector.capabilities.webhooks) {
      it('verifies webhook signatures and rejects tampering', () => {
        const { headers, rawBody } = fixtures.validWebhook();
        assert.equal(connector.verifyWebhook({ headers, rawBody }), true);
        const tampered = Buffer.concat([rawBody, Buffer.from(' ')]);
        assert.equal(connector.verifyWebhook({ headers, rawBody: tampered }), false);
        const unsigned = Object.fromEntries(Object.entries(headers).filter(([k]) => !/signature/i.test(k)));
        assert.equal(connector.verifyWebhook({ headers: unsigned, rawBody }), false);
      });

      it('parses and handles a webhook into envelopes', async () => {
        const { headers, rawBody } = fixtures.validWebhook();
        const body = JSON.parse(rawBody.toString('utf8'));
        const parsed = connector.parseWebhook({ headers, body });
        assert.equal(typeof parsed.deliveryId, 'string');
        assert.equal(typeof parsed.eventType, 'string');
        const result = await connector.handleWebhook(fixtures.makeCtx(connection), { ...parsed, payload: body });
        assert.ok(Array.isArray(result.envelopes));
        for (const e of result.envelopes) assert.ok(ENVELOPE_TYPES.includes(e.type));
        if (result.envelopes.length) {
          assert.equal(typeof result.resourceRef?.resourceType, 'string', 'envelopes come with the resource they belong to');
          assert.equal(typeof result.resourceRef?.externalId, 'string');
        }
      });
    }

    it('throws only ProviderError for provider failures', async () => {
      if (!fixtures.failingCall) return;
      await assert.rejects(fixtures.failingCall(connector, fixtures.makeCtx(connection)), (err) => err instanceof ProviderError);
    });
  });
}
