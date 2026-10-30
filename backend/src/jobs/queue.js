// MySQL-backed job queue (PLANNING.md §1): enqueue / claim / complete / fail with backoff.
//
// - Claiming uses SELECT ... FOR UPDATE SKIP LOCKED inside a short transaction, so several
//   workers can poll the same table without taking the same job.
// - Handlers run outside any transaction; the claimed row is only "leased" via locked_by and
//   locked_at, which a heartbeat keeps fresh. A worker that dies leaves a stale lease that
//   recoverStaleJobs() returns to the queue.
// - dedupe_key is unique while a job is active and cleared once it finishes, so the same
//   operation can't be queued twice concurrently but can be queued again later.
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';
import { logger } from '../utils/logger.js';

const MAX_BACKOFF_MS = 30 * 60 * 1000;
const MAX_ERROR_LENGTH = 2000;

/** Error a handler throws to stop retrying (bad input, missing data, configuration problems). */
export class PermanentJobError extends Error {
  constructor(message, { cause, publicMessage } = {}) {
    super(message, { cause });
    this.retryable = false;
    this.publicMessage = publicMessage ?? message;
  }
}

/**
 * Thrown by a handler that wants to run again later without it counting as a failure
 * (e.g. polling an external service that isn't finished yet).
 */
export class RescheduleJob extends Error {
  constructor(delayMs, reason = 'not ready yet') {
    super(reason);
    this.delayMs = delayMs;
  }
}

export const toJob = (row) => ({
  id: row.id,
  type: row.type,
  payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  dedupeKey: row.dedupe_key,
  status: row.status,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  runAt: row.run_at,
  lockedAt: row.locked_at,
  lockedBy: row.locked_by,
  lastError: row.last_error,
});

const truncate = (s) => (s && s.length > MAX_ERROR_LENGTH ? `${s.slice(0, MAX_ERROR_LENGTH)}…` : s);

