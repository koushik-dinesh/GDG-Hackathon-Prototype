// Phase 3A step 5: work-record schema and ingest (idempotency, ordering, identities, links, projects).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { z } from 'zod';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import * as activities from '../src/repositories/activitiesRepository.js';
import * as identities from '../src/repositories/externalIdentitiesRepository.js';
import * as records from '../src/repositories/externalRecordsRepository.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as resources from '../src/repositories/integrationResourcesRepository.js';
import * as linksRepo from '../src/repositories/recordLinksRepository.js';
import { connectionService } from '../src/services/integrations/connections.js';
import { ingest } from '../src/services/integrations/ingest.js';
import { createLink } from '../src/services/integrations/links.js';
import fake, { resetFakeService } from '../src/services/integrations/providers/fake/index.js';
import { closeDatabase, createUser, resetDatabase } from './helpers.js';

const connector = { id: fake.id, sourceInstance: fake.sourceInstance };
const ids = {};
let connection;
let resource;

const run = (envelopes, o = {}) =>
  withTransaction((conn) => ingest(conn, { connector, connection, resource, envelopes, origin: 'sync', ...o }));

const rec = (o = {}) => ({
  type: 'record',
  recordType: 'issue',
  externalId: '1',
  externalKey: 'org/repo#1',
  url: 'https://fake.test/org/repo/issues/1',
  title: 'Payment API',
  state: 'open',
  statusCategory: 'todo',
  authorRef: { externalUserId: 'u1' },
  sourceUpdatedAt: '2026-10-01T10:00:00.000Z',
  ...o,
});
const act = (o = {}) => ({
  type: 'activity',
  dedupeKey: 'fake.test:issue:1:opened',
  activityType: 'created',
  recordRef: { recordType: 'issue', externalId: '1' },
  actorRef: { externalUserId: 'u1' },
  occurredAt: '2026-10-01T10:00:00.000Z',
  summary: 'u1 opened org/repo#1',
  ...o,
});
const find = (externalId, recordType = 'issue') => records.findBySource(pool, { ...connector, provider: connector.id, recordType, externalId });
const count = async (table) => (await pool.query(`SELECT COUNT(*) AS n FROM ${table}`))[0][0].n;

before(async () => {
  await resetDatabase();
  ids.admin = await createUser({ email: 'admin@ingest.test', role: 'admin', fullName: 'Ingest Admin' });
  ids.ana = await createUser({ email: 'ana@ingest.test', fullName: 'Ana Garcia' });
  ids.raj = await createUser({ email: 'raj@ingest.test', fullName: 'Raj Patel' });
  ids.sam1 = await createUser({ email: 'sam1@ingest.test', fullName: 'Sam One' });
  ids.sam2 = await createUser({ email: 'sam2@ingest.test', fullName: 'Sam Two' });
  await pool.query("INSERT INTO user_aliases (user_id, alias, normalized_alias) VALUES (?, 'rajp', 'rajp'), (?, 'sam', 'sam'), (?, 'sam', 'sam')", [ids.raj, ids.sam1, ids.sam2]);
  for (const name of ['Payments', 'Mobile']) {
    const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES (?, ?, 'active')", [name, ids.admin]);
    ids[name] = p.insertId;
  }
});
after(closeDatabase);
beforeEach(async () => {
  resetFakeService();
  for (const t of ['record_links', 'activities', 'external_records', 'external_identities', 'integration_resources', 'integration_connections']) await pool.query(`DELETE FROM ${t}`);
  const id = await connections.create(pool, { provider: 'fake', sourceInstance: 'fake.test', externalAccountId: 'fake-org', displayName: 'Fake', status: 'active' });
  connection = await connections.findById(id);
  const rid = await resources.upsert(pool, id, { resourceType: 'repository', externalId: '101', name: 'fake-org/api' });
  await resources.update(pool, rid, { projectId: ids.Payments });
  resource = await resources.findById(rid);
});

