// Employee-facing reads/writes of action items. Every query is scoped to the caller's user id
// and to approved items of meetings whose review is finished (see services/tasks.js).
import { pool } from '../db/pool.js';
import { VISIBLE_MEETING_STATUSES } from '../services/tasks.js';

const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

const TASK_SELECT = `
  SELECT ai.id, ai.title, ai.description, ai.priority, ai.task_status, ai.approved_at, ai.updated_at,
         DATE_FORMAT(ai.due_date, '%Y-%m-%d') AS due_date, ai.due_date_raw,
         m.id AS meeting_id, m.title AS meeting_title, m.scheduled_at AS meeting_scheduled_at,
         p.id AS project_id, p.name AS project_name
  FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id LEFT JOIN projects p ON p.id = ai.project_id`;

const SCOPE = `ai.assignee_user_id = ? AND ai.review_status = 'approved' AND m.status IN (?)`;

// No assignee, flags, AI confidence or review details: those are admin-only.
export const toTask = (row) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  priority: row.priority,
  taskStatus: row.task_status,
  dueDate: row.due_date,
  dueDateRaw: row.due_date_raw,
  approvedAt: row.approved_at,
  updatedAt: row.updated_at,
  meeting: { id: row.meeting_id, title: row.meeting_title, scheduledAt: row.meeting_scheduled_at },
  project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
});

export async function listForUser(userId, { status } = {}) {
  const [rows] = await pool.query(
    `${TASK_SELECT} WHERE ${SCOPE}${status ? ' AND ai.task_status = ?' : ''}
     ORDER BY ai.due_date IS NULL, ai.due_date, ai.id`,
    [userId, VISIBLE_MEETING_STATUSES, ...(status ? [status] : [])],
  );
  return rows.map(toTask);
}

/** The task if it belongs to `userId` and is visible; otherwise null. Optionally locks the row. */
export async function findForUser(id, userId, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`${TASK_SELECT} WHERE ai.id = ? AND ${SCOPE}${forUpdate ? ' FOR UPDATE OF ai' : ''}`, [id, userId, VISIBLE_MEETING_STATUSES]);
  return rows[0] ? toTask(rows[0]) : null;
}

export async function setStatus(conn, id, status) {
  await conn.execute('UPDATE action_items SET task_status = ? WHERE id = ?', [status, id]);
}

export async function evidenceFor(id) {
  const [rows] = await pool.execute(
    'SELECT excerpt, speaker, start_sec FROM action_item_evidence WHERE action_item_id = ? ORDER BY start_sec IS NULL, start_sec, id',
    [id],
  );
  return rows.map((r) => ({ excerpt: r.excerpt, speaker: r.speaker, startSec: toNumber(r.start_sec) }));
}

/**
 * History visible to the assignee: approval, the notification email sent to them, and status
 * changes (with the name of who made them). No admin review internals.
 */
export async function historyFor(task, userId) {
  const [changes] = await pool.execute(
    `SELECT a.created_at, a.before_json, a.after_json, u.full_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.entity_type = 'action_item' AND a.entity_id = ? AND a.action = 'task.status_changed'
     ORDER BY a.id`,
    [task.id],
  );
  const [emails] = await pool.execute(
    `SELECT m.sent_at FROM email_messages m JOIN email_message_items emi ON emi.email_message_id = m.id
     WHERE emi.action_item_id = ? AND m.recipient_user_id = ? AND m.status = 'sent'`,
    [task.id, userId],
  );
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const events = [
    ...(task.approvedAt ? [{ type: 'approved', at: task.approvedAt }] : []),
    ...emails.map((e) => ({ type: 'emailed', at: e.sent_at })),
    ...changes.map((c) => ({
      type: 'status_changed',
      at: c.created_at,
      by: c.full_name ?? null,
      from: parse(c.before_json)?.taskStatus ?? null,
      to: parse(c.after_json)?.taskStatus ?? null,
    })),
  ];
  return events.sort((a, b) => new Date(a.at) - new Date(b.at));
}
