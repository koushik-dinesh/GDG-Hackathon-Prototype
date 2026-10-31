// Operations center (Phase 8): what the background machinery is doing, for admins. Read-only views
// over jobs, the audit log, e-mail delivery, AI extraction runs and integrations, plus the few
// actions that are safe to take on jobs directly. Nothing here returns secrets: job payloads are
// ids only, e-mail bodies and AI responses are left out, and integration credentials are never read.
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { recordAudit } from './audit.js';
import { withTransaction } from '../db/transaction.js';
import { conflict, notFound } from '../utils/errors.js';

const DAY = 86_400_000;

// Job types an admin may retry or cancel here: their handlers are idempotent and keep no domain
// state of their own. The others have a dedicated action that also resets that state.
export const RETRYABLE = {
  'integration.sync': (p) => `integration.sync:res:${p.resourceId}`,
  'integration.maintenance': () => 'integration.maintenance',
  'correlation.evaluate': (p) => `correlation:${p.type}:${p.id}`,
  'notifications.scan': () => 'notifications.scan',
};
const DOMAIN_ACTION = {
  'email.send': 'Retry the e-mail from the E-mail tab (it also resets the message status).',
  'ai.extract': 'Run extraction again from the meeting page.',
  'integration.webhook': 'Replay the delivery from the integration page.',
  'vexa.poll': 'Restart the meeting bot from the meeting page.',
};

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
const cost = (input, output) => (config.ops.aiPrice ? Math.round(((input * config.ops.aiPrice.input + output * config.ops.aiPrice.output) / 1_000_000) * 100) / 100 : null);

export async function summary(now = new Date()) {
  const [jobs] = await pool.query('SELECT type, status, COUNT(*) AS n FROM jobs GROUP BY type, status');
  const [[oldest]] = await pool.query("SELECT MIN(run_at) AS at FROM jobs WHERE status = 'pending' AND run_at <= NOW()");
  const [running] = await pool.query("SELECT locked_by, COUNT(*) AS n, MIN(locked_at) AS since FROM jobs WHERE status = 'running' GROUP BY locked_by");
  const [[recentFailures]] = await pool.query("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('failed','dead') AND updated_at >= ?", [new Date(now - 7 * DAY)]);
  const [emails] = await pool.query('SELECT status, COUNT(*) AS n FROM email_messages GROUP BY status');
  const [ai] = await pool.query(
    `SELECT status, COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS input, COALESCE(SUM(output_tokens),0) AS output
     FROM extraction_runs WHERE created_at >= ? GROUP BY status`,
    [new Date(now - 30 * DAY)],
  );
  const [connections] = await pool.query("SELECT provider, status, health, last_error_message FROM integration_connections WHERE status <> 'disconnected'");
  const [[webhooks]] = await pool.query("SELECT SUM(status = 'failed') AS failed, SUM(status IN ('received','processing')) AS waiting FROM webhook_deliveries WHERE received_at >= ?", [new Date(now - 7 * DAY)]);

  const byStatus = {};
  const byType = {};
  for (const r of jobs) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + Number(r.n);
    byType[r.type] ??= {};
    byType[r.type][r.status] = Number(r.n);
  }
  const tokens = ai.reduce((t, r) => ({ input: t.input + Number(r.input), output: t.output + Number(r.output) }), { input: 0, output: 0 });
  return {
    generatedAt: now.toISOString(),
    jobs: {
      byStatus,
      byType,
      oldestDueSeconds: oldest?.at ? Math.max(0, Math.round((now - new Date(oldest.at)) / 1000)) : null,
      failedLast7Days: Number(recentFailures.n),
      workers: running.map((r) => ({ worker: r.locked_by, running: Number(r.n), since: r.since })),
    },
    emails: Object.fromEntries(emails.map((r) => [r.status, Number(r.n)])),
    ai: {
      last30Days: Object.fromEntries(ai.map((r) => [r.status, Number(r.n)])),
      tokens,
      costUsd: cost(tokens.input, tokens.output),
      priced: Boolean(config.ops.aiPrice),
    },
    integrations: {
      connections: connections.map((c) => ({ provider: c.provider, status: c.status, health: c.health, problem: c.last_error_message ?? null })),
      webhooksFailedLast7Days: Number(webhooks?.failed ?? 0),
      webhooksWaiting: Number(webhooks?.waiting ?? 0),
    },
  };
}

const page = (rows, limit, key = 'id') => ({ items: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1][key] : null });

