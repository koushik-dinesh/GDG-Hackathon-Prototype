// Phase 3A step 8: read APIs for records, activities, links and identities (permissions, pagination).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as resources from '../src/repositories/integrationResourcesRepository.js';
import { connectionService } from '../src/services/integrations/connections.js';
import { ingest } from '../src/services/integrations/ingest.js';
import { createLink } from '../src/services/integrations/links.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const connector = { id: 'fake', sourceInstance: 'fake.test' };

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookies[who]).send(body),
});

const rec = (externalId, o = {}) => ({
  type: 'record',
  recordType: 'issue',
  externalId,
  externalKey: `org/api#${externalId}`,
  url: `https://fake.test/org/api/issues/${externalId}`,
  title: `Issue ${externalId}`,
  body: `Body of ${externalId}`,
  state: 'open',
  statusCategory: 'todo',
  authorRef: { externalUserId: 'u1' },
  ...o,
});
const act = (externalId, occurredAt) => ({
  type: 'activity',
  dedupeKey: `fake.test:issue:${externalId}:created`,
  activityType: 'created',
  recordRef: { recordType: 'issue', externalId },
  actorRef: { externalUserId: 'u1' },
  occurredAt,
  summary: `ana opened #${externalId}`,
});
const recordId = async (externalId) => (await pool.query('SELECT id FROM external_records WHERE external_id = ?', [externalId]))[0][0].id;

before(async () => {
  await resetDatabase();
  for (const [key, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['member', 'employee'],
    ['outsider', 'employee'],
  ]) {
    ids[key] = await createUser({ email: `${key}@read.test`, role, fullName: `Read ${key}` });
    cookies[key] = await loginCookie(app, `${key}@read.test`);
  }
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.manager]);
  ids.P = p.insertId;
  const [q] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Mobile', ?, 'active')", [ids.admin]);
  ids.Q = q.insertId;
  await pool.execute('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)', [ids.P, ids.member]);

  ids.connection = await connections.create(pool, { provider: 'fake', sourceInstance: 'fake.test', externalAccountId: 'org', displayName: 'Org', status: 'active' });
  ids.resP = await resources.upsert(pool, ids.connection, { resourceType: 'repository', externalId: '1', name: 'org/api' });
  await resources.update(pool, ids.resP, { isEnabled: true, projectId: ids.P });
  ids.resNone = await resources.upsert(pool, ids.connection, { resourceType: 'repository', externalId: '2', name: 'org/secret' });
  await resources.update(pool, ids.resNone, { isEnabled: true });

  const connection = { id: ids.connection };
  await withTransaction(async (conn) => {
    await ingest(conn, {
      connector,
      connection,
      resource: await resources.findById(ids.resP, { conn }),
      origin: 'sync',
      envelopes: [
        { type: 'identity', externalUserId: 'u1', login: 'ana', displayName: 'Ana Garcia' },
        rec('1', { sourceUpdatedAt: '2026-10-01T10:00:00Z' }),
        rec('2', { sourceUpdatedAt: '2026-10-02T10:00:00Z', title: 'Refund 100% flow', statusCategory: 'done', state: 'closed' }),
        rec('3', { sourceUpdatedAt: '2026-10-03T10:00:00Z', recordType: 'pull_request', externalKey: 'org/api#pr3' }),
        act('1', '2026-10-01T10:00:00Z'),
        act('2', '2026-10-02T10:00:00Z'),
      ],
    });
    await ingest(conn, {
      connector,
      connection,
      resource: await resources.findById(ids.resNone, { conn }),
      origin: 'sync',
      envelopes: [rec('9', { sourceUpdatedAt: '2026-10-04T10:00:00Z', title: 'Unmapped secret' }), act('9', '2026-10-04T10:00:00Z')],
    });
  });
});
after(closeDatabase);

