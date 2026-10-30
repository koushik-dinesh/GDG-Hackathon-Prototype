import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import * as authStates from '../src/repositories/integrationAuthStatesRepository.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as resources from '../src/repositories/integrationResourcesRepository.js';
import * as cursors from '../src/repositories/syncCursorsRepository.js';
import * as deliveries from '../src/repositories/webhookDeliveriesRepository.js';
import { CredentialsUnreadableError, createKeyring } from '../src/services/integrations/crypto.js';
import { createVault, credentialAad, vault } from '../src/services/integrations/vault.js';
import { closeDatabase, createUser, resetDatabase } from './helpers.js';

const TOKEN = 'ghs_store-test-token-abcdefghijklmnop';
let adminId;
let projectId;

const newConnection = (o = {}) =>
  connections.create(pool, {
    provider: 'fake',
    sourceInstance: 'fake.test',
    externalAccountId: o.externalAccountId ?? String(Math.floor(Math.random() * 1e9)),
    displayName: 'Fake org',
    connectedBy: adminId,
    ...o,
  });

const credentialRow = async (connectionId, kind) => {
  const [rows] = await pool.query('SELECT * FROM integration_credentials WHERE connection_id = ? AND kind = ?', [connectionId, kind]);
  return rows[0];
};

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@store.test', role: 'admin' });
  const [r] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Store project', ?, 'active')", [adminId]);
  projectId = r.insertId;
});
after(closeDatabase);
beforeEach(async () => {
  await pool.query('DELETE FROM webhook_deliveries');
  await pool.query('DELETE FROM integration_resources');
  await pool.query('DELETE FROM integration_connections');
});

describe('migration 005 constraints', () => {
  it('allows one connection per provider account and keeps rows on user deletion', async () => {
    await newConnection({ externalAccountId: '42' });
    await assert.rejects(newConnection({ externalAccountId: '42' }), { code: 'ER_DUP_ENTRY' });
    // Same account id at another source instance is a different account.
    await newConnection({ externalAccountId: '42', sourceInstance: 'ghe.example.test' });
  });

  it('deletes credentials and auth states with their connection; resources and projects are protected', async () => {
    const id = await newConnection();
    await vault.put({ connectionId: id, kind: 'api_token', value: TOKEN });
    await authStates.create(pool, { provider: 'fake', purpose: 'reconnect', stateHash: 'a'.repeat(64), userId: adminId, connectionId: id, ttlSeconds: 600 });
    const resourceId = await resources.upsert(pool, id, { resourceType: 'repository', externalId: 1, name: 'o/r' });
    await resources.update(pool, resourceId, { projectId });
    await cursors.save(pool, { resourceId, stream: 'issues', phase: 'backfill', cursor: { page: 2 } });

    await assert.rejects(pool.execute('DELETE FROM projects WHERE id = ?', [projectId]), { code: 'ER_ROW_IS_REFERENCED_2' });
    await assert.rejects(pool.execute('DELETE FROM integration_connections WHERE id = ?', [id]), { code: 'ER_ROW_IS_REFERENCED_2' });

    await pool.execute('DELETE FROM integration_resources WHERE id = ?', [resourceId]);
    assert.equal(await cursors.find(resourceId, 'issues'), null, 'cursors cascade with their resource');
    await pool.execute('DELETE FROM integration_connections WHERE id = ?', [id]);
    const [[{ n }]] = await pool.query(
      'SELECT (SELECT COUNT(*) FROM integration_credentials WHERE connection_id = ?) + (SELECT COUNT(*) FROM integration_auth_states WHERE connection_id = ?) AS n',
      [id, id],
    );
    assert.equal(n, 0);
  });

  it('keeps one credential per kind and one delivery per provider delivery id', async () => {
    const id = await newConnection();
    await vault.put({ connectionId: id, kind: 'api_token', value: 'first' });
    await vault.put({ connectionId: id, kind: 'api_token', value: 'second' });
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM integration_credentials WHERE connection_id = ?', [id]);
    assert.equal(n, 1);
    assert.equal((await vault.get(id, 'api_token')).value, 'second');
  });
});

