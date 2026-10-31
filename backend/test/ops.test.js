// Phase 8: operations center. Admin-only; summaries are counts of real rows; retry/cancel only for
// job types whose re-run is safe (others name their own action); duplicates are refused; every
// action is audited; no e-mail bodies, AI responses or credentials leave the server.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import * as queue from '../src/jobs/queue.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body ?? {}),
});

async function job(type, payload, status, extra = {}) {
  const [r] = await pool.execute('INSERT INTO jobs (type, payload, status, attempts, max_attempts, last_error) VALUES (?, ?, ?, ?, ?, ?)', [type, JSON.stringify(payload), status, extra.attempts ?? 3, 3, extra.error ?? null]);
  return r.insertId;
}

before(async () => {
  await resetDatabase();
  for (const [key, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['member', 'employee'],
  ]) {
    ids[key] = await createUser({ email: `${key}@ops.test`, role, fullName: `Ops ${key}` });
    cookies[key] = await loginCookie(app, `${key}@ops.test`);
  }
  const [m] = await pool.execute("INSERT INTO meetings (title, meeting_url, created_by, status) VALUES ('Weekly', 'https://meet.google.com/abc-defg-hij', ?, 'approved')", [ids.admin]);
  ids.meeting = m.insertId;
  await pool.execute(
    "INSERT INTO email_messages (meeting_id, recipient_user_id, recipient_email, subject, html_body, text_body, idempotency_key, status, last_error) VALUES (?, ?, 'member@ops.test', 'Your action items', '<p>secret body</p>', 'secret body', REPEAT('a',64), 'failed', 'SMTP 550')",
    [ids.meeting, ids.member],
  );
  await pool.execute(
    "INSERT INTO extraction_runs (meeting_id, model, prompt_version, status, input_tokens, output_tokens, raw_response, started_at, finished_at) VALUES (?, 'claude-opus-5-5', 'v3', 'succeeded', 12000, 3000, JSON_OBJECT('text','model output'), NOW() - INTERVAL 40 SECOND, NOW())",
    [ids.meeting],
  );
});
after(closeDatabase);
beforeEach(async () => {
  await pool.query('DELETE FROM jobs');
});

