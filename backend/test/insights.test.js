// Phase 7: insights. Figures are counts of visible rows; every judgement is marked as an
// inference with its rule; admins, managers and employees each see their own scope; filters
// that point at something invisible are 404.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const get = (who, url) => request(app).get(url).set('Cookie', cookies[who]);
const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY);
const dateAgo = (d) => ago(d).toISOString().slice(0, 10);

async function task(title, { projectId = ids.P, assignee = ids.member, status = 'todo', due = null, priority = 'medium', meetingId = ids.meeting, updatedDaysAgo = 1 } = {}) {
  const [r] = await pool.execute(
    `INSERT INTO action_items (meeting_id, project_id, title, assignee_user_id, assignee_match, review_status, task_status, due_date, priority, flags, updated_at)
     VALUES (?, ?, ?, ?, 'manual', 'approved', ?, ?, ?, '[]', ?)`,
    [meetingId, projectId, title, assignee, status, due, priority, ago(updatedDaysAgo)],
  );
  return r.insertId;
}

let seq = 0;
async function record(recordType, { projectId = ids.P, title, state = 'open', category = 'todo', createdDaysAgo = 1, updatedDaysAgo = 1, metadata = {}, parent = null, deleted = false } = {}) {
  seq += 1;
  const [r] = await pool.execute(
    `INSERT INTO external_records (provider, source_instance, record_type, external_id, external_key, connection_id, parent_record_id, title, state, status_category, project_id, metadata, content_hash, source_created_at, source_updated_at, source_deleted_at)
     VALUES ('github', 'github.test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, REPEAT('a', 64), ?, ?, ?)`,
    [recordType, `x${seq}`, recordType === 'review' ? null : `acme/app#${seq}`, ids.github, parent, title ?? `${recordType} ${seq}`, state, category, projectId, JSON.stringify(metadata), ago(createdDaysAgo), ago(updatedDaysAgo), deleted ? ago(0) : null],
  );
  return r.insertId;
}

before(async () => {
  await resetDatabase();
  for (const [key, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['member', 'employee'],
    ['other', 'employee'],
  ]) {
    ids[key] = await createUser({ email: `${key}@p7.test`, role, fullName: `P7 ${key}` });
    cookies[key] = await loginCookie(app, `${key}@p7.test`);
  }
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status, target_date) VALUES ('Payments', ?, 'active', ?)", [ids.manager, dateAgo(-60)]);
  ids.P = p.insertId;
  const [q] = await pool.execute("INSERT INTO projects (name, owner_user_id, status, target_date) VALUES ('Mobile', ?, 'active', ?)", [ids.admin, dateAgo(3)]);
  ids.Q = q.insertId;
  await pool.query('INSERT INTO project_members (project_id, user_id) VALUES (?, ?), (?, ?)', [ids.P, ids.member, ids.Q, ids.other]);
  const [m] = await pool.execute(
    "INSERT INTO meetings (title, meeting_url, platform, native_meeting_id, created_by, project_id, scheduled_at, status) VALUES ('Payments weekly', 'https://meet.google.com/abc-defg-hij', 'google_meet', 'p7-1', ?, ?, ?, 'approved')",
    [ids.admin, ids.P, ago(7)],
  );
  ids.meeting = m.insertId;
  const [m2] = await pool.execute(
    "INSERT INTO meetings (title, meeting_url, platform, native_meeting_id, created_by, project_id, scheduled_at, status) VALUES ('Mobile sync', 'https://meet.google.com/abc-defg-hik', 'google_meet', 'p7-2', ?, ?, ?, 'approved')",
    [ids.admin, ids.Q, ago(5)],
  );
  ids.meetingQ = m2.insertId;
  const [g] = await pool.execute("INSERT INTO integration_connections (provider, source_instance, external_account_id, display_name, status) VALUES ('github', 'github.test', '1', 'GitHub', 'active')");
  ids.github = g.insertId;

  // Payments (manager's project): member has an overdue task, a blocked one, a done one.
  ids.overdue = await task('Ship refund retries', { due: dateAgo(4), priority: 'high' });
  ids.blocked = await task('Wire settlement report', { status: 'blocked' });
  ids.done = await task('Write runbook', { status: 'done' });
  ids.stale = await task('Audit webhook secrets', { updatedDaysAgo: 20, assignee: ids.manager });
  await pool.execute(
    "INSERT INTO activities (dedupe_key, provider, activity_type, entity_type, entity_id, actor_user_id, project_id, occurred_at, summary, origin) VALUES (?, 'workagent', 'completed', 'action_item', ?, ?, ?, ?, 'completed', 'internal')",
    [`workagent:action_item:${ids.done}:completed:1`, ids.done, ids.member, ids.P, ago(2)],
  );
  // Mobile (admin's project, target passed): other's overdue tasks.
  ids.otherOverdue1 = await task('Fix login crash', { projectId: ids.Q, assignee: ids.other, due: dateAgo(10), meetingId: ids.meetingQ });
  ids.otherOverdue2 = await task('Update store listing', { projectId: ids.Q, assignee: ids.other, due: dateAgo(2), meetingId: ids.meetingQ });

  // Synced work in Payments.
  ids.prWaiting = await record('pull_request', { title: 'Retry refunds', createdDaysAgo: 5, metadata: { draft: false, requestedReviewers: [{ id: 1, login: 'octo' }] } });
  ids.prDraft = await record('pull_request', { title: 'WIP: ledger', createdDaysAgo: 9, metadata: { draft: true } });
  ids.prReviewed = await record('pull_request', { title: 'Settlement CSV', createdDaysAgo: 6, metadata: { draft: false } });
  await record('review', { parent: ids.prReviewed, state: 'changes_requested', category: 'unknown', createdDaysAgo: 1 });
  ids.prMerged = await record('pull_request', { title: 'Payout fix', state: 'merged', category: 'done', createdDaysAgo: 4, updatedDaysAgo: 2, metadata: { merged: true, mergedAt: ago(2).toISOString() } });
  ids.issueStale = await record('issue', { title: 'Old flaky test', createdDaysAgo: 40, updatedDaysAgo: 30 });
  ids.issueBlocked = await record('issue', { title: 'Card network outage', metadata: { labels: ['blocked'] } });
  ids.issueDeleted = await record('issue', { title: 'Gone', deleted: true });
  // In Mobile: an issue the Payments task depends on (cross-project, confirmed).
  ids.issueQ = await record('issue', { projectId: ids.Q, title: 'SDK release' });
  await pool.execute(
    "INSERT INTO record_links (from_type, from_id, to_type, to_id, link_type, origin, status, confidence) VALUES ('action_item', ?, 'external_record', ?, 'depends_on', 'manual', 'confirmed', NULL)",
    [ids.blocked, ids.issueQ],
  );

  const [t] = await pool.execute("INSERT INTO teams (name, lead_user_id) VALUES ('Core', ?)", [ids.manager]);
  ids.team = t.insertId;
  await pool.execute('INSERT INTO team_members (team_id, user_id) VALUES (?, ?)', [ids.team, ids.member]);
});
after(closeDatabase);