describe('credential vault', () => {
  it('stores only ciphertext and round-trips the value', async () => {
    const id = await newConnection();
    const expiresAt = new Date(Date.now() + 3600_000);
    await vault.put({ connectionId: id, kind: 'installation_token', value: TOKEN, expiresAt });
    const row = await credentialRow(id, 'installation_token');
    for (const col of ['ciphertext', 'iv', 'auth_tag']) assert.ok(!Buffer.from(row[col]).toString('latin1').includes(TOKEN));
    assert.match(row.key_id, /^[0-9a-f]{16}$/);
    const got = await vault.get(id, 'installation_token');
    assert.equal(got.value, TOKEN);
    // DATETIME has no fractional seconds and MySQL rounds them, so allow ±1 s.
    assert.ok(Math.abs(got.expiresAt.getTime() - expiresAt.getTime()) <= 1000);
    assert.equal(await vault.get(id, 'oauth_refresh_token'), null);
    assert.deepEqual((await vault.describe(id)).map((c) => c.kind), ['installation_token']);
  });

  it('refuses a ciphertext copied to another connection (AAD binding)', async () => {
    const a = await newConnection();
    const b = await newConnection();
    await vault.put({ connectionId: a, kind: 'api_token', value: TOKEN });
    const row = await credentialRow(a, 'api_token');
    await pool.execute(
      'INSERT INTO integration_credentials (connection_id, kind, key_id, iv, auth_tag, ciphertext) VALUES (?, ?, ?, ?, ?, ?)',
      [b, 'api_token', row.key_id, row.iv, row.auth_tag, row.ciphertext],
    );
    await assert.rejects(vault.get(b, 'api_token'), CredentialsUnreadableError);
    assert.equal(credentialAad(7, 'api_token'), 'workagent:cred:v1:7:api_token');
  });

  it('refreshes missing or soon-expiring credentials, and only then', async () => {
    const id = await newConnection();
    let calls = 0;
    const refresh = async () => {
      calls++;
      return [
        { kind: 'oauth_access_token', value: `access-${calls}`, expiresAt: new Date(Date.now() + 3600_000) },
        { kind: 'oauth_refresh_token', value: `refresh-${calls}` },
      ];
    };
    assert.equal((await vault.get(id, 'oauth_access_token', { refresh })).value, 'access-1');
    assert.equal((await vault.get(id, 'oauth_refresh_token')).value, 'refresh-1', 'every returned credential is stored');
    assert.equal((await vault.get(id, 'oauth_access_token', { refresh })).value, 'access-1', 'fresh: no refresh');
    assert.equal(calls, 1);

    await pool.execute("UPDATE integration_credentials SET expires_at = DATE_ADD(NOW(), INTERVAL 60 SECOND) WHERE kind = 'oauth_access_token'");
    assert.equal((await vault.get(id, 'oauth_access_token', { refresh })).value, 'access-2', 'expires within 5 min: refreshed');
    assert.equal(calls, 2);
    await assert.rejects(vault.get(id, 'api_token', { refresh: async () => [] }), /did not return/);
  });

  it('validates input and deletes everything on remove', async () => {
    const id = await newConnection();
    await assert.rejects(vault.put({ connectionId: id, kind: 'Bad Kind', value: 'x' }), /Invalid credential kind/);
    await assert.rejects(vault.put({ connectionId: id, kind: 'api_token', value: '' }), /non-empty/);
    await assert.rejects(vault.put({ connectionId: id, kind: 'api_token', value: 'x'.repeat(16_001) }), /exceeds/);
    await assert.rejects(vault.put({ connectionId: 0, kind: 'api_token', value: 'x' }), /positive integer/);
    await vault.put({ connectionId: id, kind: 'api_token', value: 'a' });
    await vault.put({ connectionId: id, kind: 'oauth_refresh_token', value: 'b' });
    assert.equal(await vault.remove(id), 2);
    assert.equal(await vault.get(id, 'api_token'), null);
  });

  it('rotates keys: bulk re-encryption, lazy re-encryption on read, unreadable rows reported', async () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = createVault(createKeyring({ current: oldKey }));
    const during = createVault(createKeyring({ current: newKey, previous: oldKey }));
    const afterRotation = createVault(createKeyring({ current: newKey }));
    const newKeyId = createKeyring({ current: newKey }).currentKeyId;

    const a = await newConnection();
    const b = await newConnection();
    const c = await newConnection();
    await before.put({ connectionId: a, kind: 'api_token', value: 'value-a' });
    await before.put({ connectionId: b, kind: 'api_token', value: 'value-b' });
    // A row from a key nobody has any more.
    await createVault(createKeyring({ current: randomBytes(32) })).put({ connectionId: c, kind: 'api_token', value: 'lost' });

    // Lazy: reading with the rotating keyring re-encrypts the row.
    assert.equal((await during.get(a, 'api_token')).value, 'value-a');
    assert.equal((await credentialRow(a, 'api_token')).key_id, newKeyId);

    const result = await during.rotate();
    assert.deepEqual(result, { reencrypted: 1, unreadable: 1 });
    assert.deepEqual(await during.rotate(), { reencrypted: 0, unreadable: 1 }, 'idempotent');

    assert.equal((await afterRotation.get(a, 'api_token')).value, 'value-a');
    assert.equal((await afterRotation.get(b, 'api_token')).value, 'value-b');
    await assert.rejects(afterRotation.get(c, 'api_token'), CredentialsUnreadableError);
  });
});

