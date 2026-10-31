// What creates notifications (Phase 10). Called from the audit hook (in the change's own
// transaction), the correlation job, the sync engine and the hourly notifications.scan job.
// Each uses a dedupe key, so retries and repeated scans never notify twice.
import { config } from '../../config/index.js';
import { pool } from '../../db/pool.js';
import { localDate } from '../../utils/dates.js';
import { VISIBLE_MEETING_STATUSES } from '../tasks.js';
import { getPreferences, notify, notifyAdmins } from './inbox.js';

const SCAN_BATCH = 500;
const DIGEST_HOUR = 9;

// The app's "today", the same one the task pages use to call a task overdue.
const today = (now = new Date()) => localDate(now, config.extraction.timezone);

// Admins have no My Tasks pages (the router sends them away), so their link is the meeting.
const taskLink = (t) => (t.assignee_role === 'admin' ? `/admin/meetings/${t.meeting_id}` : `/my/tasks/${t.id}`);

async function task(conn, id) {
  const [[row]] = await conn.query(
    `SELECT ai.id, ai.meeting_id, ai.title, ai.assignee_user_id, u.role AS assignee_role, ai.review_status, ai.task_status, ai.project_id, ai.due_date, m.status AS meeting_status, m.title AS meeting_title
     FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id LEFT JOIN users u ON u.id = ai.assignee_user_id WHERE ai.id = ?`,
    [id],
  );
  return row ?? null;
}

/** A task the assignee can see (approved, meeting review finished): tell them, once per assignment. */
async function assigned(conn, t, actorUserId) {
  if (!t?.assignee_user_id || t.assignee_user_id === actorUserId) return false;
  if (t.review_status !== 'approved' || !VISIBLE_MEETING_STATUSES.includes(t.meeting_status)) return false;
  return notify(conn, {
    userId: t.assignee_user_id,
    kind: 'task_assigned',
    title: `New task: ${t.title}`,
    body: `From “${t.meeting_title}”${t.due_date ? `, due ${String(t.due_date instanceof Date ? t.due_date.toISOString() : t.due_date).slice(0, 10)}` : ''}`,
    link: taskLink(t),
    entityType: 'action_item',
    entityId: t.id,
    dedupeKey: `task:${t.id}`,
  });
}

/** A task was marked blocked: tell whoever manages its project (no project: admins). */
async function blocked(conn, id, actorUserId) {
  const [[t]] = await conn.query(
    'SELECT ai.id, ai.meeting_id, ai.title, ai.project_id, p.owner_user_id, p.name AS project_name FROM action_items ai LEFT JOIN projects p ON p.id = ai.project_id WHERE ai.id = ?',
    [id],
  );
  if (!t) return;
  const dedupeKey = `task:${t.id}:${today()}`;
  const base = { kind: 'task_blocked', entityType: 'action_item', entityId: t.id, dedupeKey };
  if (!t.project_id) {
    await notifyAdmins(conn, { ...base, title: `Blocked: ${t.title}`, link: `/admin/meetings/${t.meeting_id}` });
  } else if (t.owner_user_id !== actorUserId) {
    await notify(conn, { ...base, userId: t.owner_user_id, title: `Blocked in ${t.project_name}: ${t.title}`, link: `/projects/${t.project_id}` });
  }
}

/** Audit hook: assignments become visible when a meeting's review completes or a task is (re)assigned; tasks get blocked. */
export async function notifyForAudit(conn, { action, entityId, actorUserId, before, after }) {
  if (action === 'task.status_changed') {
    if (after?.taskStatus === 'blocked') await blocked(conn, entityId, actorUserId);
    return;
  }
  if (action === 'meeting.review_completed') {
    const [items] = await conn.query("SELECT id FROM action_items WHERE meeting_id = ? AND review_status = 'approved' AND assignee_user_id IS NOT NULL", [entityId]);
    for (const { id } of items) await assigned(conn, await task(conn, id), actorUserId);
    return;
  }
  if (action === 'action_item.approved' || (action === 'action_item.updated' && (before?.assigneeUserId ?? null) !== (after?.assigneeUserId ?? null))) {
    await assigned(conn, await task(conn, entityId), actorUserId);
  }
}

/**
 * After a correlation run produced suggestions: tell the people who can decide them (daily).
 * `projectPairs` holds [from, to] project ids per suggestion. Same rule as canEditLinkBetween:
 * admins decide any suggestion, a manager only when they own the projects of both ends.
 */
export async function notifySuggestions(conn, projectPairs, now = new Date()) {
  const [admins] = await conn.query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE");
  const recipients = new Set(admins.map((a) => a.id));
  const ids = [...new Set(projectPairs.flat().filter(Boolean))];
  if (ids.length) {
    const [rows] = await conn.query("SELECT p.id, p.owner_user_id FROM projects p JOIN users u ON u.id = p.owner_user_id WHERE p.id IN (?) AND u.role = 'manager'", [ids]);
    const owner = new Map(rows.map((r) => [r.id, r.owner_user_id]));
    for (const [from, to] of projectPairs) {
      if (owner.has(from) && owner.get(from) === owner.get(to)) recipients.add(owner.get(from));
    }
  }
  let n = 0;
  for (const userId of recipients) {
    if (await notify(conn, { userId, kind: 'suggestions', title: 'New relationship suggestions to review', body: 'WorkAgent found records that may be related.', link: '/suggestions', dedupeKey: `day:${today(now)}` })) n += 1;
  }
  return n;
}

