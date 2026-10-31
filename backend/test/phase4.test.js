// Phase 4: internal activities and backfill, the unified feed (filters, paging, visibility),
// unified search, relationship management, record transitions, GitHub-stated relationships and
// the correlation boundary. Real database; GitHub records come through the real ingest.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as resources from '../src/repositories/integrationResourcesRepository.js';
import * as linksRepo from '../src/repositories/recordLinksRepository.js';
import { backfillFromAudit } from '../src/services/activities/internal.js';
import { recordAudit } from '../src/services/audit.js';
import * as correlation from '../src/services/correlation/index.js';
import { ingest, recordTransitions } from '../src/services/integrations/ingest.js';
import { closingIssueNumbers, pullEnvelopes } from '../src/services/integrations/providers/github/mappers.js';
import { fulltextQuery } from '../src/services/search.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const github = { id: 'github', sourceInstance: 'github.com' };
const repo = { id: 501, full_name: 'acme/payments' };

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
});
const one = async (sql, params = []) => (await pool.query(sql, params))[0][0];
const count = async (sql, params = []) => (await one(sql, params)).n;
const feed = async (who, qs = '') => as(who).get(`/api/v1/activities?limit=100${qs}`);
const summaries = (res) => res.body.activities.map((a) => a.summary);

async function insertMeeting(title, projectId, status = 'approved') {
  const [m] = await pool.execute(
    "INSERT INTO meetings (title, meeting_url, platform, native_meeting_id, created_by, project_id, status) VALUES (?, ?, 'google_meet', ?, ?, ?, ?)",
    [title, `https://meet.google.com/${title.length}xx-yyyy-zzz`, `${Date.now()}-${Math.random()}`, ids.admin, projectId, status],
  );
  return m.insertId;
}
async function insertItem(meetingId, projectId, { title, assignee, review = 'approved', task = 'todo' }) {
  const [r] = await pool.execute(
    "INSERT INTO action_items (meeting_id, project_id, title, description, assignee_user_id, assignee_match, review_status, task_status, flags) VALUES (?, ?, ?, ?, ?, 'manual', ?, ?, '[]')",
    [meetingId, projectId, title, `${title} details`, assignee, review, task],
  );
  return r.insertId;
}
const githubIngest = (envelopes, resource) =>
  withTransaction((conn) => ingest(conn, { connector: github, connection: { id: ids.connection }, resource, envelopes, origin: 'sync' }));
const pr = (number, o = {}) => ({
  number,
  title: `PR ${number}`,
  body: '',
  state: 'open',
  user: { id: 2, login: 'raj' },
  created_at: '2026-10-10T10:00:00Z',
  updated_at: '2026-10-10T10:00:00Z',
  html_url: `https://github.com/acme/payments/pull/${number}`,
  ...o,
});

