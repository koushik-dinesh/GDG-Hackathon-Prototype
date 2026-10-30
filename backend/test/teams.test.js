// Phase 2: teams and team membership, plus the manager role and the people directory.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
  delete: (url) => request(app).delete(url).set('Cookie', cookies[who]),
});

before(async () => {
  await resetDatabase();
  for (const [key, role] of [['admin', 'admin'], ['manager', 'manager'], ['manager2', 'manager'], ['emp', 'employee'], ['emp2', 'employee']]) {
    ids[key] = await createUser({ email: `${key}@example.test`, role, fullName: `${key} person` });
    cookies[key] = await loginCookie(app, `${key}@example.test`);
  }
});
after(closeDatabase);

describe('teams', () => {
  it('a manager creates a team and leads it', async () => {
    const res = await as('manager').post('/api/v1/teams', { name: 'Platform', description: 'Infra', memberIds: [ids.emp] });
    assert.equal(res.status, 201);
    assert.equal(res.body.team.leadUserId, ids.manager);
    assert.deepEqual(res.body.team.members.map((m) => m.id), [ids.emp]);
    assert.equal(res.body.team.permissions.canEdit, true);
    ids.platform = res.body.team.id;
  });

  it('employees cannot create teams; duplicate names are refused', async () => {
    assert.equal((await as('emp').post('/api/v1/teams', { name: 'Rogue' })).status, 403);
    assert.equal((await as('admin').post('/api/v1/teams', { name: 'Platform' })).status, 409);
  });

  it('only admins may choose another lead; leads must be admins or managers', async () => {
    assert.equal((await as('manager').post('/api/v1/teams', { name: 'Other', leadUserId: ids.manager2 })).status, 403);
    assert.equal((await as('admin').post('/api/v1/teams', { name: 'Other', leadUserId: ids.emp })).status, 400);
    const res = await as('admin').post('/api/v1/teams', { name: 'Design', leadUserId: ids.manager2 });
    assert.equal(res.status, 201);
    ids.design = res.body.team.id;
  });

  it('the lead manages membership; another manager or an employee cannot', async () => {
    let res = await as('manager').post(`/api/v1/teams/${ids.platform}/members`, { userIds: [ids.emp2] });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.team.members.map((m) => m.id).sort(), [ids.emp, ids.emp2].sort());

    assert.equal((await as('manager2').post(`/api/v1/teams/${ids.platform}/members`, { userIds: [ids.manager2] })).status, 403);
    assert.equal((await as('manager2').patch(`/api/v1/teams/${ids.platform}`, { name: 'Mine' })).status, 403);
    assert.equal((await as('emp').post(`/api/v1/teams/${ids.platform}/members`, { userIds: [ids.emp2] })).status, 403);
    assert.equal((await as('emp').delete(`/api/v1/teams/${ids.platform}/members/${ids.emp2}`)).status, 403);

    res = await as('manager').delete(`/api/v1/teams/${ids.platform}/members/${ids.emp2}`);
    assert.equal(res.status, 204);
    assert.equal((await as('manager').delete(`/api/v1/teams/${ids.platform}/members/${ids.emp2}`)).status, 404);
  });

  it('the lead edits the team; only an admin changes the lead', async () => {
    let res = await as('manager').patch(`/api/v1/teams/${ids.platform}`, { description: 'Infrastructure' });
    assert.equal(res.status, 200);
    assert.equal(res.body.team.description, 'Infrastructure');
    assert.equal((await as('manager').patch(`/api/v1/teams/${ids.platform}`, { leadUserId: ids.manager2 })).status, 403);
    res = await as('admin').patch(`/api/v1/teams/${ids.platform}`, { leadUserId: ids.manager2 });
    assert.equal(res.status, 200);
    assert.equal(res.body.team.lead.id, ids.manager2);
    await as('admin').patch(`/api/v1/teams/${ids.platform}`, { leadUserId: ids.manager });
  });

  it('employees see only their own teams; managers and admins see all', async () => {
    const names = async (who) => (await as(who).get('/api/v1/teams')).body.teams.map((t) => t.name).sort();
    assert.deepEqual(await names('emp'), ['Platform']);
    assert.deepEqual(await names('emp2'), []);
    assert.deepEqual(await names('manager'), ['Design', 'Platform']);
    assert.equal((await as('emp2').get(`/api/v1/teams/${ids.platform}`)).status, 404);
  });

  it('deactivated members stay listed as inactive and cannot be added again', async () => {
    const temp = await createUser({ email: 'temp@example.test', fullName: 'Temp' });
    await as('manager').post(`/api/v1/teams/${ids.platform}/members`, { userIds: [temp] });
    await as('admin').delete(`/api/v1/users/${temp}`);
    const team = (await as('manager').get(`/api/v1/teams/${ids.platform}`)).body.team;
    assert.equal(team.members.find((m) => m.id === temp).isActive, false);
    assert.equal((await as('manager').post(`/api/v1/teams/${ids.design}/members`, { userIds: [temp] })).status, 403, 'not their team');
    assert.equal((await as('admin').post(`/api/v1/teams/${ids.design}/members`, { userIds: [temp] })).status, 400);
  });

  it('writes audit entries for team changes', async () => {
    const [rows] = await pool.query("SELECT DISTINCT action FROM audit_logs WHERE entity_type = 'team' ORDER BY action");
    assert.deepEqual(rows.map((r) => r.action), ['team.created', 'team.member_removed', 'team.members_added', 'team.updated']);
  });
});

describe('manager role', () => {
  it('an admin can make someone a manager', async () => {
    const res = await as('admin').patch(`/api/v1/users/${ids.emp2}`, { role: 'manager' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'manager');
    await as('admin').patch(`/api/v1/users/${ids.emp2}`, { role: 'employee' });
  });

  it('managers cannot use admin-only APIs (users, meetings, review, emails)', async () => {
    for (const res of [
      await as('manager').get('/api/v1/users'),
      await as('manager').post('/api/v1/users', { email: 'x@example.test', fullName: 'X' }),
      await as('manager').get('/api/v1/meetings'),
      await as('manager').post('/api/v1/action-items/1/approve'),
      await as('manager').post('/api/v1/emails/1/retry'),
    ]) {
      assert.equal(res.status, 403);
    }
  });

  it('managers can read their own tasks through the employee portal', async () => {
    assert.equal((await as('manager').get('/api/v1/me/tasks')).status, 200);
  });

  it('the directory lists active people for admins and managers only', async () => {
    const res = await as('manager').get('/api/v1/directory/users');
    assert.equal(res.status, 200);
    assert.ok(res.body.users.every((u) => Object.keys(u).sort().join() === 'email,fullName,id,role'));
    assert.ok(!res.body.users.some((u) => u.email === 'temp@example.test'), 'inactive excluded');
    assert.equal((await as('emp').get('/api/v1/directory/users')).status, 403);
  });
});
