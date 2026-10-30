// Phase 2: server-side session revocation (logout, deactivation, legacy tokens).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { config } from '../src/config/index.js';
import { pool } from '../src/db/pool.js';
import { sha256 } from '../src/services/authService.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
let adminId;
let employeeId;

before(async () => {
  await resetDatabase();
  adminId = await createUser({ email: 'admin@example.test', role: 'admin' });
  employeeId = await createUser({ email: 'emp@example.test', role: 'employee' });
});
after(closeDatabase);

const me = (cookie) => request(app).get('/api/v1/auth/me').set('Cookie', cookie);
const tokenOf = (cookie) => cookie.split(';')[0].slice('mta_session='.length);

describe('sessions', () => {
  it('stores only a hash of the session id, with ip and expiry', async () => {
    const cookie = await loginCookie(app, 'emp@example.test');
    const { sid } = jwt.decode(tokenOf(cookie));
    assert.ok(sid && sid.length >= 40, 'token carries a random session id');
    const [rows] = await pool.query('SELECT * FROM user_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [employeeId]);
    assert.equal(rows[0].sid_hash, sha256(sid));
    assert.notEqual(rows[0].sid_hash, sid);
    assert.equal(rows[0].revoked_at, null);
    assert.ok(new Date(rows[0].expires_at) > new Date());
  });

  it('logout revokes the session: the same token is refused afterwards', async () => {
    const cookie = await loginCookie(app, 'emp@example.test');
    assert.equal((await me(cookie)).status, 200);

    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', cookie);
    assert.equal(out.status, 204);

    // A copy of the old cookie (e.g. kept by an attacker) no longer works.
    const res = await me(cookie);
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'UNAUTHENTICATED');
    const { sid } = jwt.decode(tokenOf(cookie));
    const [[row]] = await pool.query('SELECT revoked_at, revoked_reason FROM user_sessions WHERE sid_hash = ?', [sha256(sid)]);
    assert.ok(row.revoked_at);
    assert.equal(row.revoked_reason, 'logout');
  });

  it('logout only ends the current session, not the user’s other sessions', async () => {
    const laptop = await loginCookie(app, 'emp@example.test');
    const phone = await loginCookie(app, 'emp@example.test');
    await request(app).post('/api/v1/auth/logout').set('Cookie', laptop);
    assert.equal((await me(laptop)).status, 401);
    assert.equal((await me(phone)).status, 200);
  });

  it('refuses a validly signed token whose session row does not exist', async () => {
    const forged = jwt.sign({ sub: String(employeeId), sid: 'x'.repeat(43) }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    assert.equal((await me(`mta_session=${forged}`)).status, 401);
  });

  it('refuses pre-Phase-2 tokens without a session id (documented: users sign in again once)', async () => {
    const legacy = jwt.sign({ sub: String(employeeId) }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    assert.equal((await me(`mta_session=${legacy}`)).status, 401);
  });

  it('refuses a session that expired server-side', async () => {
    const cookie = await loginCookie(app, 'emp@example.test');
    const { sid } = jwt.decode(tokenOf(cookie));
    await pool.query('UPDATE user_sessions SET expires_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE sid_hash = ?', [sha256(sid)]);
    assert.equal((await me(cookie)).status, 401);
  });

  it('refuses a session id that belongs to a different user', async () => {
    const cookie = await loginCookie(app, 'emp@example.test');
    const { sid } = jwt.decode(tokenOf(cookie));
    const swapped = jwt.sign({ sub: String(adminId), sid }, config.jwt.secret, { algorithm: 'HS256', expiresIn: '1h' });
    assert.equal((await me(`mta_session=${swapped}`)).status, 401);
  });
});

describe('deactivation', () => {
  it('revokes every session of the user and blocks protected data immediately', async () => {
    const id = await createUser({ email: 'leaver@example.test', role: 'employee' });
    const a = await loginCookie(app, 'leaver@example.test');
    const b = await loginCookie(app, 'leaver@example.test');
    const admin = await loginCookie(app, 'admin@example.test');

    const res = await request(app).delete(`/api/v1/users/${id}`).set('Cookie', admin);
    assert.equal(res.status, 204);

    for (const cookie of [a, b]) {
      assert.equal((await me(cookie)).status, 401);
      assert.equal((await request(app).get('/api/v1/me/tasks').set('Cookie', cookie)).status, 401);
      assert.equal((await request(app).get('/api/v1/projects').set('Cookie', cookie)).status, 401);
    }
    const [[{ live }]] = await pool.query('SELECT COUNT(*) AS live FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL', [id]);
    assert.equal(live, 0);

    // Reactivating does not resurrect the old sessions.
    await request(app).patch(`/api/v1/users/${id}`).set('Cookie', admin).send({ isActive: true });
    assert.equal((await me(a)).status, 401);
  });

  it('PATCH isActive=false also revokes sessions', async () => {
    const id = await createUser({ email: 'patched@example.test', role: 'employee' });
    const cookie = await loginCookie(app, 'patched@example.test');
    const admin = await loginCookie(app, 'admin@example.test');
    const res = await request(app).patch(`/api/v1/users/${id}`).set('Cookie', admin).send({ isActive: false });
    assert.equal(res.status, 200);
    const [[{ live }]] = await pool.query('SELECT COUNT(*) AS live FROM user_sessions WHERE user_id = ? AND revoked_at IS NULL', [id]);
    assert.equal(live, 0);
    assert.equal((await me(cookie)).status, 401);
  });

  it('deactivation keeps the user’s history (soft delete)', async () => {
    const [[row]] = await pool.query("SELECT is_active FROM users WHERE email = 'leaver@example.test'");
    assert.ok(row, 'user row is kept');
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'user.deactivated'");
    assert.ok(n >= 1);
  });
});
