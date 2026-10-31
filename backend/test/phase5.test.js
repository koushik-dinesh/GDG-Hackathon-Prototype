// Phase 5: cross-application correlation. Matchers (explicit keys, wording overlap, meeting window)
// produce explainable suggestions only; re-evaluation is queued when records, tasks and meetings
// change; duplicates, rejections and deleted records are handled; people review suggestions.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import { processNext } from '../src/jobs/runner.js';
import * as linksRepo from '../src/repositories/recordLinksRepository.js';
import { recordAudit } from '../src/services/audit.js';
import { evaluate } from '../src/services/correlation/index.js';
import { tokens } from '../src/services/correlation/matchers.js';
import { ingest } from '../src/services/integrations/ingest.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
});
const one = async (sql, params = []) => (await pool.query(sql, params))[0][0];
const day = (d, h = 10) => new Date(Date.UTC(2026, 9, d, h)).toISOString();
const ev = (ref) => withTransaction((conn) => evaluate(conn, ref));
const ext = (id) => ({ type: 'external_record', id });
const suggestionsFor = async (ref) => (await linksRepo.listFor(ref)).filter((l) => l.origin === 'rule');

async function ingestRecords(envelopes, { provider = 'github', connectionId = ids.github, resource = ids.resource } = {}) {
  return withTransaction((conn) => ingest(conn, { connector: { id: provider, sourceInstance: `${provider}.test` }, connection: { id: connectionId }, resource, envelopes, origin: 'sync' }));
}
const rec = (externalId, o = {}) => ({
  type: 'record',
  recordType: 'issue',
  externalId,
  externalKey: `acme/payments#${externalId}`,
  title: `Issue ${externalId}`,
  state: 'open',
  statusCategory: 'todo',
  sourceCreatedAt: day(20),
  sourceUpdatedAt: day(20),
  ...o,
});
const recId = async (externalId) => (await one('SELECT id FROM external_records WHERE external_id = ?', [externalId])).id;

async function task(title, { projectId = ids.P, assignee = ids.member, review = 'approved', description = null, meetingId = ids.meeting } = {}) {
  const [r] = await pool.execute(
    "INSERT INTO action_items (meeting_id, project_id, title, description, assignee_user_id, assignee_match, review_status, task_status, flags) VALUES (?, ?, ?, ?, ?, 'manual', ?, 'todo', '[]')",
    [meetingId, projectId, title, description, assignee, review],
  );
  return r.insertId;
}

before(async () => {
  await resetDatabase();
  for (const [key, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['member', 'employee'],
  ]) {
    ids[key] = await createUser({ email: `${key}@p5.test`, role, fullName: `P5 ${key}` });
    cookies[key] = await loginCookie(app, `${key}@p5.test`);
  }
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.manager]);
  ids.P = p.insertId;
  const [q] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Mobile', ?, 'active')", [ids.admin]);
  ids.Q = q.insertId;
  await pool.execute('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)', [ids.P, ids.member]);
  const [m] = await pool.execute(
    "INSERT INTO meetings (title, meeting_url, platform, native_meeting_id, created_by, project_id, scheduled_at, status) VALUES ('Refund escalation review', 'https://meet.google.com/abc-defg-hij', 'google_meet', 'p5-m1', ?, ?, ?, 'approved')",
    [ids.admin, ids.P, new Date(day(15))],
  );
  ids.meeting = m.insertId;
  const [g] = await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status) VALUES ('github', 'github.test', '1', 'GitHub', 'active')");
  ids.github = g.insertId;
  const [j] = await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status) VALUES ('jira', 'jira.test', '1', 'Jira', 'active')");
  ids.jira = j.insertId;
  const [r] = await pool.execute("INSERT INTO integration_resources (connection_id, resource_type, external_id, name, is_enabled, project_id) VALUES (?, 'repository', '501', 'acme/payments', TRUE, ?)", [ids.github, ids.P]);
  ids.resource = { id: r.insertId, projectId: ids.P };
  const [jr] = await pool.execute("INSERT INTO integration_resources (connection_id, resource_type, external_id, name, is_enabled, project_id) VALUES (?, 'project', 'PAY', 'PAY', TRUE, ?)", [ids.jira, ids.P]);
  ids.jiraResource = { id: jr.insertId, projectId: ids.P };
});
after(closeDatabase);
beforeEach(async () => {
  await pool.query('DELETE FROM record_links');
  await pool.query('DELETE FROM jobs');
});