export async function listJobs({ status, type, before, limit = 50 }) {
  const where = [];
  const params = [];
  if (status) where.push('status = ?') && params.push(status);
  if (type) where.push('type = ?') && params.push(type);
  if (before) where.push('id < ?') && params.push(before);
  const [rows] = await pool.query(
    `SELECT id, type, status, payload, attempts, max_attempts, run_at, locked_by, last_error, created_at, updated_at
     FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const { items, next } = page(rows, limit);
  return {
    jobs: items.map((r) => ({
      id: r.id,
      type: r.type,
      status: r.status,
      payload: parseJson(r.payload),
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      runAt: r.run_at,
      worker: r.locked_by,
      lastError: r.last_error,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      actions: {
        retry: Boolean(RETRYABLE[r.type]) && ['failed', 'dead'].includes(r.status),
        cancel: Boolean(RETRYABLE[r.type]) && r.status === 'pending',
        instead: ['failed', 'dead'].includes(r.status) ? DOMAIN_ACTION[r.type] ?? null : null,
      },
    })),
    next,
  };
}

async function lockJob(conn, id) {
  const [[row]] = await conn.query('SELECT id, type, status, payload FROM jobs WHERE id = ? FOR UPDATE', [id]);
  if (!row) throw notFound('Job not found');
  return { ...row, payload: parseJson(row.payload) ?? {} };
}

/** Puts a failed or dead job back in the queue with fresh attempts. */
export async function retryJob(id, { actor, ip }) {
  return withTransaction(async (conn) => {
    const job = await lockJob(conn, id);
    if (!RETRYABLE[job.type]) throw conflict(DOMAIN_ACTION[job.type] ?? 'This job type cannot be retried here');
    if (!['failed', 'dead'].includes(job.status)) throw conflict('Only failed or dead jobs can be retried');
    try {
      await conn.execute(
        "UPDATE jobs SET status = 'pending', attempts = 0, run_at = NOW(), locked_at = NULL, locked_by = NULL, dedupe_key = ? WHERE id = ?",
        [RETRYABLE[job.type](job.payload), id],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('The same work is already queued');
      throw err;
    }
    await recordAudit(conn, { actorUserId: actor.id, action: 'job.retried', entityType: 'job', entityId: id, before: { status: job.status }, after: { status: 'pending' }, ip });
    return { id, status: 'pending' };
  });
}

/** Cancels a job that has not started. */
export async function cancelJob(id, { actor, ip }) {
  return withTransaction(async (conn) => {
    const job = await lockJob(conn, id);
    if (!RETRYABLE[job.type]) throw conflict('This job type cannot be cancelled here');
    if (job.status !== 'pending') throw conflict('Only waiting jobs can be cancelled');
    await conn.execute("UPDATE jobs SET status = 'failed', dedupe_key = NULL, last_error = ? WHERE id = ?", [`Cancelled by ${actor.email}`, id]);
    await recordAudit(conn, { actorUserId: actor.id, action: 'job.cancelled', entityType: 'job', entityId: id, before: { status: 'pending' }, after: { status: 'failed' }, ip });
    return { id, status: 'failed' };
  });
}

export async function listAudit({ action, entityType, entityId, actorUserId, from, to, before, limit = 50 }) {
  const where = [];
  const params = [];
  const add = (sql, v) => {
    where.push(sql);
    params.push(v);
  };
  if (action) add(action.endsWith('.') ? 'a.action LIKE ?' : 'a.action = ?', action.endsWith('.') ? `${action}%` : action);
  if (entityType) add('a.entity_type = ?', entityType);
  if (entityId) add('a.entity_id = ?', entityId);
  if (actorUserId) add('a.actor_user_id = ?', actorUserId);
  if (from) add('a.created_at >= ?', from);
  if (to) add('a.created_at <= ?', to);
  if (before) add('a.id < ?', before);
  const [rows] = await pool.query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.actor_user_id, u.full_name AS actor_name, u.email AS actor_email,
            a.before_json, a.after_json, a.ip, a.created_at
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const { items, next } = page(rows, limit);
  return {
    entries: items.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      actor: r.actor_user_id ? { id: r.actor_user_id, name: r.actor_name, email: r.actor_email } : null,
      before: parseJson(r.before_json),
      after: parseJson(r.after_json),
      ip: r.ip,
      createdAt: r.created_at,
    })),
    next,
  };
}

export async function listActions() {
  const [rows] = await pool.query('SELECT action, COUNT(*) AS n FROM audit_logs GROUP BY action ORDER BY action');
  return rows.map((r) => ({ action: r.action, count: Number(r.n) }));
}

export async function listEmails({ status, before, limit = 50 }) {
  const where = [];
  const params = [];
  if (status) where.push('e.status = ?') && params.push(status);
  if (before) where.push('e.id < ?') && params.push(before);
  const [rows] = await pool.query(
    `SELECT e.id, e.meeting_id, m.title AS meeting_title, e.recipient_email, e.subject, e.status, e.provider, e.attempt_count,
            e.last_error, e.next_attempt_at, e.sent_at, e.created_at
     FROM email_messages e JOIN meetings m ON m.id = e.meeting_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const { items, next } = page(rows, limit);
  return {
    emails: items.map((r) => ({
      id: r.id,
      meeting: { id: r.meeting_id, title: r.meeting_title },
      to: r.recipient_email,
      subject: r.subject,
      status: r.status,
      provider: r.provider,
      attempts: r.attempt_count,
      lastError: r.last_error,
      nextAttemptAt: r.next_attempt_at,
      sentAt: r.sent_at,
      createdAt: r.created_at,
    })),
    next,
  };
}

export async function listAiRuns({ status, before, limit = 50 }) {
  const where = [];
  const params = [];
  if (status) where.push('r.status = ?') && params.push(status);
  if (before) where.push('r.id < ?') && params.push(before);
  const [rows] = await pool.query(
    `SELECT r.id, r.meeting_id, m.title AS meeting_title, r.model, r.prompt_version, r.status, r.input_tokens, r.output_tokens,
            r.attempts, r.error, r.created_at, r.started_at, r.finished_at, u.full_name AS requested_by
     FROM extraction_runs r JOIN meetings m ON m.id = r.meeting_id LEFT JOIN users u ON u.id = r.requested_by
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.id DESC LIMIT ?`,
    [...params, limit + 1],
  );
  const { items, next } = page(rows, limit);
  return {
    runs: items.map((r) => ({
      id: r.id,
      meeting: { id: r.meeting_id, title: r.meeting_title },
      model: r.model,
      promptVersion: r.prompt_version,
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.input_tokens !== null && r.output_tokens !== null ? cost(r.input_tokens, r.output_tokens) : null,
      attempts: r.attempts,
      error: r.error,
      requestedBy: r.requested_by,
      createdAt: r.created_at,
      durationSeconds: r.started_at && r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000) : null,
    })),
    priced: Boolean(config.ops.aiPrice),
    next,
  };
}