describe('records', () => {
  it('ingests a connector page and is idempotent when repeated', async () => {
    const page = await fake.syncStream({}, { resource: { externalId: '101', name: 'fake-org/api' }, stream: 'items', cursor: null });
    const first = await run(page.envelopes);
    assert.deepEqual(first.records, { inserted: 2, updated: 0, unchanged: 0, stale: 0 });
    assert.deepEqual(first.activities, { inserted: 2, duplicate: 0, skipped: 0 });
    assert.equal(first.identities.inserted, 2);

    const r = await find('1001');
    assert.equal(r.title, 'Payment API');
    assert.equal(r.externalKey, 'fake-org/api#1');
    assert.equal(r.statusCategory, 'todo');
    assert.equal(r.projectId, ids.Payments, 'takes the resource project');
    assert.equal(r.resourceId, resource.id);
    assert.equal(r.connectionId, connection.id);
    const author = await identities.findById(r.authorIdentityId);
    assert.equal(author.login, 'ana');

    const [[before]] = await pool.query('SELECT updated_at, last_synced_at FROM external_records WHERE id = ?', [r.id]);
    const again = await run(page.envelopes);
    assert.deepEqual(again.records, { inserted: 0, updated: 0, unchanged: 2, stale: 0 });
    assert.deepEqual(again.activities, { inserted: 0, duplicate: 2, skipped: 0 });
    const [[afterRow]] = await pool.query('SELECT updated_at, last_synced_at FROM external_records WHERE id = ?', [r.id]);
    assert.deepEqual(afterRow, before, 'nothing written for unchanged content');
    assert.equal(await count('external_records'), 2);
    assert.equal(await count('activities'), 2);
  });

  it('applies newer updates, skips older ones (out-of-order events)', async () => {
    await run([rec()]);
    const newer = await run([rec({ title: 'Payment API v2', state: 'closed', statusCategory: 'done', sourceUpdatedAt: '2026-10-03T10:00:00.000Z' })]);
    assert.equal(newer.records.updated, 1);
    const older = await run([rec({ title: 'Payment API (old)', sourceUpdatedAt: '2026-10-02T10:00:00.000Z' })]);
    assert.equal(older.records.stale, 1);
    const r = await find('1');
    assert.equal(r.title, 'Payment API v2');
    assert.equal(r.statusCategory, 'done');
    assert.equal(r.sourceUpdatedAt.toISOString(), '2026-10-03T10:00:00.000Z');

    const sameTime = await run([rec({ title: 'Payment API v2.1', state: 'closed', statusCategory: 'done', sourceUpdatedAt: '2026-10-03T10:00:00.000Z' })]);
    assert.equal(sameTime.records.updated, 1, 'equal timestamps with different content are applied');
  });

  it('marks deletions, truncates long bodies and resolves parents', async () => {
    const long = 'x'.repeat(60_010);
    await run([
      rec({ body: long }),
      rec({ recordType: 'review', externalId: 'r9', externalKey: null, url: null, title: 'Approved', parentRef: { recordType: 'issue', externalId: '1' } }),
      rec({ recordType: 'review', externalId: 'r10', parentRef: { recordType: 'issue', externalId: 'missing' } }),
    ]);
    const parent = await find('1');
    assert.equal(parent.body.length, 60_000);
    assert.equal(parent.metadata.truncated, true);
    assert.equal((await find('r9', 'review')).parentRecordId, parent.id);
    assert.equal((await find('r10', 'review')).parentRecordId, null);

    await run([rec({ deleted: true, sourceUpdatedAt: '2026-10-05T00:00:00.000Z' })]);
    assert.equal((await find('1')).sourceDeletedAt.toISOString(), '2026-10-05T00:00:00.000Z');
  });

  it('updates the same record when it arrives through a new connection (reinstall)', async () => {
    await run([rec()]);
    const id2 = await connections.create(pool, { provider: 'fake', sourceInstance: 'fake.test', externalAccountId: 'fake-org-2', displayName: 'Fake 2', status: 'active' });
    const result = await withTransaction((conn) => ingest(conn, { connector, connection: { id: id2 }, resource: null, envelopes: [rec()], origin: 'sync' }));
    assert.equal(result.records.updated, 1);
    assert.equal(await count('external_records'), 1);
    const r = await find('1');
    assert.equal(r.connectionId, id2);
    assert.equal(r.resourceId, resource.id, 'keeps the resource when the new source gives none');
    assert.equal(r.projectId, ids.Payments);
  });

  it('rejects unsafe or malformed envelopes before writing anything', async () => {
    const bad = [
      [rec({ url: 'javascript:alert(1)' }), /http/],
      [rec({ sourceUpdatedAt: 'yesterday' }), /Invalid date/],
      [{ type: 'mystery' }, /type/],
      [rec({ recordType: 'Bad Type' }), /recordType/],
      [act({ dedupeKey: '' }), /dedupeKey/],
    ];
    for (const [env, pattern] of bad) {
      await assert.rejects(run([rec({ externalId: 'fine' }), env]), (err) => err instanceof z.ZodError && pattern.test(JSON.stringify(err.issues)));
    }
    assert.equal(await count('external_records'), 0, 'the whole batch is rejected');
    const titled = await run([rec({ title: 't'.repeat(600) })]);
    assert.equal(titled.records.inserted, 1);
    assert.equal((await find('1')).title.length, 500);
  });
});