describe('key-reference matcher', () => {
  it('suggests references for explicit keys across providers and "#N" inside the repository', async () => {
    await ingestRecords([rec('7', { title: 'Refund ledger' }), rec('8', { title: 'Mentions others', body: 'Related to acme/payments#7 and PAY-42; see also #9 and #8 itself.' }), rec('9', { title: 'Third' })]);
    await ingestRecords([{ type: 'record', recordType: 'jira_issue', externalId: '10042', externalKey: 'PAY-42', title: 'Refund export in Jira', state: 'To Do', statusCategory: 'todo', sourceUpdatedAt: day(20) }], { provider: 'jira', connectionId: ids.jira, resource: ids.jiraResource });

    const result = await ev(ext(await recId('8')));
    assert.ok(result.suggested >= 3);
    const links = await suggestionsFor(ext(await recId('8')));
    const byTarget = Object.fromEntries(links.map((l) => [l.to.id, l]));
    const full = byTarget[await recId('7')];
    assert.deepEqual([full.linkType, full.status, full.confidence, full.evidence.matcher, full.evidence.reason], ['references', 'suggested', 0.9, 'key-reference', 'Mentions acme/payments#7']);
    assert.equal(byTarget[await recId('10042')].confidence, 0.9, 'a Jira key from a GitHub issue: provider-independent');
    assert.equal(byTarget[await recId('9')].confidence, 0.75, 'short "#9" only within the repository');
    assert.ok(!byTarget[await recId('8')], 'never itself');
  });

  it('finds keys mentioned by tasks too, and ignores records deleted at the source', async () => {
    await ingestRecords([rec('11', { title: 'Old thing', deleted: true })]);
    const t = await task('Follow up acme/payments#7 and acme/payments#11');
    await ev({ type: 'action_item', id: t });
    const targets = (await suggestionsFor({ type: 'action_item', id: t })).map((l) => l.to.id);
    assert.deepEqual(targets, [await recId('7')]);
  });
});

describe('wording-overlap matcher', () => {
  it('links a task to the issue describing the same work in the same project, with evidence', async () => {
    await ingestRecords([rec('20', { title: 'Partial refund timeouts on card captures', body: 'Partial refunds time out when the capture is old.' })]);
    const t = await task('Handle partial refund timeouts', { description: 'Partial refunds on old card captures time out' });
    await ev({ type: 'action_item', id: t });
    const [link] = await suggestionsFor({ type: 'action_item', id: t });
    assert.equal(link.linkType, 'tracks');
    assert.equal(link.to.id, await recId('20'));
    assert.ok(link.confidence >= 0.6 && link.confidence <= 0.9, `confidence ${link.confidence}`);
    assert.ok(link.evidence.sharedTerms.includes('refund') || link.evidence.sharedTerms.includes('partial'));
    assert.match(link.evidence.reason, /^Same project; both mention/);
  });

  it('is stronger when the same person is involved, and finds tasks from the issue side', async () => {
    await pool.execute("INSERT INTO external_identities (provider, source_instance, external_user_id, login, user_id, match_method) VALUES ('github', 'github.test', '77', 'eve', ?, 'manual')", [ids.member]);
    await ingestRecords([{ type: 'identity', externalUserId: '77', login: 'eve' }, rec('21', { title: 'Chargeback dispute evidence upload', body: 'Upload dispute evidence for chargebacks', authorRef: { externalUserId: '77' } })]);
    const t = await task('Chargeback dispute evidence upload flow', { description: 'Build the upload for chargeback dispute evidence' });
    await ev(ext(await recId('21')));
    const [link] = await suggestionsFor({ type: 'action_item', id: t });
    assert.equal(link.from.id, t);
    assert.equal(link.evidence.samePerson, true);
    assert.match(link.evidence.reason, /same person/);
  });

  it('never crosses projects, and ignores unapproved items and unrelated wording', async () => {
    await ingestRecords([rec('22', { title: 'Mobile push notification badges', body: 'Badge counts for push notifications' })]);
    const otherProject = await task('Mobile push notification badges', { projectId: ids.Q });
    const pending = await task('Mobile push notification badges again', { review: 'pending' });
    const unrelated = await task('Quarterly tax report');
    for (const t of [otherProject, pending, unrelated]) await ev({ type: 'action_item', id: t });
    for (const t of [otherProject, pending, unrelated]) assert.deepEqual(await suggestionsFor({ type: 'action_item', id: t }), []);
  });
});

describe('meeting-window matcher', () => {
  it('links work created around a project meeting about the same topic', async () => {
    await task('Escalation playbook for refund disputes', { meetingId: ids.meeting });
    await ingestRecords([
      rec('30', { title: 'Refund escalation path for disputes', sourceCreatedAt: day(16), sourceUpdatedAt: day(16) }),
      rec('31', { title: 'Refund escalation path, much later', sourceCreatedAt: day(28), sourceUpdatedAt: day(28) }),
    ]);
    await ev({ type: 'meeting', id: ids.meeting });
    const links = await suggestionsFor({ type: 'meeting', id: ids.meeting });
    assert.deepEqual(links.map((l) => [l.from.id, l.linkType]), [[await recId('30'), 'discussed_in']]);
    assert.match(links[0].evidence.reason, /Created 1 day\(s\) after the meeting; both mention/);
  });
});