const projectRow = (body, id) => body.projects.find((p) => p.project.id === id);

describe('insights', () => {
  it('requires sign-in', async () => {
    assert.equal((await request(app).get('/api/v1/insights')).status, 401);
  });

  it('gives admins every project, with health, overdue work, blockers and reviews', async () => {
    const res = await get('admin', '/api/v1/insights');
    assert.equal(res.status, 200);
    const b = res.body;
    assert.equal(b.totals.overdueTasks, 3);
    assert.equal(b.totals.blockedTasks, 1);
    assert.equal(b.totals.completedTasks, 1);
    assert.equal(b.totals.pullRequestsMerged, 1);
    assert.equal(b.totals.openPullRequests, 3);
    assert.equal(b.totals.reviewsWaiting, 1, 'only the non-draft PR without any review');
    assert.equal(b.totals.openIssues, 3, 'deleted records are left out');
    assert.equal(b.overdue[0].task.id, ids.otherOverdue1, 'oldest first');
    assert.equal(b.overdue[0].daysOverdue, 10);

    assert.equal(projectRow(b, ids.Q).health.level, 'off_track', 'target date passed');
    assert.equal(projectRow(b, ids.P).health.level, 'at_risk');
    assert.equal(projectRow(b, ids.P).health.assessment.kind, 'inference');
    assert.ok(projectRow(b, ids.P).health.assessment.rule);
    assert.ok(projectRow(b, ids.P).health.reasons.every((r) => r.kind === 'fact'));

    const stages = Object.fromEntries(b.reviews.queue.map((q) => [q.pullRequest.id, q.stage]));
    assert.equal(stages[ids.prWaiting], 'awaiting_review');
    assert.equal(stages[ids.prReviewed], 'changes_requested');
    assert.equal(stages[ids.prDraft], undefined, 'drafts are not in the review queue');
    assert.deepEqual(b.reviews.queue.find((q) => q.pullRequest.id === ids.prWaiting).requestedReviewers, ['octo']);

    const kinds = b.blockers.map((x) => x.kind).sort();
    assert.deepEqual(kinds, ['dependency', 'record_labelled_blocked', 'task_blocked']);
    const dep = b.dependencies[0];
    assert.equal(dep.blocker.id, ids.issueQ);
    assert.equal(dep.blocked.id, ids.blocked);
    assert.equal(dep.crossProject, true);

    assert.ok(b.stalled.some((s) => s.item.type === 'external_record' && s.item.id === ids.issueStale));
    assert.ok(b.stalled.some((s) => s.item.type === 'action_item' && s.item.id === ids.stale));
    const ft = b.followThrough.find((m) => m.meeting.id === ids.meeting);
    assert.deepEqual([ft.tasks, ft.done, ft.overdue], [4, 1, 1]);
    assert.ok(b.highlights.length > 0);
    assert.ok(b.highlights.every((h) => ['fact', 'inference'].includes(h.kind)));
    assert.ok(b.highlights.filter((h) => h.kind === 'inference').every((h) => h.rule));
    assert.ok(b.trend.some((w) => w.tasksCompleted === 1));
  });

  it('limits managers to projects they own or belong to', async () => {
    const res = await get('manager', '/api/v1/insights');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.projects.map((p) => p.project.id), [ids.P]);
    assert.equal(res.body.totals.overdueTasks, 1);
    // The dependency's blocker lives in a project the manager cannot see.
    assert.equal(res.body.dependencies.length, 0);
    assert.ok(res.body.workload.some((w) => w.user.id === ids.member));
    assert.equal((await get('manager', `/api/v1/insights?projectId=${ids.Q}`)).status, 404);
  });

  it('gives employees only their own tasks and their projects’ records', async () => {
    const res = await get('member', '/api/v1/insights');
    assert.equal(res.status, 200);
    const b = res.body;
    assert.deepEqual(b.workload.map((w) => w.user.id), [ids.member]);
    assert.ok(b.overdue.every((o) => o.assignee.id === ids.member));
    assert.equal(b.totals.openTasks, 2, 'the manager’s own task is not visible to the member');
    assert.ok(b.reviews.queue.length > 0, 'records of a project they belong to');
    assert.equal(projectRow(b, ids.Q), undefined);
    assert.equal((await get('member', `/api/v1/insights?projectId=${ids.Q}`)).status, 404);
    const other = await get('other', '/api/v1/insights');
    assert.deepEqual(other.body.workload.map((w) => w.user.id), [ids.other]);
    assert.equal(other.body.reviews.queue.length, 0);
  });

  it('filters by project, team and period', async () => {
    const p = await get('admin', `/api/v1/insights?projectId=${ids.P}`);
    assert.deepEqual(p.body.projects.map((x) => x.project.id), [ids.P]);
    assert.equal(p.body.totals.overdueTasks, 1);

    const t = await get('admin', `/api/v1/insights?teamId=${ids.team}`);
    assert.deepEqual(new Set(t.body.workload.map((w) => w.user.id)), new Set([ids.member, ids.manager]), 'members plus the lead');
    assert.equal(t.body.totals.overdueTasks, 1);
    assert.equal((await get('other', `/api/v1/insights?teamId=${ids.team}`)).status, 404, 'not a member of the team');

    const old = await get('admin', `/api/v1/insights?from=${ago(120).toISOString()}&to=${ago(60).toISOString()}`);
    assert.equal(old.body.totals.completedTasks, 0);
    assert.equal(old.body.totals.pullRequestsMerged, 0);
    assert.equal(old.body.followThrough.length, 0);
  });

  it('validates filters', async () => {
    assert.equal((await get('admin', `/api/v1/insights?from=${ago(1).toISOString()}&to=${ago(5).toISOString()}`)).status, 400);
    assert.equal((await get('admin', `/api/v1/insights?from=${ago(800).toISOString()}&to=${ago(1).toISOString()}`)).status, 400);
    assert.equal((await get('admin', '/api/v1/insights?from=yesterday')).status, 400);
    assert.equal((await get('admin', '/api/v1/insights?projectId=999999')).status, 404);
    assert.equal((await get('admin', '/api/v1/insights?unknown=1')).status, 400);
  });

  it('reports an empty scope plainly', async () => {
    const lonely = await createUser({ email: 'lonely@p7.test', role: 'employee', fullName: 'Lonely' });
    assert.ok(lonely);
    const cookie = await loginCookie(app, 'lonely@p7.test');
    const res = await request(app).get('/api/v1/insights').set('Cookie', cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.projects.length, 0);
    assert.equal(res.body.totals.openTasks, 0);
    assert.deepEqual(res.body.highlights.map((h) => h.text), ['Nothing overdue, blocked or waiting in view']);
  });
});