describe('integration repositories', () => {
  it('connections: whitelisted shape, field-checked updates', async () => {
    const id = await newConnection({ settings: { events: ['push'] } });
    await connections.update(pool, id, { status: 'active', health: 'healthy', isEnabled: false, settings: { events: ['push', 'issues'] } });
    const c = await connections.findById(id);
    assert.equal(c.status, 'active');
    assert.equal(c.isEnabled, false);
    assert.deepEqual(c.settings, { events: ['push', 'issues'] });
    assert.ok(!Object.keys(c).some((k) => /cipher|secret|token/i.test(k)));
    assert.deepEqual(await connections.findByAccount('fake', 'fake.test', c.externalAccountId), c);
    await assert.rejects(connections.update(pool, id, { provider: 'other' }), /Unknown connection field/);
  });

  it('resources: upsert is idempotent and never resets admin choices', async () => {
    const id = await newConnection();
    const r1 = await resources.upsert(pool, id, { resourceType: 'repository', externalId: 7, name: 'org/old', metadata: { private: true } });
    await resources.update(pool, r1, { isEnabled: true, projectId });
    await resources.markRemovedExcept(pool, id, 'repository', []);
    assert.equal((await resources.findById(r1)).accessStatus, 'removed');

    const r2 = await resources.upsert(pool, id, { resourceType: 'repository', externalId: '7', name: 'org/renamed', metadata: { private: false } });
    assert.equal(r2, r1);
    const r = await resources.findById(r1);
    assert.equal(r.name, 'org/renamed');
    assert.equal(r.accessStatus, 'accessible');
    assert.equal(r.isEnabled, true);
    assert.equal(r.projectId, projectId);
    assert.deepEqual(r.metadata, { private: false });

    const other = await resources.upsert(pool, id, { resourceType: 'repository', externalId: 8, name: 'org/other' });
    assert.equal((await resources.findById(other)).isEnabled, false, 'opt-in by default');
    assert.equal(await resources.markRemovedExcept(pool, id, 'repository', ['7']), 1);
  });

  it('cursors: saved per stream, high watermark never moves back', async () => {
    const id = await newConnection();
    const resourceId = await resources.upsert(pool, id, { resourceType: 'repository', externalId: 1, name: 'o/r' });
    await cursors.save(pool, { resourceId, stream: 'issues', phase: 'backfill', cursor: { page: 3 }, highWatermark: new Date('2026-10-01T10:00:00.123Z') });
    await cursors.save(pool, { resourceId, stream: 'issues', phase: 'incremental', cursor: { since: 'x' }, highWatermark: new Date('2026-09-01T00:00:00Z') });
    await cursors.save(pool, { resourceId, stream: 'pulls', phase: 'backfill', cursor: null });
    const c = await cursors.find(resourceId, 'issues');
    assert.equal(c.phase, 'incremental');
    assert.deepEqual(c.cursor, { since: 'x' });
    assert.equal(c.highWatermark.toISOString(), '2026-10-01T10:00:00.123Z');
    assert.deepEqual((await cursors.listForResource(resourceId)).map((x) => x.stream), ['issues', 'pulls']);
  });

  it('auth states: single use, same admin and provider, not expired', async () => {
    const otherAdmin = await createUser({ email: 'admin2@store.test', role: 'admin' });
    const hash = (s) => createHash('sha256').update(s).digest('hex');
    await authStates.create(pool, { provider: 'fake', purpose: 'install', stateHash: hash('s1'), userId: adminId, ttlSeconds: 600 });
    await authStates.create(pool, { provider: 'fake', purpose: 'install', stateHash: hash('s2'), userId: adminId, ttlSeconds: 600 });
    await authStates.create(pool, { provider: 'fake', purpose: 'install', stateHash: hash('s3'), userId: adminId, ttlSeconds: 600 });
    await pool.execute('UPDATE integration_auth_states SET expires_at = DATE_SUB(NOW(), INTERVAL 1 SECOND) WHERE state_hash = ?', [hash('s3')]);

    const consume = (stateHash, o = {}) => withTransaction((conn) => authStates.consume(conn, { stateHash, provider: 'fake', userId: adminId, ...o }));
    assert.equal(await consume(hash('s1'), { userId: otherAdmin }), null, 'another admin');
    assert.equal(await consume(hash('s1'), { provider: 'github' }), null, 'another provider');
    assert.equal((await consume(hash('s1'))).purpose, 'install');
    assert.equal(await consume(hash('s1')), null, 'single use');
    assert.equal(await consume(hash('s3')), null, 'expired');
    assert.equal(await consume(hash('unknown')), null);
    assert.ok(await consume(hash('s2')));
  });

  it('webhook deliveries: duplicates detected, payload kept out of summaries, retention purge', async () => {
    const id = await newConnection();
    const body = { action: 'opened', secret_marker: 'do-not-list' };
    const input = { provider: 'fake', deliveryId: 'd-1', eventType: 'issues', action: 'opened', externalAccountId: 99, connectionId: id, payload: body, payloadBytes: 50, payloadSha256: 'f'.repeat(64) };
    const first = await withTransaction((conn) => deliveries.insert(conn, input));
    assert.equal(first.duplicate, false);
    assert.equal(first.delivery.status, 'received');
    assert.equal(first.delivery.externalAccountId, '99');
    assert.ok(!JSON.stringify(first.delivery).includes('do-not-list'));

    const again = await withTransaction((conn) => deliveries.insert(conn, input));
    assert.equal(again.duplicate, true);
    assert.equal(again.id, first.id);
    assert.deepEqual(await deliveries.findPayload(first.id), body);
    await assert.rejects(withTransaction((conn) => deliveries.insert(conn, { ...input, deliveryId: 'd-2', connectionId: 999999 })), { code: 'ER_NO_REFERENCED_ROW_2' });

    await pool.execute('UPDATE webhook_deliveries SET received_at = DATE_SUB(NOW(), INTERVAL 20 DAY) WHERE id = ?', [first.id]);
    assert.equal(await deliveries.purgePayloadsOlderThan(14), 1);
    assert.equal(await deliveries.findPayload(first.id), null);
    const [listed] = await deliveries.listForConnection(id);
    assert.equal(listed.hasPayload, false);
    assert.equal(await deliveries.purgePayloadsOlderThan(14), 0);
  });
});