/** Delay before attempt n+1 after n failed attempts: base * 2^(n-1), ±20% jitter, capped. */
export function backoffMs(attempts, base = config.jobs.backoffBaseMs) {
  const exp = Math.min(base * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(exp * (0.8 + Math.random() * 0.4));
}

/**
 * Inserts a job. Pass `conn` to enqueue inside a caller's transaction.
 * Returns the job id, or throws ER_DUP_ENTRY if an active job has the same dedupeKey.
 */
export async function enqueue(type, payload, { dedupeKey = null, maxAttempts = config.jobs.maxAttempts, conn = pool, delayMs = 0 } = {}) {
  const [result] = await conn.execute(
    `INSERT INTO jobs (type, payload, dedupe_key, max_attempts, status, run_at)
     VALUES (?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? SECOND))`,
    [type, JSON.stringify(payload), dedupeKey, maxAttempts, Math.max(0, Math.ceil(delayMs / 1000))],
  );
  return result.insertId;
}

export async function findActiveByDedupeKey(dedupeKey, conn = pool) {
  const [rows] = await conn.execute(
    "SELECT * FROM jobs WHERE dedupe_key = ? AND status IN ('pending','running')",
    [dedupeKey],
  );
  return rows[0] ? toJob(rows[0]) : null;
}

export async function findById(id) {
  const [rows] = await pool.execute('SELECT * FROM jobs WHERE id = ?', [id]);
  return rows[0] ? toJob(rows[0]) : null;
}

/** Atomically leases the next due job for `workerId`, or returns null. */
export async function claimNext(workerId, types) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const typeFilter = types?.length ? 'AND type IN (?)' : '';
    const [rows] = await conn.query(
      `SELECT * FROM jobs
       WHERE status = 'pending' AND run_at <= NOW() ${typeFilter}
       ORDER BY run_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      types?.length ? [types] : [],
    );
    if (rows.length === 0) {
      await conn.commit();
      return null;
    }
    const row = rows[0];
    await conn.execute(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = NOW(), locked_by = ?
       WHERE id = ?`,
      [workerId, row.id],
    );
    await conn.commit();
    return toJob({ ...row, status: 'running', attempts: row.attempts + 1, locked_by: workerId });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Refreshes the lease. Returns false if this worker no longer owns the job. */
export async function heartbeat(job) {
  const [result] = await pool.execute(
    "UPDATE jobs SET locked_at = NOW() WHERE id = ? AND locked_by = ? AND status = 'running'",
    [job.id, job.lockedBy],
  );
  return result.affectedRows > 0;
}

export async function complete(job) {
  const [result] = await pool.execute(
    `UPDATE jobs SET status = 'succeeded', dedupe_key = NULL, locked_at = NULL, locked_by = NULL, last_error = NULL
     WHERE id = ? AND locked_by = ? AND status = 'running'`,
    [job.id, job.lockedBy],
  );
  return result.affectedRows > 0;
}

/**
 * Puts a running job back to 'pending' after `delayMs`. The claim's attempt is given back, so
 * only real failures count toward max_attempts. Keeps the dedupe_key (the operation is still active).
 */
export async function reschedule(job, delayMs) {
  const [result] = await pool.execute(
    `UPDATE jobs SET status = 'pending', attempts = GREATEST(attempts - 1, 0), locked_at = NULL, locked_by = NULL,
            last_error = NULL, run_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
     WHERE id = ? AND locked_by = ? AND status = 'running'`,
    [Math.max(0, Math.ceil(delayMs / 1000)), job.id, job.lockedBy],
  );
  return result.affectedRows > 0;
}

/**
 * Records a failed attempt. Retries with backoff while attempts remain and the error is
 * retryable; otherwise marks the job 'failed' (permanent error) or 'dead' (retries exhausted).
 * Returns { final, status, owned }. owned=false means this worker had lost its lease (the job
 * was recovered and possibly re-claimed by another worker), so nothing was recorded.
 */
export async function fail(job, err) {
  const retryable = err?.retryable !== false;
  const final = !retryable || job.attempts >= job.maxAttempts;
  const status = final ? (retryable ? 'dead' : 'failed') : 'pending';
  const message = truncate(`${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`);

  let result;
  if (final) {
    [result] = await pool.execute(
      `UPDATE jobs SET status = ?, dedupe_key = NULL, locked_at = NULL, locked_by = NULL, last_error = ?
       WHERE id = ? AND locked_by = ? AND status = 'running'`,
      [status, message, job.id, job.lockedBy],
    );
  } else {
    const delaySeconds = Math.ceil(backoffMs(job.attempts) / 1000);
    [result] = await pool.execute(
      `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, last_error = ?,
              run_at = DATE_ADD(NOW(), INTERVAL ? SECOND)
       WHERE id = ? AND locked_by = ? AND status = 'running'`,
      [message, delaySeconds, job.id, job.lockedBy],
    );
  }
  return { final, status, owned: result.affectedRows > 0 };
}

/**
 * Returns jobs whose lease expired (worker crashed or was killed) to the queue.
 * Jobs that already used all attempts are marked dead and returned so the caller can run
 * the handler's failure hook.
 */
export async function recoverStaleJobs(staleAfterMs = config.jobs.staleAfterMs) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM jobs
       WHERE status = 'running' AND locked_at < DATE_SUB(NOW(), INTERVAL ? SECOND)
       FOR UPDATE SKIP LOCKED`,
      [Math.ceil(staleAfterMs / 1000)],
    );
    const dead = [];
    for (const row of rows) {
      const message = `Lease expired (worker ${row.locked_by} stopped responding)`;
      if (row.attempts >= row.max_attempts) {
        await conn.execute(
          `UPDATE jobs SET status = 'dead', dedupe_key = NULL, locked_at = NULL, locked_by = NULL, last_error = ?
           WHERE id = ?`,
          [message, row.id],
        );
        dead.push(toJob({ ...row, status: 'dead', last_error: message }));
      } else {
        await conn.execute(
          `UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, last_error = ?, run_at = NOW()
           WHERE id = ?`,
          [message, row.id],
        );
      }
    }
    await conn.commit();
    if (rows.length) logger.warn('recovered stale jobs', { requeued: rows.length - dead.length, dead: dead.length });
    return { requeued: rows.length - dead.length, dead };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
