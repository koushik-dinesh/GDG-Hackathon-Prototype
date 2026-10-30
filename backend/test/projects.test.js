// Phase 2: projects, project membership, permissions, and the meeting/task associations.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { withTransaction } from '../src/db/transaction.js';
import { pool } from '../src/db/pool.js';
import { replacePendingExtracted } from '../src/repositories/actionItemsRepository.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookies[who]).send(body),
  delete: (url) => request(app).delete(url).set('Cookie', cookies[who]),
});

before(async () => {
  await resetDatabase();
  const people = [
    ['admin', 'admin', 'Ada Admin'],
    ['manager', 'manager', 'Mia Manager'],
    ['manager2', 'manager', 'Max Manager'],
    ['emp', 'employee', 'Eve Employee'],
    ['emp2', 'employee', 'Eli Employee'],
    ['outsider', 'employee', 'Oscar Outsider'],
  ];
  for (const [key, role, fullName] of people) {
    ids[key] = await createUser({ email: `${key}@example.test`, role, fullName });
    cookies[key] = await loginCookie(app, `${key}@example.test`);
  }
});
after(closeDatabase);

async function createProject(who, body) {
  const res = await as(who).post('/api/v1/projects', body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project;
}

async function insertItem(meetingId, fields = {}) {
  const [result] = await pool.execute(
    `INSERT INTO action_items (meeting_id, project_id, title, assignee_user_id, assignee_match, priority, review_status, task_status, flags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    [
      meetingId,
      fields.projectId ?? null,
      fields.title ?? 'Item',
      fields.assigneeUserId ?? null,
      fields.assigneeUserId ? 'manual' : 'none',
      fields.priority ?? 'medium',
      fields.reviewStatus ?? 'approved',
      fields.taskStatus ?? 'todo',
    ],
  );
  return result.insertId;
}

describe('creating projects', () => {
  it('a manager creates a project, becomes its owner and first member', async () => {
    const project = await createProject('manager', { name: '  Apollo  ', description: 'Moon launch', startDate: '2026-11-01', targetDate: '2027-03-31' });
    assert.equal(project.name, 'Apollo');
    assert.equal(project.status, 'planning');
    assert.equal(project.ownerUserId, ids.manager);
    assert.equal(project.startDate, '2026-11-01');
    assert.equal(project.targetDate, '2027-03-31');
    assert.deepEqual(project.members.map((m) => m.id), [ids.manager]);
    assert.equal(project.permissions.canEdit, true);
    assert.equal(project.permissions.canChangeOwner, false);
    ids.apollo = project.id;
  });

  it('an admin can create a project owned by a manager, with members', async () => {
    const project = await createProject('admin', { name: 'Borealis', ownerUserId: ids.manager2, memberIds: [ids.emp], status: 'active' });
    assert.equal(project.ownerUserId, ids.manager2);
    assert.deepEqual(project.members.map((m) => m.id).sort(), [ids.manager2, ids.emp].sort());
    ids.borealis = project.id;
  });

  it('employees cannot create projects', async () => {
    const res = await as('emp').post('/api/v1/projects', { name: 'Sneaky' });
    assert.equal(res.status, 403);
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM projects WHERE name = 'Sneaky'");
    assert.equal(n, 0);
  });

  it('unauthenticated requests get 401', async () => {
    assert.equal((await request(app).get('/api/v1/projects')).status, 401);
    assert.equal((await request(app).post('/api/v1/projects').send({ name: 'X' })).status, 401);
  });

  it('validates input', async () => {
    for (const [body, field] of [
      [{ name: '' }, 'name'],
      [{ name: 'Bad dates', startDate: '2026-12-01', targetDate: '2026-11-01' }, 'targetDate'],
      [{ name: 'Bad date', startDate: '2026-02-30' }, 'startDate'],
      [{ name: 'Bad status', status: 'done' }, 'status'],
      [{ name: 'Extra', tenantId: 1 }, ''],
    ]) {
      const res = await as('admin').post('/api/v1/projects', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.ok(res.body.error.details.some((d) => d.field === field), `${field}: ${JSON.stringify(res.body.error.details)}`);
    }
  });

  it('refuses duplicate names and invalid owners', async () => {
    const dup = await as('admin').post('/api/v1/projects', { name: 'Apollo' });
    assert.equal(dup.status, 409);
    const empOwner = await as('admin').post('/api/v1/projects', { name: 'Owned by employee', ownerUserId: ids.emp });
    assert.equal(empOwner.status, 400);
    assert.equal(empOwner.body.error.details[0].field, 'ownerUserId');
    const managerNamesOther = await as('manager').post('/api/v1/projects', { name: 'Gift', ownerUserId: ids.manager2 });
    assert.equal(managerNamesOther.status, 403);
  });
});

describe('visibility', () => {
  it('admins see every project; others only the ones they own or belong to', async () => {
    const names = async (who) => (await as(who).get('/api/v1/projects')).body.projects.map((p) => p.name).sort();
    assert.deepEqual(await names('admin'), ['Apollo', 'Borealis']);
    assert.deepEqual(await names('manager'), ['Apollo']);
    assert.deepEqual(await names('emp'), ['Borealis']);
    assert.deepEqual(await names('outsider'), []);
  });

  it('a project you cannot see is a 404 on every endpoint (existence not revealed)', async () => {
    for (const path of ['', '/members', '/meetings', '/tasks', '/activity']) {
      assert.equal((await as('outsider').get(`/api/v1/projects/${ids.apollo}${path}`)).status, 404, path);
    }
    assert.equal((await as('outsider').patch(`/api/v1/projects/${ids.apollo}`, { name: 'Mine' })).status, 404);
  });

  it('members can read but not change the project', async () => {
    const res = await as('emp').get(`/api/v1/projects/${ids.borealis}`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      { edit: res.body.project.permissions.canEdit, members: res.body.project.permissions.canManageMembers },
      { edit: false, members: false },
    );
    assert.equal((await as('emp').patch(`/api/v1/projects/${ids.borealis}`, { name: 'Renamed' })).status, 403);
    assert.equal((await as('emp').patch(`/api/v1/projects/${ids.borealis}`, { status: 'archived' })).status, 403);
    assert.equal((await as('emp').post(`/api/v1/projects/${ids.borealis}/members`, { userIds: [ids.emp2] })).status, 403);
    assert.equal((await as('emp').delete(`/api/v1/projects/${ids.borealis}/members/${ids.manager2}`)).status, 403);
  });

  it('a manager cannot manage a project owned by another manager, even as a member', async () => {
    await as('admin').post(`/api/v1/projects/${ids.borealis}/members`, { userIds: [ids.manager] });
    assert.equal((await as('manager').get(`/api/v1/projects/${ids.borealis}`)).status, 200);
    assert.equal((await as('manager').patch(`/api/v1/projects/${ids.borealis}`, { description: 'x' })).status, 403);
    await as('admin').delete(`/api/v1/projects/${ids.borealis}/members/${ids.manager}`);
  });
});

describe('updating projects', () => {
  it('the owner edits details and changes status; activity records it', async () => {
    const res = await as('manager').patch(`/api/v1/projects/${ids.apollo}`, { description: 'Updated', status: 'active', targetDate: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.project.description, 'Updated');
    assert.equal(res.body.project.status, 'active');
    assert.equal(res.body.project.targetDate, null);

    const activity = await as('manager').get(`/api/v1/projects/${ids.apollo}/activity`);
    const actions = activity.body.activity.map((a) => a.action);
    assert.ok(actions.includes('project.created'));
    assert.ok(actions.includes('project.status_changed'));
    assert.equal(activity.body.activity[0].actor.fullName, 'Mia Manager');
  });

  it('only an admin can change ownership, and the new owner must be an admin or manager', async () => {
    assert.equal((await as('manager').patch(`/api/v1/projects/${ids.apollo}`, { ownerUserId: ids.manager2 })).status, 403);
    assert.equal((await as('admin').patch(`/api/v1/projects/${ids.apollo}`, { ownerUserId: ids.emp })).status, 400);

    const res = await as('admin').patch(`/api/v1/projects/${ids.apollo}`, { ownerUserId: ids.manager2 });
    assert.equal(res.status, 200);
    assert.equal(res.body.project.ownerUserId, ids.manager2);
    assert.ok(res.body.project.members.some((m) => m.id === ids.manager2), 'new owner becomes a member');
    // The previous owner is now a plain member and loses management rights.
    assert.equal((await as('manager').patch(`/api/v1/projects/${ids.apollo}`, { description: 'x' })).status, 403);
    await as('admin').patch(`/api/v1/projects/${ids.apollo}`, { ownerUserId: ids.manager });
  });

  it('archiving makes a project read-only until it is reactivated', async () => {
    let res = await as('manager').patch(`/api/v1/projects/${ids.apollo}`, { status: 'archived' });
    assert.equal(res.status, 200);
    assert.equal((await as('manager').get('/api/v1/projects')).body.projects.length, 0, 'archived hidden by default');
    assert.equal((await as('manager').get('/api/v1/projects?includeArchived=true')).body.projects.length, 1);

    res = await as('manager').patch(`/api/v1/projects/${ids.apollo}`, { description: 'while archived' });
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'PROJECT_ARCHIVED');
    assert.equal((await as('manager').post(`/api/v1/projects/${ids.apollo}/members`, { userIds: [ids.emp2] })).status, 409);

    res = await as('manager').patch(`/api/v1/projects/${ids.apollo}`, { status: 'active' });
    assert.equal(res.status, 200);
    const actions = (await as('manager').get(`/api/v1/projects/${ids.apollo}/activity`)).body.activity.map((a) => a.action);
    assert.ok(actions.includes('project.archived'));
    assert.ok(actions.includes('project.reactivated'));
  });
});

describe('project membership', () => {
  it('the owner adds and removes members; history is kept', async () => {
    let res = await as('manager').post(`/api/v1/projects/${ids.apollo}/members`, { userIds: [ids.emp, ids.emp2, ids.emp] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.added.sort(), [ids.emp, ids.emp2].sort());
    res = await as('manager').post(`/api/v1/projects/${ids.apollo}/members`, { userIds: [ids.emp] });
    assert.deepEqual(res.body.added, [], 'adding twice is a no-op');

    res = await as('manager').delete(`/api/v1/projects/${ids.apollo}/members/${ids.emp2}`);
    assert.equal(res.status, 204);
    const members = (await as('manager').get(`/api/v1/projects/${ids.apollo}/members`)).body.members.map((m) => m.id);
    assert.ok(!members.includes(ids.emp2));
    assert.equal((await as('manager').delete(`/api/v1/projects/${ids.apollo}/members/${ids.emp2}`)).status, 404);
  });

  it('the owner cannot be removed; inactive users cannot be added', async () => {
    assert.equal((await as('manager').delete(`/api/v1/projects/${ids.apollo}/members/${ids.manager}`)).status, 409);
    const inactive = await createUser({ email: 'inactive@example.test', isActive: false });
    const res = await as('manager').post(`/api/v1/projects/${ids.apollo}/members`, { userIds: [inactive] });
    assert.equal(res.status, 400);
  });

  it('a deactivated member stays listed as inactive (not deleted)', async () => {
    const temp = await createUser({ email: 'temp@example.test', fullName: 'Tia Temp' });
    await as('manager').post(`/api/v1/projects/${ids.apollo}/members`, { userIds: [temp] });
    await as('admin').delete(`/api/v1/users/${temp}`);
    const members = (await as('manager').get(`/api/v1/projects/${ids.apollo}/members`)).body.members;
    const tia = members.find((m) => m.id === temp);
    assert.equal(tia.isActive, false);
  });

  it('a whole team can be added at once (active members only)', async () => {
    const team = await as('admin').post('/api/v1/teams', { name: 'Ops', memberIds: [ids.emp2, ids.outsider] });
    assert.equal(team.status, 201);
    const res = await as('manager').post(`/api/v1/projects/${ids.apollo}/members`, { teamId: team.body.team.id });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.added.sort(), [ids.emp2, ids.outsider].sort());
    await as('manager').delete(`/api/v1/projects/${ids.apollo}/members/${ids.outsider}`);
  });
});

describe('meetings and tasks in projects', () => {
  let meetingId;

  it('an admin can create a meeting in a project; existing meetings without a project keep working', async () => {
    const legacy = await as('admin').post('/api/v1/meetings', { title: 'Legacy sync', meetingUrl: 'https://meet.google.com/aaa-bbbb-ccc' });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.meeting.projectId, null);
    assert.equal(legacy.body.meeting.project, null);
    ids.legacyMeeting = legacy.body.meeting.id;

    const res = await as('admin').post('/api/v1/meetings', { title: 'Apollo kickoff', meetingUrl: 'https://meet.google.com/abc-defg-hij', projectId: ids.apollo });
    assert.equal(res.status, 201);
    assert.equal(res.body.meeting.project.name, 'Apollo');
    meetingId = res.body.meeting.id;

    const list = await as('admin').get(`/api/v1/meetings?projectId=${ids.apollo}`);
    assert.deepEqual(list.body.meetings.map((m) => m.id), [meetingId]);
    const none = await as('admin').get('/api/v1/meetings?projectId=none');
    assert.deepEqual(none.body.meetings.map((m) => m.id), [ids.legacyMeeting]);
  });

  it('refuses linking a meeting to a missing or archived project', async () => {
    assert.equal((await as('admin').patch(`/api/v1/meetings/${ids.legacyMeeting}`, { projectId: 999999 })).status, 400);
    const archived = await createProject('admin', { name: 'Old', ownerUserId: ids.manager, status: 'archived' });
    const res = await as('admin').patch(`/api/v1/meetings/${ids.legacyMeeting}`, { projectId: archived.id });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.details[0].field, 'projectId');
  });

  it('only admins link meetings (managers cannot use the meetings API)', async () => {
    assert.equal((await as('manager').patch(`/api/v1/meetings/${ids.legacyMeeting}`, { projectId: ids.apollo })).status, 403);
  });

  it('extracted and manual items inherit the meeting’s project', async () => {
    await pool.query("UPDATE meetings SET status = 'review_pending' WHERE id = ?", [meetingId]);
    await withTransaction((conn) =>
      replacePendingExtracted(conn, meetingId, null, [
        {
          title: 'AI item', description: null, assigneeNameRaw: 'Eve', assigneeUserId: ids.emp, assigneeMatch: 'exact',
          dueDate: null, dueDateRaw: null, priority: 'high', flags: [], reviewDetails: {}, aiConfidence: 0.9, evidence: [],
        },
      ]),
    );
    const manual = await as('admin').post(`/api/v1/meetings/${meetingId}/action-items`, { title: 'Manual item', assigneeUserId: ids.emp2 });
    assert.equal(manual.status, 201);
    assert.equal(manual.body.actionItem.projectId, ids.apollo);

    const items = (await as('admin').get(`/api/v1/meetings/${meetingId}/action-items`)).body;
    const list = items.actionItems ?? items.items;
    assert.ok(list.every((i) => i.projectId === ids.apollo), JSON.stringify(list.map((i) => i.projectId)));

    // Items of a meeting without a project stay unassigned.
    await pool.query("UPDATE meetings SET status = 'review_pending' WHERE id = ?", [ids.legacyMeeting]);
    const legacyItem = await as('admin').post(`/api/v1/meetings/${ids.legacyMeeting}/action-items`, { title: 'Legacy item' });
    assert.equal(legacyItem.body.actionItem.projectId, null);
  });

  it('the owner sees every project task with review and task status separately', async () => {
    const res = await as('manager').get(`/api/v1/projects/${ids.apollo}/tasks`);
    assert.equal(res.status, 200);
    assert.equal(res.body.scope, 'all');
    const titles = res.body.tasks.map((t) => t.title).sort();
    assert.deepEqual(titles, ['AI item', 'Manual item']);
    const ai = res.body.tasks.find((t) => t.title === 'AI item');
    assert.equal(ai.reviewStatus, 'pending');
    assert.equal(ai.taskStatus, 'todo');
    assert.equal(ai.priority, 'high');
    assert.equal(ai.assignee.fullName, 'Eve Employee');
    assert.equal(ai.meeting.title, 'Apollo kickoff');

    const meetings = await as('manager').get(`/api/v1/projects/${ids.apollo}/meetings`);
    assert.deepEqual(meetings.body.meetings.map((m) => m.title), ['Apollo kickoff']);
    assert.equal(meetings.body.meetings[0].itemCount, 2);
  });

  it('an employee member only sees their own visible tasks (no one else’s, no unreviewed ones)', async () => {
    let res = await as('emp').get(`/api/v1/projects/${ids.apollo}/tasks`);
    assert.equal(res.body.scope, 'mine');
    assert.deepEqual(res.body.tasks, [], 'their item is still pending review');

    await pool.query("UPDATE action_items SET review_status = 'approved' WHERE meeting_id = ?", [meetingId]);
    await pool.query("UPDATE meetings SET status = 'approved' WHERE id = ?", [meetingId]);
    res = await as('emp').get(`/api/v1/projects/${ids.apollo}/tasks`);
    assert.deepEqual(res.body.tasks.map((t) => t.title), ['AI item']);
    assert.ok(res.body.tasks.every((t) => t.assignee.id === ids.emp));

    // The employee portal is unchanged and now shows the project.
    const mine = await as('emp').get('/api/v1/me/tasks');
    assert.deepEqual(mine.body.tasks.map((t) => t.title), ['AI item']);
    assert.equal(mine.body.tasks[0].project.name, 'Apollo');
    const others = await as('emp').get('/api/v1/me/tasks');
    assert.ok(!others.body.tasks.some((t) => t.title === 'Manual item'));
  });

  it('an admin can move a single task to another project in any review state, without touching its statuses', async () => {
    const [[item]] = await pool.query("SELECT id, review_status, task_status FROM action_items WHERE title = 'Manual item'");
    const res = await as('admin').put(`/api/v1/action-items/${item.id}/project`, { projectId: ids.borealis });
    assert.equal(res.status, 200);
    assert.equal(res.body.actionItem.projectId, ids.borealis);
    assert.equal(res.body.actionItem.reviewStatus, item.review_status);
    assert.equal(res.body.actionItem.taskStatus, item.task_status);
    assert.equal((await as('manager').put(`/api/v1/action-items/${item.id}/project`, { projectId: ids.apollo })).status, 403);
    assert.equal((await as('emp').put(`/api/v1/action-items/${item.id}/project`, { projectId: ids.apollo })).status, 403);
  });

  it('changing a meeting’s project moves the items that followed it, not ones moved on purpose', async () => {
    const res = await as('admin').patch(`/api/v1/meetings/${meetingId}`, { projectId: null });
    assert.equal(res.status, 200);
    assert.equal(res.body.meeting.projectId, null);
    const [rows] = await pool.query('SELECT title, project_id FROM action_items WHERE meeting_id = ? ORDER BY title', [meetingId]);
    assert.deepEqual(rows.map((r) => [r.title, r.project_id]), [['AI item', null], ['Manual item', ids.borealis]]);

    const activity = (await as('admin').get(`/api/v1/projects/${ids.apollo}/activity`)).body.activity.map((a) => a.action);
    assert.ok(activity.includes('project.meeting_linked'));
    assert.ok(activity.includes('project.meeting_unlinked'));
  });
});

describe('database constraints', () => {
  it('rejects a target date before the start date at the database level', async () => {
    await assert.rejects(
      pool.execute("INSERT INTO projects (name, owner_user_id, start_date, target_date) VALUES ('Chk', ?, '2026-05-02', '2026-05-01')", [ids.manager]),
      /chk_projects_dates|Check constraint/i,
    );
  });

  it('a user referenced by a project cannot be hard-deleted (history is protected)', async () => {
    await assert.rejects(pool.execute('DELETE FROM users WHERE id = ?', [ids.manager]), /foreign key constraint/i);
  });

  it('a project with meetings cannot be hard-deleted', async () => {
    await pool.query('UPDATE meetings SET project_id = ? WHERE id = ?', [ids.borealis, ids.legacyMeeting]);
    await assert.rejects(pool.execute('DELETE FROM projects WHERE id = ?', [ids.borealis]), /foreign key constraint/i);
  });

  it('project and meeting association columns are nullable and indexed', async () => {
    const [cols] = await pool.query(
      `SELECT TABLE_NAME, IS_NULLABLE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = 'project_id' AND TABLE_NAME IN ('meetings', 'action_items')`,
    );
    assert.deepEqual(cols.map((c) => c.IS_NULLABLE), ['YES', 'YES']);
    const [idx] = await pool.query(
      `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME IN ('idx_meetings_project', 'idx_items_project')`,
    );
    assert.equal(idx.length, 2);
  });

  it('the migration was recorded once and the role enum includes manager', async () => {
    const [[m]] = await pool.query("SELECT COUNT(*) AS n FROM schema_migrations WHERE filename = '004_work_management.sql'");
    assert.equal(m.n, 1);
    const [[col]] = await pool.query(
      "SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'role'",
    );
    assert.equal(col.COLUMN_TYPE, "enum('admin','manager','employee')");
  });
});