describe('activities', () => {
  it('are stored once even when webhook and sync both report them', async () => {
    await run([rec(), act()], { origin: 'webhook' });
    const fromSync = await run([rec(), act()]);
    assert.equal(fromSync.activities.duplicate, 1);
    const [a] = await activities.listForRecord((await find('1')).id);
    assert.equal(a.origin, 'webhook');
    assert.equal(a.projectId, ids.Payments);
    assert.equal(a.occurredAt.toISOString(), '2026-10-01T10:00:00.000Z');
  });

  it('skip unknown records and keep unknown actors as bare identities', async () => {
    const res = await run([rec(), act({ recordRef: { recordType: 'issue', externalId: 'nope' }, dedupeKey: 'k1' }), act({ dedupeKey: 'k2', actorRef: { externalUserId: 'ghost' } })]);
    assert.equal(res.activities.skipped, 1);
    assert.equal(res.activities.inserted, 1);
    const ghost = await identities.findBySource(pool, { provider: 'fake', sourceInstance: 'fake.test', externalUserId: 'ghost' });
    assert.equal(ghost.login, null);
  });

  it('must have a subject (database check)', async () => {
    await assert.rejects(
      pool.execute("INSERT INTO activities (dedupe_key, provider, activity_type, occurred_at, summary, origin) VALUES ('x', 'fake', 'updated', NOW(), 's', 'sync')"),
      { code: 'ER_CHECK_CONSTRAINT_VIOLATED' },
    );
  });
});

describe('identities', () => {
  const ident = (o) => ({ type: 'identity', ...o });

  it('match automatically only by exact, provider-verified email (never by name or alias)', async () => {
    const res = await run([
      ident({ externalUserId: 'e1', login: 'ana-g', email: 'ANA@ingest.test' }),
      ident({ externalUserId: 'e2', login: 'RajP' }),
      ident({ externalUserId: 'e3', login: 'sam' }),
      ident({ externalUserId: 'e4', login: 'unknown-person' }),
    ]);
    assert.equal(res.identities.matched, 1);
    const get = (externalUserId) => identities.findBySource(pool, { provider: 'fake', sourceInstance: 'fake.test', externalUserId });
    assert.deepEqual([(await get('e1')).userId, (await get('e1')).matchMethod], [ids.ana, 'email']);
    assert.equal((await get('e2')).userId, null, 'a login equal to an alias is not enough (name-only matching is unsafe)');
    assert.equal((await get('e3')).userId, null);
    assert.equal((await get('e4')).userId, null);
  });

  it('never override a person’s match and keep profile fields the provider omits', async () => {
    await run([ident({ externalUserId: 'e1', login: 'ana-g', displayName: 'Ana G' })]);
    const e1 = await identities.findBySource(pool, { provider: 'fake', sourceInstance: 'fake.test', externalUserId: 'e1' });
    await pool.execute("UPDATE external_identities SET user_id = ?, match_method = 'manual' WHERE id = ?", [ids.raj, e1.id]);
    await run([ident({ externalUserId: 'e1', login: 'ana-renamed', email: 'ana@ingest.test' })]);
    const after = await identities.findById(e1.id);
    assert.deepEqual([after.userId, after.matchMethod], [ids.raj, 'manual']);
    assert.equal(after.login, 'ana-renamed');
    assert.equal(after.displayName, 'Ana G');
  });
});