describe('operations center', () => {
  it('is admin-only', async () => {
    for (const who of ['manager', 'member']) assert.equal((await as(who).get('/api/v1/ops/summary')).status, 403);
    assert.equal((await request(app).get('/api/v1/ops/jobs')).status, 401);
  });

  it('summarizes jobs, e-mail, AI usage and integrations from real rows', async () => {
    await job('integration.sync', { resourceId: 1 }, 'dead', { error: 'Provider error' });
    await job('correlation.evaluate', { type: 'external_record', id: 5 }, 'pending', { attempts: 0 });
    await job('email.send', { messageId: 1 }, 'succeeded');
    const res = await as('admin').get('/api/v1/ops/summary');
    assert.equal(res.status, 200);
    const b = res.body;
    assert.deepEqual(b.jobs.byStatus, { dead: 1, pending: 1, succeeded: 1 });
    assert.equal(b.jobs.byType['integration.sync'].dead, 1);
    assert.equal(b.jobs.failedLast7Days, 1);
    assert.deepEqual(b.emails, { failed: 1 });
    assert.deepEqual(b.ai.tokens, { input: 12000, output: 3000 });
    assert.equal(b.ai.costUsd, null, 'no prices configured: no cost is invented');
    assert.equal(b.ai.priced, false);
  });

  it('lists jobs with the actions each allows', async () => {
    const dead = await job('integration.sync', { resourceId: 7 }, 'dead');
    const email = await job('email.send', { messageId: 1 }, 'dead');
    const pending = await job('correlation.evaluate', { type: 'meeting', id: 3 }, 'pending', { attempts: 0 });
    const res = await as('admin').get('/api/v1/ops/jobs');
    const byId = Object.fromEntries(res.body.jobs.map((j) => [j.id, j]));
    assert.deepEqual(byId[dead].actions, { retry: true, cancel: false, instead: null });
    assert.equal(byId[email].actions.retry, false);
    assert.match(byId[email].actions.instead, /E-mail tab/);
    assert.deepEqual(byId[pending].actions, { retry: false, cancel: true, instead: null });
    const filtered = await as('admin').get('/api/v1/ops/jobs?status=dead&type=integration.sync');
    assert.deepEqual(filtered.body.jobs.map((j) => j.id), [dead]);
    assert.equal((await as('admin').get('/api/v1/ops/jobs?status=exploded')).status, 400);
  });

  it('retries a dead job once, refuses duplicates and unsafe types, and audits', async () => {
    const dead = await job('integration.sync', { resourceId: 9 }, 'dead');
    const res = await as('admin').post(`/api/v1/ops/jobs/${dead}/retry`);
    assert.deepEqual([res.status, res.body.job.status], [200, 'pending']);
    const row = (await pool.query('SELECT status, attempts, dedupe_key FROM jobs WHERE id = ?', [dead]))[0][0];
    assert.deepEqual([row.status, row.attempts, row.dedupe_key], ['pending', 0, 'integration.sync:res:9']);
    assert.equal((await as('admin').post(`/api/v1/ops/jobs/${dead}/retry`)).status, 409, 'not failed any more');
    // The same work already queued: a second dead job for it can't be revived as a duplicate.
    const twin = await job('integration.sync', { resourceId: 9 }, 'dead');
    const dup = await as('admin').post(`/api/v1/ops/jobs/${twin}/retry`);
    assert.deepEqual([dup.status, dup.body.error.message], [409, 'The same work is already queued']);
    const email = await job('email.send', { messageId: 1 }, 'failed');
    assert.equal((await as('admin').post(`/api/v1/ops/jobs/${email}/retry`)).status, 409);
    assert.equal((await as('admin').post('/api/v1/ops/jobs/999999/retry')).status, 404);
    const audit = (await pool.query("SELECT actor_user_id FROM audit_logs WHERE action = 'job.retried' AND entity_id = ?", [dead]))[0];
    assert.deepEqual(audit.map((a) => a.actor_user_id), [ids.admin]);
    // The worker can pick it up again.
    const claimed = await queue.claimNext('ops-test', ['integration.sync']);
    assert.equal(claimed.id, dead);
  });

  it('cancels only waiting jobs', async () => {
    const pending = await job('correlation.evaluate', { type: 'meeting', id: 4 }, 'pending', { attempts: 0 });
    const res = await as('admin').post(`/api/v1/ops/jobs/${pending}/cancel`);
    assert.equal(res.status, 200);
    const row = (await pool.query('SELECT status, last_error FROM jobs WHERE id = ?', [pending]))[0][0];
    assert.deepEqual([row.status, row.last_error], ['failed', 'Cancelled by admin@ops.test']);
    assert.equal((await as('admin').post(`/api/v1/ops/jobs/${pending}/cancel`)).status, 409);
    assert.equal((await as('manager').post(`/api/v1/ops/jobs/${pending}/cancel`)).status, 403);
  });

  it('shows the audit log with actors and filters', async () => {
    const res = await as('admin').get('/api/v1/ops/audit?action=job.');
    assert.ok(res.body.entries.every((e) => e.action.startsWith('job.')));
    assert.ok(res.body.entries.some((e) => e.actor?.email === 'admin@ops.test'));
    const actions = await as('admin').get('/api/v1/ops/audit/actions');
    assert.ok(actions.body.actions.some((a) => a.action === 'job.retried'));
    const page1 = await as('admin').get('/api/v1/ops/audit?limit=1');
    assert.equal(page1.body.entries.length, 1);
    assert.ok(page1.body.next);
    const page2 = await as('admin').get(`/api/v1/ops/audit?limit=1&before=${page1.body.next}`);
    assert.ok(page2.body.entries[0].id < page1.body.entries[0].id);
  });

  it('lists e-mail and AI runs without bodies or model output', async () => {
    const emails = await as('admin').get('/api/v1/ops/emails?status=failed');
    assert.deepEqual(emails.body.emails.map((e) => [e.to, e.subject, e.lastError]), [['member@ops.test', 'Your action items', 'SMTP 550']]);
    assert.ok(!JSON.stringify(emails.body).includes('secret body'));
    const runs = await as('admin').get('/api/v1/ops/ai-runs');
    const run = runs.body.runs[0];
    assert.deepEqual([run.model, run.inputTokens, run.outputTokens, run.durationSeconds, run.costUsd], ['claude-opus-5-5', 12000, 3000, 40, null]);
    assert.ok(!JSON.stringify(runs.body).includes('model output'));
  });
});
