import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { pool } from '../src/db/pool.js';
import * as queue from '../src/jobs/queue.js';
import { recover, runJob } from '../src/jobs/runner.js';
import { closeDatabase, resetDatabase } from './helpers.js';

beforeEach(resetDatabase);
after(closeDatabase);

const jobRow = async (id) => (await pool.query('SELECT * FROM jobs WHERE id = ?', [id]))[0][0];
const makeDue = (id) => pool.query('UPDATE jobs SET run_at = NOW() WHERE id = ?', [id]);

describe('enqueue and dedupe', () => {
  it('rejects a second active job with the same dedupe key, and allows it again once finished', async () => {
    const id = await queue.enqueue('test.job', { n: 1 }, { dedupeKey: 'test:1' });
    await assert.rejects(queue.enqueue('test.job', { n: 2 }, { dedupeKey: 'test:1' }), { code: 'ER_DUP_ENTRY' });
    assert.equal((await queue.findActiveByDedupeKey('test:1')).id, id);

    const job = await queue.claimNext('w1');
    assert.equal(await queue.complete(job), true);
    assert.equal((await jobRow(id)).dedupe_key, null);
    assert.ok(await queue.enqueue('test.job', { n: 3 }, { dedupeKey: 'test:1' }));
  });
});

describe('claiming', () => {
  it('never hands the same job to two concurrent workers (SKIP LOCKED)', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await queue.enqueue('test.job', { i }));
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => queue.claimNext(`w${i}`)));
    const claimed = claims.filter(Boolean).map((j) => j.id);
    assert.equal(new Set(claimed).size, claimed.length, 'no job claimed twice');
    // Any job not claimed in this round is still pending and claimable.
    for (const id of ids.filter((x) => !claimed.includes(x))) assert.equal((await jobRow(id)).status, 'pending');
    const [[{ running }]] = await pool.query("SELECT COUNT(*) AS running FROM jobs WHERE status = 'running'");
    assert.equal(running, claimed.length);
  });

  it('skips jobs that are not due yet and filters by type', async () => {
    const later = await queue.enqueue('test.job', {});
    await pool.query('UPDATE jobs SET run_at = DATE_ADD(NOW(), INTERVAL 1 HOUR) WHERE id = ?', [later]);
    await queue.enqueue('other.job', {});
    assert.equal(await queue.claimNext('w1', ['test.job']), null);
    const job = await queue.claimNext('w1');
    assert.equal(job.type, 'other.job');
    assert.equal(job.attempts, 1);
  });
});

describe('failure handling', () => {
  it('retries retryable errors with growing backoff, then marks the job dead', async () => {
    const id = await queue.enqueue('test.job', {}, { maxAttempts: 2 });
    let job = await queue.claimNext('w1');
    let res = await queue.fail(job, new Error('boom'));
    assert.deepEqual(res, { final: false, status: 'pending', owned: true });
    let row = await jobRow(id);
    assert.equal(row.status, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.last_error, /boom/);
    assert.ok(row.run_at > new Date(Date.now() - 1000), 'scheduled in the future');
    assert.equal(await queue.claimNext('w1'), null, 'not due yet');

    await makeDue(id);
    job = await queue.claimNext('w1');
    res = await queue.fail(job, new Error('boom again'));
    assert.deepEqual(res, { final: true, status: 'dead', owned: true });
    row = await jobRow(id);
    assert.equal(row.status, 'dead');
    assert.equal(row.attempts, 2);
  });

  it('fails permanently on non-retryable errors', async () => {
    const id = await queue.enqueue('test.job', {}, { dedupeKey: 'perm' });
    const job = await queue.claimNext('w1');
    const res = await queue.fail(job, new queue.PermanentJobError('bad input'));
    assert.deepEqual(res, { final: true, status: 'failed', owned: true });
    const row = await jobRow(id);
    assert.equal(row.dedupe_key, null);
    assert.equal(row.attempts, 1);
  });

  it('backoff doubles per attempt within jitter and is capped', () => {
    for (let i = 0; i < 20; i++) {
      const a = queue.backoffMs(1, 1000);
      const b = queue.backoffMs(3, 1000);
      assert.ok(a >= 800 && a <= 1200);
      assert.ok(b >= 3200 && b <= 4800);
    }
    assert.ok(queue.backoffMs(50, 1000) <= 30 * 60 * 1000 * 1.2);
  });

  it('runJob calls the failure hook with final=false, then final=true', async () => {
    const id = await queue.enqueue('test.job', {}, { maxAttempts: 2 });
    const calls = [];
    const handlers = {
      'test.job': {
        run: async () => {
          throw new Error('transient');
        },
        onFailure: async (job, err, { final }) => calls.push(final),
      },
    };
    await runJob(await queue.claimNext('w1'), handlers);
    await makeDue(id);
    await runJob(await queue.claimNext('w1'), handlers);
    assert.deepEqual(calls, [false, true]);
  });
});

