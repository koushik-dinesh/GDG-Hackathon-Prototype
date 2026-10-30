// Shared setup for integration tests. Runs against DB_TEST_NAME (NODE_ENV=test).
import request from 'supertest';
import { config } from '../src/config/index.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import * as users from '../src/repositories/usersRepository.js';
import { hashPassword } from '../src/services/authService.js';

if (!config.isTest) throw new Error('Tests must run with NODE_ENV=test');

export const PASSWORD = 'correct-horse-battery-staple';

// The test database is shared and every test file wipes it. Two test runs at the same time
// (e.g. `npm test` in two terminals) would delete each other's rows mid-test and wait on each
// other's row locks. A MySQL advisory lock, held by this process until closeDatabase(),
// makes a second run wait for the first instead.
const LOCK_NAME = `${config.db.database}:test-suite`;
const LOCK_WAIT_SECONDS = 600;
let lockConn = null;

async function lockTestDatabase() {
  if (lockConn) return;
  const conn = await pool.getConnection();
  const [[{ got }]] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [LOCK_NAME, LOCK_WAIT_SECONDS]);
  if (got !== 1) {
    conn.release();
    throw new Error(`Another test run has been using ${config.db.database} for over ${LOCK_WAIT_SECONDS}s`);
  }
  lockConn = conn;
}

export async function resetDatabase() {
  await lockTestDatabase();
  await migrate();
  await pool.query('DELETE FROM meetings'); // cascades to participants, transcripts, segments, runs, items
  await pool.query('DELETE FROM jobs');
  await pool.query('DELETE FROM audit_logs');
  // Projects/teams reference users without cascading (history must survive in the app), so they go first.
  await pool.query('DELETE FROM projects'); // cascades to project_members
  await pool.query('DELETE FROM teams'); // cascades to team_members
  await pool.query('DELETE FROM users'); // cascades to aliases, sessions, invitations
}

export async function createUser({ email, role = 'employee', isActive = true, password = PASSWORD, fullName }) {
  const id = await users.create({
    email,
    fullName: fullName ?? `Test ${role}`,
    role,
    passwordHash: await hashPassword(password),
  });
  if (!isActive) await pool.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [id]);
  return id;
}

/** Logs in through the API and returns the session cookie string. */
export async function loginCookie(app, email, password = PASSWORD) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.headers['set-cookie'].find((c) => c.startsWith('mta_session='));
}

export async function closeDatabase() {
  if (lockConn) {
    await lockConn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
    lockConn.release();
    lockConn = null;
  }
  await pool.end();
}
