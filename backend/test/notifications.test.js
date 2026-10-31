// Phase 10: the signed-in person's profile, password and preferences; in-app notifications, what
// creates them (assignment, overdue scan, suggestions, integration and job failures) and who gets them.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/transaction.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext } from '../src/jobs/runner.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as resources from '../src/repositories/integrationResourcesRepository.js';
import { PROVIDER_ERROR_KINDS } from '../src/services/integrations/errors.js';
import { ingest } from '../src/services/integrations/ingest.js';
import { fakeService, resetFakeService } from '../src/services/integrations/providers/fake/index.js';
import { syncEngine } from '../src/services/integrations/sync.js';
import { recordAudit } from '../src/services/audit.js';
import { notify } from '../src/services/notifications/inbox.js';
import { notifyIntegrationError, notifySuggestions, scan, sendDigests } from '../src/services/notifications/triggers.js';
import { PASSWORD, closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const NEW_PASSWORD = 'another-long-password-1';

const get = (who, url) => request(app).get(`/api/v1${url}`).set('Cookie', cookies[who]);
const send = (who, method, url, body) => request(app)[method](`/api/v1${url}`).set('Cookie', cookies[who]).send(body);
const rows = async (userId, kind) => (await pool.query('SELECT * FROM notifications WHERE user_id = ? AND kind = ? ORDER BY id', [userId, kind]))[0];

async function meeting(status = 'approved') {
  const [m] = await pool.query("INSERT INTO meetings (title, meeting_url, status, scheduled_at, created_by) VALUES ('Launch sync', 'https://meet.google.com/abc-defg-hij', ?, '2026-11-04 10:00:00', ?)", [status, ids.admin]);
  return m.insertId;
}
async function item(meetingId, assignee, { due = null, task = 'todo', review = 'approved', projectId = null, title = 'Send the deck' } = {}) {
  const [r] = await pool.query(
    "INSERT INTO action_items (meeting_id, project_id, title, description, assignee_user_id, assignee_match, due_date, priority, review_status, task_status, flags, review_details, ai_confidence) VALUES (?, ?, ?, 'Do it', ?, 'exact', ?, 'medium', ?, ?, '[]', '{}', 0.9)",
    [meetingId, projectId, title, assignee, due, review, task],
  );
  return r.insertId;
}

before(async () => {
  await resetDatabase();
  for (const [key, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['manager2', 'manager'],
    ['ana', 'employee'],
    ['ben', 'employee'],
    ['limited', 'employee'],
  ]) {
    ids[key] = await createUser({ email: `${key}@n.test`, role, fullName: `N ${key}` });
    cookies[key] = await loginCookie(app, `${key}@n.test`);
  }
  const project = async (name, owner) => (await pool.query("INSERT INTO projects (name, owner_user_id, status) VALUES (?, ?, 'active')", [name, owner]))[0].insertId;
  ids.P = await project('Payments', ids.manager);
  ids.P2 = await project('Payments 2', ids.manager);
  ids.Q = await project('Mobile', ids.manager2);
});
after(closeDatabase);
beforeEach(async () => {
  resetFakeService();
  await pool.query('DELETE FROM notifications');
  await pool.query('DELETE FROM user_preferences');
  await pool.query('DELETE FROM jobs');
  await pool.query('DELETE FROM meetings');
});

describe('profile', () => {
  it('needs a session and returns no secrets', async () => {
    assert.equal((await request(app).get('/api/v1/me/profile')).status, 401);
    const res = await get('ana', '/me/profile');
    assert.equal(res.status, 200);
    assert.equal(res.body.profile.email, 'ana@n.test');
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('hash'));
  });

  it('offers admin-only notification kinds to admins only', async () => {
    const kinds = async (who) => (await get(who, '/me/profile')).body.notificationKinds.map((k) => k.kind);
    assert.deepEqual(await kinds('ana'), ['task_assigned', 'task_overdue', 'daily_digest']);
    assert.ok((await kinds('manager')).includes('suggestions'));
    assert.ok(!(await kinds('manager')).includes('jobs_dead'));
    assert.ok((await kinds('admin')).includes('jobs_dead'));
  });

  it('changes the name only, and audits it', async () => {
    const res = await send('ben', 'patch', '/me/profile', { fullName: 'Ben Okafor' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.fullName, 'Ben Okafor');
    assert.equal((await send('ben', 'patch', '/me/profile', { role: 'admin' })).status, 400);
    assert.equal((await get('ben', '/me/profile')).body.profile.role, 'employee');
    const [[audit]] = await pool.query("SELECT actor_user_id FROM audit_logs WHERE action = 'user.profile_updated' AND entity_id = ?", [ids.ben]);
    assert.equal(audit.actor_user_id, ids.ben);
  });
});

describe('password change', () => {
  it('refuses a wrong current password, a reused password and a short one', async () => {
    const change = (body) => send('ana', 'post', '/me/password', body);
    assert.equal((await change({ currentPassword: 'wrong', newPassword: NEW_PASSWORD })).body.error.code, 'INVALID_PASSWORD');
    assert.equal((await change({ currentPassword: PASSWORD, newPassword: PASSWORD })).body.error.code, 'SAME_PASSWORD');
    assert.equal((await change({ currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
  });

  it('keeps this session, ends the others and replaces the password', async () => {
    const other = await loginCookie(app, 'manager2@n.test');
    const res = await send('manager2', 'post', '/me/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    assert.deepEqual(res.body, { changed: true, otherSessionsSignedOut: 1 });
    assert.equal((await get('manager2', '/me/profile')).status, 200);
    assert.equal((await request(app).get('/api/v1/me/profile').set('Cookie', other)).status, 401);
    const login = (password) => request(app).post('/api/v1/auth/login').send({ email: 'manager2@n.test', password });
    assert.equal((await login(PASSWORD)).status, 401);
    assert.equal((await login(NEW_PASSWORD)).status, 200);
    const [[audit]] = await pool.query("SELECT * FROM audit_logs WHERE action = 'user.password_changed' AND entity_id = ?", [ids.manager2]);
    assert.ok(audit);
    assert.ok(!JSON.stringify(audit).includes(NEW_PASSWORD));
  });

  it('is throttled per person', async () => {
    const attempt = () => send('limited', 'post', '/me/password', { currentPassword: 'wrong', newPassword: NEW_PASSWORD });
    for (let i = 0; i < 10; i += 1) assert.equal((await attempt()).status, 400);
    assert.equal((await attempt()).status, 429);
    assert.equal((await send('ana', 'post', '/me/password', { currentPassword: 'wrong', newPassword: NEW_PASSWORD })).status, 400);
  });
});

describe('preferences', () => {
  it('defaults to everything on and saves one kind without touching the others', async () => {
    assert.equal((await get('ana', '/me/preferences')).body.preferences.notifications.task_overdue, true);
    const res = await send('ana', 'put', '/me/preferences', { notifications: { task_overdue: false } });
    assert.equal(res.status, 200);
    assert.equal(res.body.preferences.notifications.task_overdue, false);
    assert.equal(res.body.preferences.notifications.task_assigned, true);
  });

  it('refuses unknown kinds, non-booleans and unknown time zones', async () => {
    const put = (body) => send('ana', 'put', '/me/preferences', body);
    assert.equal((await put({ notifications: { nonsense: true } })).status, 400);
    assert.equal((await put({ notifications: { task_overdue: 'no' } })).status, 400);
    assert.equal((await put({ timeZone: 'Mars/Base' })).status, 400);
    assert.equal((await put({ notifications: { jobs_dead: true } })).status, 400, 'not for this role');
    assert.equal((await put({ timeZone: 'Asia/Kolkata' })).body.preferences.timeZone, 'Asia/Kolkata');
  });

  it('a kind turned off creates nothing', async () => {
    await send('ana', 'put', '/me/preferences', { notifications: { task_assigned: false } });
    assert.equal(await notify(pool, { userId: ids.ana, kind: 'task_assigned', title: 'x', dedupeKey: 'off' }), false);
  });
});

describe('inbox', () => {
  const add = (userId, dedupeKey) => notify(pool, { userId, kind: 'task_assigned', title: 'New task', link: '/my/tasks/1', dedupeKey });

  it('never notifies twice for one event, but does per person', async () => {
    assert.equal(await add(ids.ana, 'k'), true);
    assert.equal(await add(ids.ana, 'k'), false);
    assert.equal(await add(ids.ben, 'k'), true);
  });

  it('refuses external links, and gives admin kinds and inactive people nothing', async () => {
    await assert.rejects(notify(pool, { userId: ids.ana, kind: 'task_assigned', title: 'x', link: 'https://evil.test', dedupeKey: 'l' }));
    assert.equal(await notify(pool, { userId: ids.ana, kind: 'jobs_dead', title: 'x', dedupeKey: 'a' }), false);
    assert.equal(await notify(pool, { userId: ids.ana, kind: 'suggestions', title: 'x', dedupeKey: 'a' }), false);
    const gone = await createUser({ email: 'gone@n.test', isActive: false });
    assert.equal(await add(gone, 'g'), false);
  });

  it('lists only your own, pages, counts unread and marks read', async () => {
    for (const k of ['a', 'b', 'c']) await add(ids.ana, k);
    await add(ids.ben, 'b');
    assert.equal((await get('ana', '/me/notifications/unread-count')).body.unread, 3);
    const page = (await get('ana', '/me/notifications?limit=2')).body;
    assert.equal(page.notifications.length, 2);
    const rest = (await get('ana', `/me/notifications?limit=2&before=${page.next}`)).body;
    assert.equal(rest.notifications.length, 1);
    assert.equal(rest.next, null);

    const id = page.notifications[0].id;
    assert.equal((await send('ben', 'post', `/me/notifications/${id}/read`)).body.marked, 0, "someone else's stays unread");
    assert.equal((await send('ana', 'post', `/me/notifications/${id}/read`)).body.marked, 1);
    assert.equal((await get('ana', '/me/notifications?unread=true')).body.notifications.length, 2);
    assert.equal((await send('ana', 'post', '/me/notifications/read-all')).body.marked, 2);
    assert.equal((await get('ana', '/me/notifications/unread-count')).body.unread, 0);
    assert.equal((await get('ben', '/me/notifications/unread-count')).body.unread, 1);
  });
});

describe('task assignment', () => {
  it('tells the assignee when the meeting review completes, once', async () => {
    const m = await meeting('review_pending');
    const t = await item(m, ids.ana, { review: 'pending' });
    assert.equal((await send('admin', 'post', `/action-items/${t}/approve`)).status, 200);
    assert.equal((await rows(ids.ana, 'task_assigned')).length, 0, 'not visible to them yet');
    assert.equal((await send('admin', 'post', `/meetings/${m}/approve`)).status, 200);
    const [n] = await rows(ids.ana, 'task_assigned');
    assert.equal(n.link, `/my/tasks/${t}`);
    await recordAudit(pool, { actorUserId: ids.admin, action: 'meeting.review_completed', entityType: 'meeting', entityId: m });
    assert.equal((await rows(ids.ana, 'task_assigned')).length, 1);
  });

  it('tells only the final assignee when a task is reassigned during review', async () => {
    const m = await meeting('review_pending');
    const t = await item(m, ids.ana);
    assert.equal((await send('admin', 'patch', `/action-items/${t}`, { assigneeUserId: ids.ben })).status, 409, 'approved items are reopened first');
    assert.equal((await send('admin', 'post', `/action-items/${t}/reopen`)).status, 200);
    assert.equal((await send('admin', 'patch', `/action-items/${t}`, { assigneeUserId: ids.ben })).status, 200);
    assert.equal((await send('admin', 'post', `/action-items/${t}/approve`)).status, 200);
    assert.equal((await send('admin', 'post', `/meetings/${m}/approve`)).status, 200);
    assert.equal((await rows(ids.ben, 'task_assigned')).length, 1);
    assert.equal((await rows(ids.ana, 'task_assigned')).length, 0);
  });

  it('stays quiet when you assign yourself or nothing about the assignee changed', async () => {
    const t = await item(await meeting(), ids.ana);
    const updated = (actorUserId, before, after) => recordAudit(pool, { actorUserId, action: 'action_item.updated', entityType: 'action_item', entityId: t, before: { assigneeUserId: before }, after: { assigneeUserId: after } });
    await updated(ids.admin, ids.ana, ids.ana);
    await updated(ids.ana, ids.ben, ids.ana);
    assert.equal((await rows(ids.ana, 'task_assigned')).length, 0);
    await updated(ids.admin, ids.ben, ids.ana);
    assert.equal((await rows(ids.ana, 'task_assigned')).length, 1);
  });

  it('links an admin assignee to the meeting, since they have no My Tasks pages', async () => {
    const m = await meeting();
    await item(m, ids.admin);
    await recordAudit(pool, { actorUserId: ids.manager, action: 'meeting.review_completed', entityType: 'meeting', entityId: m });
    assert.equal((await rows(ids.admin, 'task_assigned'))[0].link, `/admin/meetings/${m}`);
  });
});

describe('blocked tasks', () => {
  const block = (t) => send('ana', 'patch', `/me/tasks/${t}/status`, { status: 'blocked' });
  it('tells the project owner, at most daily, linking to the project', async () => {
    const t = await item(await meeting(), ids.ana, { projectId: ids.P });
    assert.equal((await block(t)).status, 200);
    assert.equal((await rows(ids.manager, 'task_blocked'))[0].link, `/projects/${ids.P}`);
    assert.equal((await rows(ids.admin, 'task_blocked')).length, 0);
    assert.equal((await rows(ids.manager2, 'task_blocked')).length, 0, 'not another project owner');
    await send('ana', 'patch', `/me/tasks/${t}/status`, { status: 'in_progress' });
    await block(t);
    assert.equal((await rows(ids.manager, 'task_blocked')).length, 1);
  });
  it('tells admins when the task has no project', async () => {
    const m = await meeting();
    const t = await item(m, ids.ana);
    await block(t);
    assert.equal((await rows(ids.admin, 'task_blocked'))[0].link, `/admin/meetings/${m}`);
  });
  it('does not fire for other status changes', async () => {
    const t = await item(await meeting(), ids.ana, { projectId: ids.P });
    await send('ana', 'patch', `/me/tasks/${t}/status`, { status: 'in_progress' });
    assert.equal((await rows(ids.manager, 'task_blocked')).length, 0);
  });
});

describe('daily summary', () => {
  const at = (iso) => new Date(iso);
  it('arrives once per local day from 9:00 in the person\'s time zone', async () => {
    await item(await meeting(), ids.ana, { due: '2020-01-01' });
    await send('ana', 'put', '/me/preferences', { timeZone: 'Asia/Kolkata' });
    await sendDigests(at('2026-11-04T03:00:00Z')); // 08:30 in Kolkata
    assert.equal((await rows(ids.ana, 'daily_digest')).length, 0);
    await sendDigests(at('2026-11-04T04:00:00Z')); // 09:30
    const [first] = await rows(ids.ana, 'daily_digest');
    assert.match(first.body, /^1 open task \(1 overdue, 0 due today\) · 0 unread notifications$/);
    assert.equal(first.link, '/my/tasks');
    await sendDigests(at('2026-11-04T10:00:00Z'));
    assert.equal((await rows(ids.ana, 'daily_digest')).length, 1);
    await sendDigests(at('2026-11-05T04:00:00Z'));
    assert.equal((await rows(ids.ana, 'daily_digest')).length, 2);
  });
  it('falls back to the company time zone, skips people with nothing to report, and can be turned off', async () => {
    await item(await meeting(), ids.ana);
    await sendDigests(at('2026-11-04T08:59:00Z'));
    assert.equal((await rows(ids.ana, 'daily_digest')).length, 0, 'before 9:00 UTC');
    await sendDigests(at('2026-11-04T09:00:00Z'));
    assert.equal((await rows(ids.ana, 'daily_digest')).length, 1);
    assert.equal((await rows(ids.ben, 'daily_digest')).length, 0, 'nothing to report');
    await send('ana', 'put', '/me/preferences', { notifications: { daily_digest: false } });
    await sendDigests(at('2026-11-05T09:00:00Z'));
    assert.equal((await rows(ids.ana, 'daily_digest')).length, 1);
  });
});

describe('overdue scan', () => {
  it('tells assignee and project owner, once, and skips work that is done or not visible', async () => {
    const m = await meeting();
    const t = await item(m, ids.ana, { due: '2020-01-01', projectId: ids.P });
    await item(m, ids.ana, { due: '2020-01-01', task: 'done' });
    await item(m, ids.ana, { due: '2020-01-01', review: 'pending' });
    await item(await meeting('review_pending'), ids.ana, { due: '2020-01-01' });
    assert.equal((await scan()).overdue, 2);
    assert.equal((await rows(ids.ana, 'task_overdue'))[0].link, `/my/tasks/${t}`);
    assert.equal((await rows(ids.manager, 'task_overdue'))[0].link, `/projects/${ids.P}`);
    assert.equal((await scan()).overdue, 0);
  });

  it('notifies again when the due date moves and passes again', async () => {
    const t = await item(await meeting(), ids.ana, { due: '2020-01-01' });
    await scan();
    await pool.query("UPDATE action_items SET due_date = '2020-02-01' WHERE id = ?", [t]);
    assert.equal((await scan()).overdue, 1);
  });

  it('uses the same "today" as the task pages: due today is not overdue', async () => {
    await item(await meeting(), ids.ana, { due: '2026-11-04' });
    assert.equal((await scan(new Date('2026-11-04T12:00:00Z'))).overdue, 0);
    assert.equal((await scan(new Date('2026-11-05T12:00:00Z'))).overdue, 1);
  });

  it('reaches every task of a backlog larger than one batch', async () => {
    const m = await meeting();
    const values = Array.from({ length: 501 }, () => [m, 'Old task', ids.ben, 'exact', '2020-01-01', 'medium', 'approved', 'todo', '[]']);
    await pool.query('INSERT INTO action_items (meeting_id, title, assignee_user_id, assignee_match, due_date, priority, review_status, task_status, flags) VALUES ?', [values]);
    assert.equal((await scan()).overdue, 501);
  });
});

describe('job failure notifications', () => {
  const job = (status, lastError = 'Error: boom') => pool.query("INSERT INTO jobs (type, payload, status, last_error) VALUES ('ai.extract', '{}', ?, ?)", [status, lastError]);

  it('reports dead jobs to admins, at most daily', async () => {
    await job('dead');
    assert.equal((await scan()).dead, 1);
    assert.equal((await rows(ids.admin, 'jobs_dead'))[0].link, '/admin/operations?tab=jobs&status=dead');
    assert.equal((await rows(ids.manager, 'jobs_dead')).length, 0);
    assert.equal((await scan()).dead, 0);
  });

  it('reports jobs that failed for good, linking to them', async () => {
    await job('failed');
    assert.equal((await scan()).dead, 1);
    assert.equal((await rows(ids.admin, 'jobs_dead'))[0].link, '/admin/operations?tab=jobs&status=failed');
  });

  it('does not report jobs an admin cancelled, or old failures', async () => {
    await job('failed', 'Cancelled by admin@n.test');
    const [old] = await job('dead');
    await pool.query('UPDATE jobs SET updated_at = NOW() - INTERVAL 2 DAY WHERE id = ?', [old.insertId]);
    assert.equal((await scan()).dead, 0);
  });

  it('the hourly job runs the scan, and Operations can retry it', async () => {
    await item(await meeting(), ids.ana, { due: '2020-01-01' });
    const id = await queue.enqueue('notifications.scan', {}, { dedupeKey: 'notifications.scan' });
    assert.equal(await processNext('w', handlersFor(['notifications.scan'])), true);
    assert.equal((await rows(ids.ana, 'task_overdue')).length, 1);
    await pool.query("UPDATE jobs SET status = 'dead', dedupe_key = NULL WHERE id = ?", [id]);
    assert.equal((await send('admin', 'post', `/ops/jobs/${id}/retry`)).status, 200);
  });
});

describe('suggestion notifications', () => {
  const who = async () => (await pool.query("SELECT user_id FROM notifications WHERE kind = 'suggestions' ORDER BY user_id"))[0].map((r) => r.user_id);

  it('tells admins and the manager of both ends, at most daily', async () => {
    assert.equal(await notifySuggestions(pool, [[ids.P, ids.P2]]), 2);
    assert.deepEqual(await who(), [ids.admin, ids.manager].sort((a, b) => a - b));
    assert.equal(await notifySuggestions(pool, [[ids.P, ids.P2]]), 0);
  });

  it('leaves out a manager who could not decide it: other project, or no project on one end', async () => {
    await notifySuggestions(pool, [[ids.P, ids.Q], [ids.P, null]]);
    assert.deepEqual(await who(), [ids.admin]);
  });

  describe('from the correlation job', () => {
    const correlate = async () => {
      const connectionId = await connections.create(pool, { provider: 'github', sourceInstance: 'github.test', externalAccountId: 'n-org', displayName: 'GH', status: 'active' });
      const resourceId = await resources.upsert(pool, connectionId, { resourceType: 'repository', externalId: 'n1', name: 'n-org/api' });
      await resources.update(pool, resourceId, { isEnabled: true, projectId: ids.P });
      const resource = await resources.findById(resourceId);
      await item(await meeting(), ids.ana, { projectId: ids.P, title: 'Refund escalation retry handling' });
      const now = new Date().toISOString();
      await withTransaction((conn) => ingest(conn, {
        connector: { id: 'github', sourceInstance: 'github.test' },
        connection: { id: connectionId },
        resource,
        origin: 'sync',
        envelopes: [{ type: 'record', recordType: 'issue', externalId: 'n-77', externalKey: 'n-org/api#77', title: 'Refund escalation retry handling', state: 'open', statusCategory: 'todo', sourceCreatedAt: now, sourceUpdatedAt: now }],
      }));
      const handlers = handlersFor(['correlation.evaluate']);
      while (await processNext('w', handlers));
      const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM record_links WHERE status = 'suggested'");
      const [[{ failed }]] = await pool.query("SELECT COUNT(*) AS failed FROM jobs WHERE status IN ('failed', 'dead')");
      return { suggestions: n, failed };
    };
    after(async () => {
      for (const t of ['record_links', 'activities', 'external_records', 'integration_resources', 'integration_connections']) await pool.query(`DELETE FROM ${t}`);
    });
    beforeEach(async () => {
      for (const t of ['record_links', 'activities', 'external_records', 'integration_resources', 'integration_connections']) await pool.query(`DELETE FROM ${t}`);
    });

    it('notifies those who can decide', async () => {
      const r = await correlate();
      assert.ok(r.suggestions >= 1);
      assert.equal(r.failed, 0);
      assert.deepEqual(await who(), [ids.admin, ids.manager].sort((a, b) => a - b));
    });

    it('keeps the suggestions when notifying fails', async () => {
      await pool.query('RENAME TABLE notifications TO notifications_moved');
      try {
        const r = await correlate();
        assert.ok(r.suggestions >= 1);
        assert.equal(r.failed, 0);
      } finally {
        await pool.query('RENAME TABLE notifications_moved TO notifications');
      }
    });
  });
});

describe('integration failure notifications', () => {
  const OTHER_KIND = Object.keys(PROVIDER_ERROR_KINDS).find((k) => !['rate_limited', 'transient', 'auth', 'suspended', 'not_found'].includes(k));
  let connectionId;
  let resourceId;

  beforeEach(async () => {
    connectionId = await connections.create(pool, { provider: 'fake', sourceInstance: 'fake.test', externalAccountId: `fake-${Date.now()}`, displayName: 'Fake', status: 'active' });
    resourceId = await resources.upsert(pool, connectionId, { resourceType: 'repository', externalId: '101', name: 'fake-org/api' });
    await resources.update(pool, resourceId, { isEnabled: true, nextSyncAt: new Date(Date.now() - 1000) });
  });
  const failSync = async (kind) => {
    fakeService.failNext.syncStream = kind;
    await syncEngine.syncResource(resourceId).catch(() => {});
    return rows(ids.admin, 'integration_error');
  };
  const cleanUp = async () => {
    await pool.query('DELETE FROM activities');
    await pool.query('DELETE FROM external_records');
    await pool.query('DELETE FROM integration_resources');
    await pool.query('DELETE FROM integration_connections');
  };

  for (const kind of ['auth', 'suspended', OTHER_KIND]) {
    it(`tells admins, once a day, about a ${kind} failure`, async () => {
      const [n] = await failSync(kind);
      assert.equal(n.title, 'Fake needs attention');
      assert.equal(n.link, `/admin/integrations/${connectionId}`);
      assert.equal((await rows(ids.manager, 'integration_error')).length, 0);
      assert.equal(await notifyIntegrationError({ id: connectionId, provider: 'fake', displayName: 'Fake' }, 'again'), 0);
      await cleanUp();
    });
  }

  it('stays quiet about passing trouble: transient errors and rate limits', async () => {
    assert.equal((await failSync('transient')).length, 0);
    await resources.update(pool, resourceId, { nextSyncAt: new Date(Date.now() - 1000) });
    assert.equal((await failSync('rate_limited')).length, 0);
    await cleanUp();
  });
});