/** The sync engine found a problem on a connection that a person has to look at. */
export function notifyIntegrationError(connection, message, now = new Date()) {
  return notifyAdmins(pool, {
    kind: 'integration_error',
    title: `${connection.displayName ?? connection.provider} needs attention`,
    body: message,
    link: `/admin/integrations/${connection.id}`,
    entityType: 'integration_connection',
    entityId: connection.id,
    dedupeKey: `conn:${connection.id}:${today(now)}`,
  });
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const localHour = (now, timeZone) => Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));

/**
 * The daily summary: once per local day per person, from DIGEST_HOUR in their time zone (their
 * preference, else the company's), and only when there is something to report.
 */
export async function sendDigests(now = new Date()) {
  const [people] = await pool.query('SELECT id, role FROM users WHERE is_active = TRUE');
  let sent = 0;
  for (const person of people) {
    const { timeZone } = await getPreferences(person.id);
    const zone = timeZone ?? config.extraction.timezone;
    if (localHour(now, zone) < DIGEST_HOUR) continue;
    const day = localDate(now, zone);
    const [[work]] = await pool.query(
      `SELECT COUNT(*) AS open, COALESCE(SUM(ai.due_date < ?), 0) AS overdue, COALESCE(SUM(ai.due_date = ?), 0) AS due_today
       FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id
       WHERE ai.assignee_user_id = ? AND ai.review_status = 'approved' AND ai.task_status <> 'done' AND m.status IN (?)`,
      [day, day, person.id, VISIBLE_MEETING_STATUSES],
    );
    const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL', [person.id]);
    const open = Number(work.open);
    if (!open && !Number(unread)) continue;
    const parts = [`${plural(open, 'open task')} (${Number(work.overdue)} overdue, ${Number(work.due_today)} due today)`, plural(Number(unread), 'unread notification')];
    if (await notify(pool, { userId: person.id, kind: 'daily_digest', title: 'Your daily summary', body: parts.join(' · '), link: person.role === 'admin' ? '/notifications' : '/my/tasks', dedupeKey: `day:${day}` })) sent += 1;
  }
  return sent;
}

/** Hourly: overdue tasks (assignee and project owner), jobs that ended unsuccessfully (admins) and daily summaries. */
export async function scan(now = new Date()) {
  const day = today(now);
  const stats = { overdue: 0, dead: 0, digests: 0 };
  // In id order, in batches, so a large backlog can't keep later tasks from being reached.
  let lastId = 0;
  for (;;) {
    const [overdue] = await pool.query(
      `SELECT ai.id, ai.meeting_id, ai.project_id, ai.title, ai.assignee_user_id, u.role AS assignee_role, ai.due_date, p.owner_user_id, p.name AS project_name
       FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id LEFT JOIN projects p ON p.id = ai.project_id LEFT JOIN users u ON u.id = ai.assignee_user_id
       WHERE ai.review_status = 'approved' AND ai.task_status <> 'done' AND ai.due_date < ? AND m.status IN (?) AND ai.id > ?
       ORDER BY ai.id LIMIT ?`,
      [day, VISIBLE_MEETING_STATUSES, lastId, SCAN_BATCH],
    );
    for (const t of overdue) {
      const due = String(t.due_date instanceof Date ? t.due_date.toISOString() : t.due_date).slice(0, 10);
      const base = { kind: 'task_overdue', entityType: 'action_item', entityId: t.id, dedupeKey: `task:${t.id}:${due}` };
      if (t.assignee_user_id && (await notify(pool, { ...base, userId: t.assignee_user_id, title: `Overdue: ${t.title}`, body: `It was due ${due}.`, link: taskLink(t) }))) stats.overdue += 1;
      if (t.owner_user_id && t.owner_user_id !== t.assignee_user_id && (await notify(pool, { ...base, userId: t.owner_user_id, title: `Overdue in ${t.project_name}: ${t.title}`, body: `It was due ${due}.`, link: `/projects/${t.project_id}` }))) stats.overdue += 1;
    }
    if (overdue.length < SCAN_BATCH) break;
    lastId = overdue[overdue.length - 1].id;
  }
  // 'failed' also holds jobs an admin cancelled (ops.js); those aren't failures to report.
  const [[jobs]] = await pool.query(
    "SELECT COUNT(*) AS n, SUM(status = 'dead') AS dead FROM jobs WHERE (status = 'dead' OR (status = 'failed' AND (last_error IS NULL OR last_error NOT LIKE 'Cancelled by %'))) AND updated_at >= ?",
    [new Date(now - 86_400_000)],
  );
  if (Number(jobs.n) > 0) {
    stats.dead = await notifyAdmins(pool, { kind: 'jobs_dead', title: `${jobs.n} background job(s) failed for good`, body: 'See Operations; retry once the cause is fixed.', link: `/admin/operations?tab=jobs&status=${Number(jobs.dead) > 0 ? 'dead' : 'failed'}`, dedupeKey: `day:${day}` });
  }
  stats.digests = await sendDigests(now);
  return stats;
}