describe('leases', () => {
  it('a worker that lost its lease cannot complete or fail the job', async () => {
    await queue.enqueue('test.job', {});
    const job = await queue.claimNext('w1');
    const stolen = { ...job, lockedBy: 'someone-else' };
    assert.equal(await queue.complete(stolen), false);
    assert.equal(await queue.heartbeat(stolen), false);
    assert.equal(await queue.heartbeat(job), true);
  });

  it('a worker that lost its lease cannot fail the job, and its failure hook does not run', async () => {
    const id = await queue.enqueue('test.job', {}, { maxAttempts: 1, dedupeKey: 'lease:1' });
    const job = await queue.claimNext('w1');
    // w1 stalls; its lease expires, the job is recovered and w2 claims it.
    await pool.query('UPDATE jobs SET locked_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE), max_attempts = 2 WHERE id = ?', [id]);
    await recover({});
    const takenOver = await queue.claimNext('w2');
    assert.equal(takenOver.id, id);

    assert.deepEqual(await queue.fail(job, new queue.PermanentJobError('late failure')), { final: true, status: 'failed', owned: false });
    let row = await jobRow(id);
    assert.equal(row.status, 'running', 'the new owner keeps the job');
    assert.equal(row.locked_by, 'w2');
    assert.equal(row.dedupe_key, 'lease:1');

    // Through the runner: the stale worker's error must not trigger the failure hook.
    const hooks = [];
    const result = await runJob(job, {
      'test.job': {
        run: async () => {
          throw new queue.PermanentJobError('late failure');
        },
        onFailure: async (j, err, { final }) => hooks.push(final),
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'lost_lease');
    assert.deepEqual(hooks, []);
    row = await jobRow(id);
    assert.equal(row.status, 'running');
    assert.equal(row.locked_by, 'w2');
  });

  it('recovers jobs from a crashed worker; exhausted ones die and run the failure hook', async () => {
    const a = await queue.enqueue('test.job', { name: 'a' });
    const b = await queue.enqueue('test.job', { name: 'b' }, { maxAttempts: 1 });
    await queue.claimNext('crashed');
    await queue.claimNext('crashed');
    // Simulate the crash: the leases are 10 minutes old and nobody heartbeats.
    await pool.query("UPDATE jobs SET locked_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE status = 'running'");

    const hooks = [];
    const result = await recover({ 'test.job': { run: async () => {}, onFailure: async (job, err, { final }) => hooks.push([job.id, final]) } });
    assert.deepEqual(result, { requeued: 1, dead: 1 });
    assert.equal((await jobRow(a)).status, 'pending');
    assert.equal((await jobRow(b)).status, 'dead');
    assert.deepEqual(hooks, [[b, true]]);

    const again = await queue.claimNext('w2');
    assert.equal(again.id, a);
    assert.equal(again.attempts, 2);
  });

  it('leaves fresh leases alone', async () => {
    await queue.enqueue('test.job', {});
    await queue.claimNext('w1');
    assert.deepEqual(await recover({}), { requeued: 0, dead: 0 });
  });
});