describe('engine guarantees', () => {
  it('no duplicates: re-evaluation adds nothing; existing or rejected relationships are respected', async () => {
    await ingestRecords([rec('40', { title: 'Settlement report export' }), rec('41', { title: 'Mentions', body: 'See acme/payments#40' })]);
    const subject = ext(await recId('41'));
    assert.equal((await ev(subject)).suggested, 1);
    assert.equal((await ev(subject)).suggested, 0, 'same suggestion again: nothing');
    const [s] = await suggestionsFor(subject);
    await as('admin').patch(`/api/v1/record-links/${s.id}`, { status: 'rejected' });
    assert.equal((await ev(subject)).suggested, 0, 'rejected by a person: never again');

    await pool.query('DELETE FROM record_links');
    const target = ext(await recId('40'));
    await withTransaction((conn) => linksRepo.insertIfNew(conn, { from: subject, to: target, linkType: 'fixes', origin: 'source', status: 'confirmed', confidence: 1 }));
    assert.equal((await ev(subject)).suggested, 0, 'already related (any type): no extra suggestion');
  });

  it('withdraws pending suggestions when a record is deleted at the source; history stays', async () => {
    await ingestRecords([rec('50', { title: 'Card vault' }), rec('51', { title: 'Mentions', body: 'acme/payments#50' })]);
    await ev(ext(await recId('51')));
    await ingestRecords([rec('51', { title: 'Mentions', body: 'acme/payments#50', deleted: true, sourceUpdatedAt: day(25) })]);
    const result = await ev(ext(await recId('51')));
    assert.equal(result.withdrawn, 1);
    const [l] = await linksRepo.listFor(ext(await recId('51')));
    assert.equal(l.status, 'rejected', 'kept as rejected');
  });

  it('confirmed relationships are never created automatically', async () => {
    await ingestRecords([rec('60', { title: 'Payout batching' }), rec('61', { title: 'Mentions', body: 'acme/payments#60' })]);
    await ev(ext(await recId('61')));
    const [{ n }] = (await pool.query("SELECT COUNT(*) AS n FROM record_links WHERE origin IN ('rule','ai') AND status = 'confirmed'"))[0];
    assert.equal(n, 0);
  });
});

describe('re-evaluation jobs', () => {
  it('are queued when records arrive or change, once per subject, and run in the worker', async () => {
    await ingestRecords([rec('70', { title: 'Fraud scoring rules' }), rec('71', { title: 'Mentions', body: 'acme/payments#70' }), { type: 'record', recordType: 'repository', externalId: '501', title: 'acme/payments', statusCategory: 'unknown' }]);
    const jobs = (await pool.query("SELECT payload FROM jobs WHERE type = 'correlation.evaluate'"))[0].map((j) => (typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload));
    assert.deepEqual(jobs.map((p) => p.type), ['external_record', 'external_record'], 'repositories are not evaluated');
    await ingestRecords([rec('71', { title: 'Mentions again', body: 'acme/payments#70', sourceUpdatedAt: day(26) })]);
    assert.equal((await one("SELECT COUNT(*) AS n FROM jobs WHERE type = 'correlation.evaluate' AND status = 'pending'")).n, 2, 'one pending job per subject');
    while (await processNext('w', handlersFor(['correlation.evaluate'])));
    assert.equal((await suggestionsFor(ext(await recId('71')))).length, 1);
  });

  it('are queued when a task is approved or a meeting changes', async () => {
    const t = await task('Refund approvals');
    await recordAudit(pool, { actorUserId: ids.admin, action: 'action_item.approved', entityType: 'action_item', entityId: t });
    await recordAudit(pool, { actorUserId: ids.admin, action: 'meeting.updated', entityType: 'meeting', entityId: ids.meeting });
    await recordAudit(pool, { actorUserId: ids.admin, action: 'auth.login', entityType: 'user', entityId: ids.admin });
    const jobs = (await pool.query("SELECT payload FROM jobs WHERE type = 'correlation.evaluate' ORDER BY id"))[0].map((j) => (typeof j.payload === 'string' ? JSON.parse(j.payload) : j.payload));
    assert.deepEqual(jobs, [{ type: 'action_item', id: t }, { type: 'meeting', id: ids.meeting }]);
  });
});

describe('review by people', () => {
  it('suggestions go to admins and project managers, not employees, and are confirmed by them', async () => {
    await ingestRecords([rec('80', { title: 'Payout reconciliation' }), rec('81', { title: 'Mentions', body: 'acme/payments#80' })]);
    await ev(ext(await recId('81')));
    const forManager = (await as('manager').get('/api/v1/record-links?status=suggested')).body.suggestions;
    assert.equal(forManager.length, 1);
    assert.equal(forManager[0].evidence.reason, 'Mentions acme/payments#80');
    assert.deepEqual((await as('member').get('/api/v1/record-links?status=suggested')).body.suggestions, []);
    const confirmed = await as('manager').patch(`/api/v1/record-links/${forManager[0].id}`, { status: 'confirmed' });
    assert.deepEqual([confirmed.body.link.status, confirmed.body.link.origin, confirmed.body.link.reviewedBy], ['confirmed', 'rule', ids.manager], 'provenance kept');
  });
});

describe('text features', () => {
  it('keeps significant words only', () => {
    assert.deepEqual([...tokens('Fix the partial refunds timeout for old captures #12')].sort(), ['captures', 'partial', 'refunds', 'timeout']);
    assert.deepEqual([...tokens('See acme/payments#40, PAY-42 and https://example.test/x/y abc1234 refunds')], ['refunds'], 'identifiers are not topic words');
  });
});