describe('links', () => {
  it('stores provider links once, canonicalizing symmetric types', async () => {
    const res = await run([
      rec(),
      rec({ externalId: '2', externalKey: 'org/repo#2' }),
      { type: 'link', fromRef: { recordType: 'issue', externalId: '1' }, toRef: { recordType: 'issue', externalId: '2' }, linkType: 'fixes' },
      { type: 'link', fromRef: { recordType: 'issue', externalId: '2' }, toRef: { recordType: 'issue', externalId: '1' }, linkType: 'duplicates' },
      { type: 'link', fromRef: { recordType: 'issue', externalId: '1' }, toRef: { recordType: 'issue', externalId: 'zzz' }, linkType: 'references' },
    ]);
    assert.deepEqual(res.links, { inserted: 2, duplicate: 0, skipped: 1 });
    const again = await run([
      { type: 'link', fromRef: { recordType: 'issue', externalId: '1' }, toRef: { recordType: 'issue', externalId: '2' }, linkType: 'duplicates' },
    ]);
    assert.equal(again.links.duplicate, 1, 'reverse of a symmetric link is the same link');
    const [one, two] = [await find('1'), await find('2')];
    const dup = (await linksRepo.listFor({ type: 'external_record', id: one.id })).find((l) => l.linkType === 'duplicates');
    assert.deepEqual([dup.from.id, dup.to.id, dup.origin, dup.status, dup.confidence], [one.id, two.id, 'source', 'confirmed', 1]);
  });

  it('validate endpoints, refuse self links, and leave inferred links as suggestions', async () => {
    await run([rec()]);
    const r = await find('1');
    const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, platform, native_meeting_id, created_by) VALUES ('Sync', 'https://meet.google.com/abc-defg-hij', 'google_meet', 'abc-defg-hij', ?)", [ids.admin]);
    const link = await withTransaction((conn) =>
      createLink(conn, { from: { type: 'external_record', id: r.id }, to: { type: 'meeting', id: m.insertId }, linkType: 'discussed_in', origin: 'ai', confidence: 0.72 }),
    );
    const stored = await linksRepo.findById(link.id);
    assert.deepEqual([stored.status, stored.confidence], ['suggested', 0.72]);
    await assert.rejects(withTransaction((conn) => createLink(conn, { from: { type: 'external_record', id: r.id }, to: { type: 'meeting', id: 999999 }, linkType: 'related', origin: 'manual' })), /Invalid link/);
    await assert.rejects(withTransaction((conn) => createLink(conn, { from: { type: 'external_record', id: r.id }, to: { type: 'external_record', id: r.id }, linkType: 'related', origin: 'manual' })), /itself/);
    assert.equal(await linksRepo.deleteForEndpoints(pool, 'meeting', [m.insertId]), 1);
  });
});

describe('project mapping', () => {
  it('moves records that follow the resource, with their activities; hand-set records stay', async () => {
    await run([rec(), act(), rec({ externalId: '2', externalKey: 'org/repo#2' }), act({ dedupeKey: 'k2', recordRef: { recordType: 'issue', externalId: '2' } })]);
    await pool.execute("UPDATE external_records SET project_locked = TRUE WHERE external_id = '2'");

    await connectionService.updateResource(connection.id, resource.id, { projectId: ids.Mobile }, { actor: { id: ids.admin }, ip: null });
    const [moved, locked] = [await find('1'), await find('2')];
    assert.equal(moved.projectId, ids.Mobile);
    assert.equal(locked.projectId, ids.Payments);
    assert.equal((await activities.listForRecord(moved.id))[0].projectId, ids.Mobile);
    assert.equal((await activities.listForRecord(locked.id))[0].projectId, ids.Payments);
    const [[audit]] = await pool.query("SELECT after_json FROM audit_logs WHERE action = 'integration.resource_updated' ORDER BY id DESC LIMIT 1");
    const afterJson = typeof audit.after_json === 'string' ? JSON.parse(audit.after_json) : audit.after_json;
    assert.deepEqual([afterJson.movedRecords, afterJson.movedActivities], [1, 1]);

    // New data keeps following the resource mapping; hand-set records keep their project.
    resource = await resources.findById(resource.id);
    await run([rec({ title: 'changed', sourceUpdatedAt: '2026-10-09T00:00:00.000Z' }), rec({ externalId: '2', externalKey: 'org/repo#2', title: 'changed', sourceUpdatedAt: '2026-10-09T00:00:00.000Z' })]);
    assert.equal((await find('1')).projectId, ids.Mobile);
    assert.equal((await find('2')).projectId, ids.Payments);
  });
});