before(async () => {
  await resetDatabase();
  for (const [key, role, name] of [
    ['admin', 'admin', 'Ada Admin'],
    ['manager', 'manager', 'Mia Manager'],
    ['member', 'employee', 'Eve Member'],
    ['other', 'employee', 'Oli Other'],
    ['outsider', 'employee', 'Oscar Outsider'],
  ]) {
    ids[key] = await createUser({ email: `${key}@p4.test`, role, fullName: name });
    cookies[key] = await loginCookie(app, `${key}@p4.test`);
  }
  // Projects through the API, so their activities come from the real code path.
  const created = await as('admin').post('/api/v1/projects', { name: 'Payments', ownerUserId: ids.manager, status: 'active', memberIds: [ids.member, ids.other] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  ids.P = created.body.project.id;
  ids.Q = (await as('admin').post('/api/v1/projects', { name: 'Secret mobile', status: 'planning' })).body.project.id;

  ids.meeting = await insertMeeting('Payments sync', ids.P);
  ids.secretMeeting = await insertMeeting('Mobile roadmap', ids.Q);
  ids.taskMember = await insertItem(ids.meeting, ids.P, { title: 'Refund ledger export', assignee: ids.member });
  ids.taskOther = await insertItem(ids.meeting, ids.P, { title: 'Chargeback dashboard', assignee: ids.other });
  ids.taskPending = await insertItem(ids.meeting, ids.P, { title: 'Pending idea', assignee: ids.member, review: 'pending' });
  ids.taskSecret = await insertItem(ids.secretMeeting, ids.Q, { title: 'Secret mobile refunds', assignee: ids.admin });

  // Audited changes the app makes (as the controllers do).
  for (const id of [ids.taskMember, ids.taskOther, ids.taskSecret]) {
    await recordAudit(pool, { actorUserId: ids.admin, action: 'action_item.approved', entityType: 'action_item', entityId: id, before: {}, after: {} });
  }
  await recordAudit(pool, { actorUserId: ids.admin, action: 'meeting.created', entityType: 'meeting', entityId: ids.meeting });
  await recordAudit(pool, { actorUserId: ids.admin, action: 'transcript.uploaded', entityType: 'meeting', entityId: ids.meeting, after: { status: 'transcript_ready' } });

  // GitHub data for project P (and a record with no project).
  ids.connection = await connections.create(pool, { provider: 'github', sourceInstance: 'github.com', externalAccountId: '7001', displayName: 'GitHub · acme', status: 'active' });
  const rid = await resources.upsert(pool, ids.connection, { resourceType: 'repository', externalId: '501', name: 'acme/payments' });
  await resources.update(pool, rid, { isEnabled: true, projectId: ids.P });
  ids.resource = await resources.findById(rid);
  await githubIngest(
    [
      { type: 'identity', externalUserId: '1', login: 'ana' },
      { type: 'record', recordType: 'issue', externalId: '501#12', externalKey: 'acme/payments#12', url: 'https://github.com/acme/payments/issues/12', title: 'Refunds fail for partial captures', body: 'Partial refund requests time out', state: 'open', statusCategory: 'todo', authorRef: { externalUserId: '1' }, sourceUpdatedAt: '2026-10-09T10:00:00Z' },
      { type: 'record', recordType: 'commit', externalId: '501:abc1234', externalKey: 'acme/payments@abc1234', title: 'Merge refunds', state: null, statusCategory: 'unknown', sourceUpdatedAt: '2026-10-11T10:00:00Z' },
      { type: 'activity', dedupeKey: 'github.com:issue:501#12:created', activityType: 'created', recordRef: { recordType: 'issue', externalId: '501#12' }, actorRef: { externalUserId: '1' }, occurredAt: '2026-10-09T10:00:00Z', summary: 'ana opened acme/payments#12' },
      ...pullEnvelopes('github.com', repo, pr(13, { body: 'Fixes #12 and also closes acme/payments#14, not other/repo#15', state: 'closed', merged_at: '2026-10-11T10:00:00Z', closed_at: '2026-10-11T10:00:00Z', merge_commit_sha: 'abc1234', updated_at: '2026-10-11T10:00:00Z' })),
    ],
    ids.resource,
  );
  await githubIngest(
    [{ type: 'record', recordType: 'issue', externalId: '999#1', externalKey: 'acme/unmapped#1', title: 'Unmapped refunds issue', state: 'open', statusCategory: 'todo', sourceUpdatedAt: '2026-10-09T10:00:00Z' }],
    null,
  );
});
after(closeDatabase);

describe('internal activities', () => {
  it('are created from the audited change, with subject, actor and project', async () => {
    const [rows] = await pool.query("SELECT * FROM activities WHERE provider = 'workagent' ORDER BY id");
    const kinds = rows.map((r) => `${r.entity_type}:${r.activity_type}`);
    assert.ok(kinds.includes('project:created'), 'project created through the API');
    assert.equal(kinds.filter((k) => k === 'action_item:created').length, 3);
    assert.ok(kinds.includes('meeting:scheduled') && kinds.includes('meeting:conducted'));
    const task = rows.find((r) => r.entity_id === ids.taskMember && r.activity_type === 'created');
    assert.deepEqual([task.project_id, task.actor_user_id, task.origin], [ids.P, ids.admin, 'internal']);
    assert.match(task.summary, /Ada Admin approved task “Refund ledger export” for Eve Member/);
  });

  it('follow task status changes made by the employee through the API', async () => {
    const res = await as('member').patch(`/api/v1/me/tasks/${ids.taskMember}/status`, { status: 'done' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const a = await one("SELECT * FROM activities WHERE entity_type = 'action_item' AND entity_id = ? AND activity_type = 'completed'", [ids.taskMember]);
    assert.ok(a);
    assert.equal(a.actor_user_id, ids.member);
    const back = await as('member').patch(`/api/v1/me/tasks/${ids.taskMember}/status`, { status: 'todo' });
    assert.equal(back.status, 200);
    assert.ok(await one("SELECT id FROM activities WHERE entity_id = ? AND activity_type = 'reopened'", [ids.taskMember]));
    await as('member').patch(`/api/v1/me/tasks/${ids.taskMember}/status`, { status: 'done' });
  });

  it('follow project status changes and archiving', async () => {
    await as('manager').patch(`/api/v1/projects/${ids.P}`, { status: 'on_hold' });
    await as('manager').patch(`/api/v1/projects/${ids.P}`, { status: 'active' });
    const types = (await pool.query("SELECT activity_type FROM activities WHERE entity_type = 'project' AND entity_id = ? ORDER BY id", [ids.P]))[0].map((r) => r.activity_type);
    assert.deepEqual(types, ['created', 'status_changed', 'status_changed']);
  });

  it('only approved items count as tasks for assignment events', async () => {
    await recordAudit(pool, { actorUserId: ids.admin, action: 'action_item.updated', entityType: 'action_item', entityId: ids.taskPending, before: { assigneeUserId: ids.member }, after: { assigneeUserId: ids.other } });
    assert.equal(await count("SELECT COUNT(*) AS n FROM activities WHERE entity_id = ? AND entity_type = 'action_item'", [ids.taskPending]), 0);
    await recordAudit(pool, { actorUserId: ids.admin, action: 'action_item.updated', entityType: 'action_item', entityId: ids.taskOther, before: { assigneeUserId: ids.other }, after: { assigneeUserId: ids.other } });
    assert.equal(await count("SELECT COUNT(*) AS n FROM activities WHERE entity_id = ? AND activity_type = 'assigned'", [ids.taskOther]), 0, 'no change, no event');
  });

  it('backfill recreates history from the audit log and is idempotent', async () => {
    const before = await count("SELECT COUNT(*) AS n FROM activities WHERE provider = 'workagent'");
    await pool.query("DELETE FROM activities WHERE provider = 'workagent'");
    const first = await backfillFromAudit(pool);
    assert.equal(first.activitiesCreated, before);
    assert.equal(await count("SELECT COUNT(*) AS n FROM activities WHERE provider = 'workagent'"), before);
    const second = await backfillFromAudit(pool);
    assert.equal(second.activitiesCreated, 0, 'running it again creates nothing');
    const [[a]] = await pool.query("SELECT a.occurred_at, l.created_at FROM activities a JOIN audit_logs l ON l.action = 'project.created' AND l.entity_id = a.entity_id WHERE a.entity_type = 'project' AND a.activity_type = 'created' AND a.entity_id = ?", [ids.P]);
    assert.equal(new Date(a.occurred_at).getTime(), new Date(a.created_at).getTime(), 'backfilled at the original time');
  });
});

describe('unified activity feed', () => {
  it('admins see everything; members see their projects and only their own tasks', async () => {
    const admin = summaries(await feed('admin'));
    assert.ok(admin.some((s) => /Secret mobile refunds/.test(s)));
    assert.ok(admin.some((s) => /ana opened acme\/payments#12/.test(s)));

    const member = summaries(await feed('member'));
    assert.ok(member.some((s) => /ana opened acme\/payments#12/.test(s)), 'GitHub activity of a project the member belongs to');
    assert.ok(member.some((s) => /Refund ledger export/.test(s)), 'own task');
    assert.ok(!member.some((s) => /Chargeback dashboard/.test(s)), 'not a colleague’s task (Phase 2 rule)');
    assert.ok(!member.some((s) => /Secret/.test(s)), 'nothing from other projects');
    assert.ok(!member.some((s) => /Unmapped/.test(s)), 'nothing without a project');

    const manager = summaries(await feed('manager'));
    assert.ok(manager.some((s) => /Chargeback dashboard/.test(s)), 'project owners see every task of their project');
    assert.deepEqual(summaries(await feed('outsider')), []);
    assert.equal((await feed('outsider', `&projectId=${ids.P}`)).status, 404);
    assert.equal((await feed('member', '&unassigned=true')).status, 400);
  });

  it('filters by project, person, provider, type, subject, record, status and dates', async () => {
    const f = async (qs) => (await feed('admin', qs)).body.activities;
    assert.ok((await f(`&projectId=${ids.Q}`)).every((a) => a.project?.id === ids.Q));
    assert.ok((await f('&provider=github')).every((a) => a.provider === 'github'));
    assert.ok((await f('&provider=workagent')).every((a) => a.provider === 'workagent'));
    assert.deepEqual([...new Set((await f('&activityType=merged,completed')).map((a) => a.activityType))].sort(), ['completed', 'merged']);
    assert.ok((await f(`&userId=${ids.member}`)).every((a) => a.actor?.userId === ids.member));
    const tasks = await f('&subjectType=task');
    assert.ok(tasks.length && tasks.every((a) => a.subject.type === 'action_item' && a.subject.recordType === 'task'));
    assert.ok((await f('&subjectType=pull_request')).every((a) => a.subject.recordType === 'pull_request'));
    const issueId = (await one("SELECT id FROM external_records WHERE external_id = '501#12'")).id;
    assert.ok((await f(`&recordId=${issueId}`)).every((a) => a.subject.id === issueId));
    assert.ok((await f('&status=done&subjectType=task')).every((a) => a.subject.type === 'action_item'));
    const dated = await f('&from=2026-10-09T00:00:00Z&to=2026-10-10T00:00:00Z');
    assert.ok(dated.length && dated.every((a) => new Date(a.occurredAt) >= new Date('2026-10-09') && new Date(a.occurredAt) < new Date('2026-10-10')));
    assert.equal((await feed('admin', `&entityType=meeting&entityId=${ids.meeting}`)).body.activities.length, 2);
    assert.equal((await feed('admin', '&entityType=meeting')).status, 400, 'entityType needs entityId');
    assert.equal((await feed('admin', '&activityType=exploded')).status, 400, 'only known activity types');
  });

  it('pages newest first without gaps or repeats', async () => {
    const all = (await feed('admin')).body.activities.map((a) => a.id);
    const seen = [];
    let next = '';
    for (let i = 0; i < 50; i++) {
      const res = await as('admin').get(`/api/v1/activities?limit=3${next ? `&before=${next}` : ''}`);
      seen.push(...res.body.activities.map((a) => a.id));
      if (!res.body.next) break;
      next = res.body.next;
    }
    assert.deepEqual(seen, all);
    const times = (await feed('admin')).body.activities.map((a) => new Date(a.occurredAt).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  it('subjects carry where to go: source link for external records, the right page for tasks', async () => {
    const acts = (await feed('member')).body.activities;
    const issue = acts.find((a) => a.subject?.recordType === 'issue');
    assert.equal(issue.subject.url, 'https://github.com/acme/payments/issues/12');
    assert.equal(issue.subject.href, `/records/${issue.subject.id}`);
    const task = acts.find((a) => a.subject?.type === 'action_item');
    assert.equal(task.subject.href, `/my/tasks/${ids.taskMember}`);
    const managerTask = (await feed('manager')).body.activities.find((a) => a.subject?.id === ids.taskOther);
    assert.equal(managerTask.subject.href, `/projects/${ids.P}`);
    assert.deepEqual((await as('member').get('/api/v1/activities/types')).body.activityTypes.find((t) => t.id === 'merged'), { id: 'merged', label: 'Merged' });
  });
});

describe('unified search', () => {
  const search = (who, qs) => as(who).get(`/api/v1/search?${qs}`);
  const titles = (res) => res.body.results.map((r) => `${r.type}:${r.title}`);

  it('finds projects, meetings, tasks and GitHub records in one query', async () => {
    const res = await search('admin', 'q=refund');
    const t = titles(res);
    assert.ok(t.includes('external_record:Refunds fail for partial captures'));
    assert.ok(t.includes('action_item:Refund ledger export'));
    assert.ok(t.includes('action_item:Secret mobile refunds'));
    assert.ok(t.includes('external_record:Unmapped refunds issue'), 'admins also see records with no project');
    assert.equal(res.body.counts.task, 2);
    assert.ok(titles(await search('admin', 'q=Payments')).includes('project:Payments'));
    assert.ok(titles(await search('admin', 'q=sync')).includes('meeting:Payments sync'));
  });

  it('respects project membership and task visibility', async () => {
    const member = titles(await search('member', 'q=refund'));
    assert.ok(member.includes('external_record:Refunds fail for partial captures'));
    assert.ok(member.includes('action_item:Refund ledger export'));
    assert.ok(!member.some((t) => /Secret|Unmapped/.test(t)));
    assert.ok(!titles(await search('member', 'q=Chargeback')).length, 'not a colleague’s task');
    assert.ok(titles(await search('manager', 'q=Chargeback')).includes('action_item:Chargeback dashboard'), 'the project owner sees it');
    assert.deepEqual(titles(await search('outsider', 'q=refund')), []);
    assert.equal((await search('outsider', `q=refund&projectId=${ids.P}`)).status, 404);
    const meetingForMember = (await search('member', 'q=sync')).body.results.find((r) => r.type === 'meeting');
    assert.equal(meetingForMember.href, `/projects/${ids.P}`, 'non-admins open the project page (meetings are admin pages)');
  });

  it('matches keys and short words, filters by type and record type, hides deleted records', async () => {
    assert.ok(titles(await search('admin', 'q=%2312')).includes('external_record:Refunds fail for partial captures'), '"#12" matches the key');
    assert.ok(titles(await search('admin', 'q=abc1234')).includes('external_record:Merge refunds'), 'a commit sha');
    assert.ok(titles(await search('admin', 'q=PR')).some((t) => t.startsWith('external_record:PR 13')), 'two-letter words fall back to LIKE');
    assert.deepEqual([...new Set((await search('admin', 'q=refund&types=task')).body.results.map((r) => r.type))], ['action_item']);
    assert.ok((await search('admin', 'q=refund&recordType=issue')).body.results.every((r) => r.recordType === 'issue'));
    await pool.execute("UPDATE external_records SET source_deleted_at = NOW() WHERE external_id = '999#1'");
    assert.ok(!titles(await search('admin', 'q=Unmapped')).length);
    assert.ok(titles(await search('admin', 'q=Unmapped&includeDeleted=true')).length);
    await pool.execute("UPDATE external_records SET source_deleted_at = NULL WHERE external_id = '999#1'");
    assert.equal((await search('admin', 'q=')).status, 400);
    assert.equal(fulltextQuery('refund "ledger" +-*'), '+refund* +ledger*', 'operators are stripped');
    assert.equal(fulltextQuery('a refund'), null);
  });
});

describe('relationships', () => {
  it('GitHub-stated links: closing keywords and merge commits, same repository only', async () => {
    assert.deepEqual(closingIssueNumbers('Fixes #1, resolves: #2, closes acme/payments#3, fixes other/repo#4, mentions #5', repo), [1, 2, 3]);
    const issue = await one("SELECT id FROM external_records WHERE external_id = '501#12'");
    const pull = await one("SELECT id FROM external_records WHERE external_id = '501#13'");
    const commit = await one("SELECT id FROM external_records WHERE external_id = '501:abc1234'");
    const links = await linksRepo.listFor({ type: 'external_record', id: pull.id });
    assert.deepEqual(links.map((l) => [l.linkType, l.to.id, l.origin, l.status]).sort(), [
      ['fixes', issue.id, 'source', 'confirmed'],
      ['includes', commit.id, 'source', 'confirmed'],
    ]);
  });

  it('suggestions are reviewed by people; rejected ones are never suggested again', async () => {
    const issue = { type: 'external_record', id: (await one("SELECT id FROM external_records WHERE external_id = '501#12'")).id };
    const task = { type: 'action_item', id: ids.taskMember };
    const s = await withTransaction((conn) => correlation.suggestLink(conn, { from: task, to: issue, linkType: 'tracks', confidence: 0.62, evidence: { title: 'refund' } }));
    assert.ok(s.created);
    assert.equal((await linksRepo.findById(s.id)).status, 'suggested');

    const pending = await as('manager').get('/api/v1/record-links?status=suggested');
    assert.deepEqual(pending.body.suggestions.map((x) => x.id), [s.id]);
    assert.deepEqual((await as('member').get('/api/v1/record-links?status=suggested')).body.suggestions, [], 'employees review nothing');
    assert.deepEqual((await as('member').get(`/api/v1/record-links?type=action_item&id=${ids.taskMember}`)).body.links, [], 'unconfirmed links are hidden from employees');

    assert.equal((await as('manager').patch(`/api/v1/record-links/${s.id}`, { status: 'rejected' })).body.link.status, 'rejected');
    const again = await withTransaction((conn) => correlation.suggestLink(conn, { from: task, to: issue, linkType: 'tracks', confidence: 0.9 }));
    assert.equal(again, null, 'a person rejected it');
    assert.equal((await linksRepo.findById(s.id)).status, 'rejected');

    const manual = await as('manager').post('/api/v1/record-links', { from: task, to: issue, linkType: 'tracks' });
    assert.deepEqual([manual.status, manual.body.link.id, manual.body.link.status], [200, s.id, 'confirmed'], 'a person can still link them');
    const forMember = (await as('member').get(`/api/v1/record-links?type=action_item&id=${ids.taskMember}`)).body.links;
    assert.deepEqual(forMember.map((l) => [l.linkType, l.other.title, l.canEdit]), [['tracks', 'Refunds fail for partial captures', false]]);
    const trail = (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'record_link' AND entity_id = ? ORDER BY id", [s.id]))[0].map((r) => r.action);
    assert.deepEqual(trail, ['record_link.rejected', 'record_link.created']);
  });

  it('links to things a person cannot see stay hidden from them', async () => {
    const issue = { type: 'external_record', id: (await one("SELECT id FROM external_records WHERE external_id = '501#12'")).id };
    await as('admin').post('/api/v1/record-links', { from: issue, to: { type: 'action_item', id: ids.taskSecret }, linkType: 'related' });
    const forMember = (await as('member').get(`/api/v1/record-links?type=external_record&id=${issue.id}`)).body.links;
    assert.ok(!forMember.some((l) => l.other.type === 'action_item' && l.other.id === ids.taskSecret));
    const forAdmin = (await as('admin').get(`/api/v1/record-links?type=external_record&id=${issue.id}`)).body.links;
    assert.ok(forAdmin.some((l) => l.other.id === ids.taskSecret));
    assert.equal((await as('outsider').get(`/api/v1/record-links?type=external_record&id=${issue.id}`)).status, 404);
  });
});

describe('record transitions and lifecycle', () => {
  it('derive status, rename, deletion and archive activities once, unless the provider sent one', () => {
    const base = { recordType: 'issue', externalId: '1#1', externalKey: 'o/r#1', title: 'A', state: 'open', statusCategory: 'todo', sourceDeletedAt: null };
    const t = (after) => recordTransitions('github.com', base, { ...base, sourceUpdatedAt: new Date('2026-10-20T00:00:00Z'), ...after });
    assert.deepEqual(t({ statusCategory: 'done', state: 'closed' }).map((a) => a.activityType), ['status_changed']);
    assert.deepEqual(t({ title: 'B' }).map((a) => [a.activityType, a.dedupeKey]), [['updated', `github.com:issue:1#1:updated:${Date.parse('2026-10-20T00:00:00Z')}`]]);
    assert.deepEqual(t({ sourceDeletedAt: new Date('2026-10-21T00:00:00Z') }).map((a) => a.activityType), ['deleted']);
    assert.deepEqual(t({ state: 'archived' }).map((a) => a.activityType), ['archived']);
    assert.deepEqual(t({}), []);
  });

  it('ingest records them on the timeline; deleted records are kept and hidden by default', async () => {
    await githubIngest([{ type: 'record', recordType: 'issue', externalId: '501#12', externalKey: 'acme/payments#12', url: 'https://github.com/acme/payments/issues/12', title: 'Refunds fail for partial captures', state: 'closed', statusCategory: 'done', sourceUpdatedAt: '2026-10-20T10:00:00Z' }], ids.resource);
    assert.ok(await one("SELECT id FROM activities WHERE activity_type = 'status_changed' AND dedupe_key LIKE 'github.com:issue:501#12:status:done:%'"));
    await githubIngest([{ type: 'record', recordType: 'issue', externalId: '501#12', externalKey: 'acme/payments#12', title: 'Refunds fail for partial captures', state: 'closed', statusCategory: 'done', deleted: true, sourceUpdatedAt: '2026-10-21T10:00:00Z' }], ids.resource);
    const id = (await one("SELECT id FROM external_records WHERE external_id = '501#12'")).id;
    assert.ok(await one("SELECT id FROM activities WHERE external_record_id = ? AND activity_type = 'deleted'", [id]));
    const list = await as('admin').get(`/api/v1/external-records?projectId=${ids.P}`);
    assert.ok(!list.body.records.some((r) => r.id === id), 'hidden by default');
    assert.ok((await as('admin').get(`/api/v1/external-records?projectId=${ids.P}&includeDeleted=true`)).body.records.some((r) => r.id === id));
    const detail = await as('member').get(`/api/v1/external-records/${id}`);
    assert.deepEqual([detail.status, detail.body.record.sourceStatus], [200, 'deleted'], 'history stays reachable');
    assert.ok(detail.body.links.length > 0, 'its relationships too');
  });

  it('shows when the source is disconnected; data and history stay', async () => {
    const pull = (await one("SELECT id FROM external_records WHERE external_id = '501#13'")).id;
    await connections.update(pool, ids.connection, { status: 'disconnected' });
    const detail = await as('member').get(`/api/v1/external-records/${pull}`);
    assert.deepEqual([detail.body.record.sourceStatus, detail.body.record.provider, detail.body.record.externalId, detail.body.record.sourceInstance], ['disconnected', 'github', '501#13', 'github.com']);
    assert.ok(detail.body.activities.length > 0);
    await connections.update(pool, ids.connection, { status: 'active' });
  });

  it('non-admins list records across all their projects without choosing one', async () => {
    const res = await as('member').get('/api/v1/external-records');
    assert.equal(res.status, 200);
    assert.ok(res.body.records.length && res.body.records.every((r) => r.projectId === ids.P));
    assert.deepEqual((await as('outsider').get('/api/v1/external-records')).body.records, []);
  });
});

describe('correlation boundary', () => {
  it('matchers register once, need an id, and can only suggest', async () => {
    assert.throws(() => correlation.registerMatcher({ id: 'x' }), /needs an id and run/);
    const commit = await one("SELECT id FROM external_records WHERE external_id = '501:abc1234'");
    correlation.registerMatcher({ id: 'test-matcher', run: async () => [{ to: { type: 'action_item', id: ids.taskOther }, linkType: 'related', confidence: 0.4, evidence: { reason: 'test' } }] });
    assert.throws(() => correlation.registerMatcher({ id: 'test-matcher', run: async () => [] }), /Duplicate/);
    assert.ok(correlation.listMatchers().includes('test-matcher'));
    assert.equal(await withTransaction((conn) => correlation.runMatchers(conn, { id: commit.id })), 1);
    assert.equal(await withTransaction((conn) => correlation.runMatchers(conn, { id: commit.id })), 0, 'no duplicate suggestions');
    const link = (await linksRepo.listFor({ type: 'external_record', id: commit.id })).find((l) => l.linkType === 'related');
    assert.deepEqual([link.origin, link.status, link.confidence, link.evidence], ['rule', 'suggested', 0.4, { matcher: 'test-matcher', reason: 'test' }]);
    await assert.rejects(withTransaction((conn) => correlation.suggestLink(conn, { from: { type: 'external_record', id: commit.id }, to: { type: 'meeting', id: ids.meeting }, linkType: 'related', confidence: 1, method: 'manual' })), /rules or AI/);
    await assert.rejects(withTransaction((conn) => correlation.suggestLink(conn, { from: { type: 'external_record', id: commit.id }, to: { type: 'meeting', id: ids.meeting }, linkType: 'related', confidence: 2 })), /between 0 and 1/);
  });

  it('resolves users, keys and project context', async () => {
    await pool.execute("UPDATE external_identities SET user_id = ?, match_method = 'manual' WHERE external_user_id = '1'", [ids.member]);
    assert.equal(await correlation.resolveUser({ provider: 'github', sourceInstance: 'github.com', externalUserId: 1 }), ids.member);
    assert.equal(await correlation.resolveUser({ provider: 'github', sourceInstance: 'github.com', externalUserId: 404 }), null);
    assert.deepEqual((await correlation.findRecordsByKey('acme/payments#13')).map((r) => r.recordType), ['pull_request']);
    const ctx = await correlation.projectContext(ids.P);
    assert.equal(ctx.project.name, 'Payments');
    assert.deepEqual(ctx.memberUserIds.sort(), [ids.manager, ids.member, ids.other].sort());
    assert.deepEqual(ctx.resources.map((r) => r.name), ['acme/payments']);
    assert.equal(await correlation.projectContext(999999), null);
  });
});