describe('records', () => {
  it('lists a project’s records for people who can see it, newest first, without bodies', async () => {
    for (const who of ['member', 'manager', 'admin']) {
      const res = await as(who).get(`/api/v1/external-records?projectId=${ids.P}`);
      assert.equal(res.status, 200, who);
      assert.deepEqual(res.body.records.map((r) => r.externalKey), ['org/api#pr3', 'org/api#2', 'org/api#1']);
      assert.equal(res.body.records[0].author.login, 'ana');
      assert.ok(!('body' in res.body.records[0]));
      assert.equal(res.body.next, null);
    }
    assert.equal((await as('outsider').get(`/api/v1/external-records?projectId=${ids.P}`)).status, 404);
    assert.equal((await as('member').get('/api/v1/external-records')).status, 400, 'non-admins must choose a project');
    assert.equal((await as('member').get('/api/v1/external-records?projectId=999999')).status, 404);
  });

  it('lets admins see everything, including records with no project', async () => {
    assert.equal((await as('admin').get('/api/v1/external-records')).body.records.length, 4);
    const unassigned = await as('admin').get('/api/v1/external-records?unassigned=true');
    assert.deepEqual(unassigned.body.records.map((r) => r.title), ['Unmapped secret']);
    assert.equal((await as('member').get('/api/v1/external-records?unassigned=true')).status, 400);
  });

  it('paginates with an opaque keyset cursor and filters', async () => {
    const first = await as('member').get(`/api/v1/external-records?projectId=${ids.P}&limit=2`);
    assert.equal(first.body.records.length, 2);
    assert.ok(first.body.next);
    const second = await as('member').get(`/api/v1/external-records?projectId=${ids.P}&limit=2&before=${first.body.next}`);
    assert.deepEqual(second.body.records.map((r) => r.externalKey), ['org/api#1']);
    assert.equal(second.body.next, null);
    assert.equal((await as('member').get(`/api/v1/external-records?projectId=${ids.P}&before=nonsense`)).status, 400);

    const filter = async (qs) => (await as('member').get(`/api/v1/external-records?projectId=${ids.P}&${qs}`)).body.records.map((r) => r.externalKey);
    assert.deepEqual(await filter('recordType=pull_request'), ['org/api#pr3']);
    assert.deepEqual(await filter('statusCategory=done'), ['org/api#2']);
    assert.deepEqual(await filter(`q=${encodeURIComponent('100%')}`), ['org/api#2'], '% is matched literally');
    assert.deepEqual(await filter('q=pr3'), ['org/api#pr3'], 'searches the external key too');
  });

  it('shows detail (body, timeline) only to people who can see the record', async () => {
    const id = await recordId('1');
    const res = await as('member').get(`/api/v1/external-records/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.record.body, 'Body of 1');
    assert.deepEqual(res.body.activities.map((a) => [a.summary, a.actor.login]), [['ana opened #1', 'ana']]);
    assert.equal((await as('outsider').get(`/api/v1/external-records/${id}`)).status, 404);
    const secret = await recordId('9');
    assert.equal((await as('member').get(`/api/v1/external-records/${secret}`)).status, 404, 'unmapped records are admin-only');
    assert.equal((await as('admin').get(`/api/v1/external-records/${secret}`)).status, 200);
  });
});

describe('activities', () => {
  it('is a per-project timeline with the same visibility', async () => {
    const res = await as('member').get(`/api/v1/activities?projectId=${ids.P}&limit=1`);
    assert.deepEqual(res.body.activities.map((a) => a.summary), ['ana opened #2']);
    assert.equal(res.body.activities[0].record.externalKey, 'org/api#2');
    const more = await as('member').get(`/api/v1/activities?projectId=${ids.P}&limit=1&before=${res.body.next}`);
    assert.deepEqual(more.body.activities.map((a) => a.summary), ['ana opened #1']);
    assert.equal(more.body.next, null);
    assert.equal((await as('outsider').get(`/api/v1/activities?projectId=${ids.P}`)).status, 404);
    assert.equal((await as('admin').get('/api/v1/activities')).body.activities.length, 3);
  });
});

describe('links', () => {
  it('admins create (idempotently) and review links; others cannot', async () => {
    const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, platform, native_meeting_id, created_by) VALUES ('Payments sync', 'https://meet.google.com/aaa-bbbb-ccc', 'google_meet', 'aaa-bbbb-ccc', ?)", [ids.admin]);
    const body = { from: { type: 'external_record', id: await recordId('1') }, to: { type: 'meeting', id: m.insertId }, linkType: 'discussed_in' };
    const created = await as('admin').post('/api/v1/record-links', body);
    assert.equal(created.status, 201);
    assert.deepEqual([created.body.link.origin, created.body.link.status, created.body.link.createdBy], ['manual', 'confirmed', ids.admin]);
    assert.equal((await as('admin').post('/api/v1/record-links', body)).status, 200, 'same link again');
    assert.equal((await as('manager').post('/api/v1/record-links', body)).status, 403);
    assert.equal((await as('admin').post('/api/v1/record-links', { ...body, to: { type: 'meeting', id: 999999 } })).status, 400);
    assert.equal((await as('admin').post('/api/v1/record-links', { ...body, to: { type: 'project', id: ids.P } })).status, 400, 'projects are not link endpoints');

    const reviewed = await as('admin').patch(`/api/v1/record-links/${created.body.link.id}`, { status: 'rejected' });
    assert.deepEqual([reviewed.body.link.status, reviewed.body.link.reviewedBy], ['rejected', ids.admin]);
    assert.equal((await as('member').patch(`/api/v1/record-links/${created.body.link.id}`, { status: 'confirmed' })).status, 403);
  });

  it('non-admins only see confirmed links to records they can see', async () => {
    const [one, two, three, secret] = [await recordId('1'), await recordId('2'), await recordId('3'), await recordId('9')];
    await withTransaction(async (conn) => {
      await createLink(conn, { from: { type: 'external_record', id: one }, to: { type: 'external_record', id: two }, linkType: 'fixes', origin: 'source' });
      await createLink(conn, { from: { type: 'external_record', id: one }, to: { type: 'external_record', id: three }, linkType: 'related', origin: 'ai', confidence: 0.6 });
      await createLink(conn, { from: { type: 'external_record', id: one }, to: { type: 'external_record', id: secret }, linkType: 'references', origin: 'source' });
    });
    const forMember = (await as('member').get(`/api/v1/external-records/${one}`)).body.links;
    assert.deepEqual(forMember.map((l) => l.linkType), ['fixes']);
    const forAdmin = (await as('admin').get(`/api/v1/external-records/${one}`)).body.links;
    assert.deepEqual(forAdmin.map((l) => l.linkType).sort(), ['discussed_in', 'fixes', 'references', 'related']);
  });
});

describe('record project (admin)', () => {
  it('moves one record by hand, with its activities, and keeps it there on re-mapping', async () => {
    const id = await recordId('2');
    assert.equal((await as('manager').put(`/api/v1/external-records/${id}/project`, { projectId: ids.Q })).status, 403);
    const res = await as('admin').put(`/api/v1/external-records/${id}/project`, { projectId: ids.Q });
    assert.equal(res.status, 200);
    assert.equal(res.body.record.projectId, ids.Q);
    assert.equal((await as('member').get(`/api/v1/external-records/${id}`)).status, 404, 'no longer in the member’s project');
    const [[a]] = await pool.query('SELECT project_id FROM activities WHERE external_record_id = ?', [id]);
    assert.equal(a.project_id, ids.Q);

    await connectionService.updateResource(ids.connection, ids.resP, { projectId: null }, { actor: { id: ids.admin }, ip: null });
    await connectionService.updateResource(ids.connection, ids.resP, { projectId: ids.P }, { actor: { id: ids.admin }, ip: null });
    const [[row]] = await pool.query('SELECT project_id, project_locked FROM external_records WHERE id = ?', [id]);
    assert.deepEqual([row.project_id, Boolean(row.project_locked)], [ids.Q, true]);
    assert.equal((await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'external_record.project_changed'"))[0][0].n, 1);
  });
});

describe('identities (admin)', () => {
  it('lists unmatched people and matches them to users by hand', async () => {
    const list = await as('admin').get('/api/v1/integrations/identities?unmatched=true');
    assert.deepEqual(list.body.identities.map((i) => i.login), ['ana']);
    const identityId = list.body.identities[0].id;
    assert.equal((await as('manager').get('/api/v1/integrations/identities')).status, 403);

    const matched = await as('admin').patch(`/api/v1/integrations/identities/${identityId}`, { userId: ids.member });
    assert.deepEqual([matched.body.identity.userId, matched.body.identity.matchMethod, matched.body.identity.matchedBy], [ids.member, 'manual', ids.admin]);
    assert.deepEqual((await as('admin').get('/api/v1/integrations/identities?unmatched=true')).body.identities, []);
    const records = await as('member').get(`/api/v1/external-records?projectId=${ids.P}`);
    assert.equal(records.body.records[0].author.userId, ids.member);

    assert.equal((await as('admin').patch(`/api/v1/integrations/identities/${identityId}`, { userId: 999999 })).status, 400);
    const cleared = await as('admin').patch(`/api/v1/integrations/identities/${identityId}`, { userId: null });
    assert.deepEqual([cleared.body.identity.userId, cleared.body.identity.matchMethod], [null, 'none']);
    assert.equal((await as('admin').patch('/api/v1/integrations/identities/999999', { userId: null })).status, 404);
    assert.equal((await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'external_identity.matched'"))[0][0].n, 2);
  });
});
