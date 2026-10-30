// Projects and project membership (Phase 2).
import { pool } from '../db/pool.js';
import { VISIBLE_MEETING_STATUSES } from '../services/tasks.js';

export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'archived'];

const toPerson = (id, fullName, email, isActive) =>
  id ? { id, fullName, email, isActive: Boolean(isActive) } : null;

export const toProject = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  status: row.status,
  ownerUserId: row.owner_user_id,
  owner: toPerson(row.owner_user_id, row.owner_full_name, row.owner_email, row.owner_is_active),
  startDate: row.start_date,
  targetDate: row.target_date,
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  memberCount: Number(row.member_count ?? 0),
  meetingCount: Number(row.meeting_count ?? 0),
  openTaskCount: Number(row.open_task_count ?? 0),
});

// DATE_FORMAT keeps the dates plain calendar dates (no timezone shifting).
const SELECT = `
  SELECT p.id, p.name, p.description, p.status, p.owner_user_id, p.created_by, p.created_at, p.updated_at,
         DATE_FORMAT(p.start_date, '%Y-%m-%d') AS start_date, DATE_FORMAT(p.target_date, '%Y-%m-%d') AS target_date,
         o.full_name AS owner_full_name, o.email AS owner_email, o.is_active AS owner_is_active,
         (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count,
         (SELECT COUNT(*) FROM meetings m WHERE m.project_id = p.id) AS meeting_count,
         (SELECT COUNT(*) FROM action_items ai
           WHERE ai.project_id = p.id AND ai.review_status = 'approved' AND ai.task_status <> 'done') AS open_task_count
  FROM projects p JOIN users o ON o.id = p.owner_user_id`;

/** visibleTo: a user id to restrict to projects they own or belong to; null = all (admin). */
export async function list({ visibleTo = null, status, includeArchived = false, q } = {}) {
  const where = [];
  const params = [];
  if (visibleTo !== null) {
    where.push('(p.owner_user_id = ? OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = ?))');
    params.push(visibleTo, visibleTo);
  }
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  } else if (!includeArchived) {
    where.push("p.status <> 'archived'");
  }
  if (q) {
    where.push('p.name LIKE ?');
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const [rows] = await pool.query(
    `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY FIELD(p.status, 'active', 'planning', 'on_hold', 'completed', 'archived'), p.name`,
    params,
  );
  return rows.map(toProject);
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.query(`${SELECT} WHERE p.id = ?`, [id]);
  return rows[0] ? toProject(rows[0]) : null;
}

/** Locks the project row for the rest of the transaction. */
export async function lock(conn, id) {
  const [rows] = await conn.query('SELECT id FROM projects WHERE id = ? FOR UPDATE', [id]);
  return rows.length > 0;
}

export async function create(conn, { name, description, status, ownerUserId, startDate, targetDate, createdBy }) {
  const [result] = await conn.execute(
    `INSERT INTO projects (name, description, status, owner_user_id, start_date, target_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, description ?? null, status ?? 'planning', ownerUserId, startDate ?? null, targetDate ?? null, createdBy],
  );
  return result.insertId;
}

const UPDATABLE = {
  name: 'name',
  description: 'description',
  status: 'status',
  ownerUserId: 'owner_user_id',
  startDate: 'start_date',
  targetDate: 'target_date',
};

export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([key, value]) => UPDATABLE[key] && value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${UPDATABLE[key]} = ?`).join(', ');
  await conn.execute(`UPDATE projects SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
}

// ---------- membership ----------

export async function isMember(projectId, userId, conn = pool) {
  const [rows] = await conn.execute('SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  return rows.length > 0;
}

export const toMember = (row) => ({
  id: row.id,
  fullName: row.full_name,
  email: row.email,
  role: row.role,
  isActive: Boolean(row.is_active),
  addedAt: row.added_at,
  addedBy: row.added_by_name ? { id: row.added_by, fullName: row.added_by_name } : null,
});

// Deactivated members stay listed (isActive=false) so history keeps its context.
export async function listMembers(projectId, conn = pool) {
  const [rows] = await conn.execute(
    `SELECT u.id, u.full_name, u.email, u.role, u.is_active, pm.added_at, pm.added_by, a.full_name AS added_by_name
     FROM project_members pm JOIN users u ON u.id = pm.user_id LEFT JOIN users a ON a.id = pm.added_by
     WHERE pm.project_id = ? ORDER BY u.is_active DESC, u.full_name`,
    [projectId],
  );
  return rows.map(toMember);
}

/** Adds users (ignoring ones already in the project). Returns the ids that were newly added. */
export async function addMembers(conn, projectId, userIds, addedBy) {
  if (userIds.length === 0) return [];
  const [existing] = await conn.query('SELECT user_id FROM project_members WHERE project_id = ? AND user_id IN (?)', [projectId, userIds]);
  const have = new Set(existing.map((r) => r.user_id));
  const fresh = userIds.filter((id) => !have.has(id));
  if (fresh.length) {
    await conn.query('INSERT INTO project_members (project_id, user_id, added_by) VALUES ?', [fresh.map((id) => [projectId, id, addedBy])]);
  }
  return fresh;
}

// Only the membership row goes; meetings, tasks and audit history are untouched.
export async function removeMember(conn, projectId, userId) {
  const [result] = await conn.execute('DELETE FROM project_members WHERE project_id = ? AND user_id = ?', [projectId, userId]);
  return result.affectedRows > 0;
}

// ---------- associated work ----------

export async function listMeetings(projectId) {
  const [rows] = await pool.execute(
    `SELECT m.id, m.title, m.status, m.scheduled_at, m.created_at,
            (SELECT COUNT(*) FROM action_items ai WHERE ai.meeting_id = m.id) AS item_count,
            (SELECT COUNT(*) FROM action_items ai WHERE ai.meeting_id = m.id AND ai.review_status = 'approved') AS approved_count
     FROM meetings m WHERE m.project_id = ?
     ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC, m.id DESC`,
    [projectId],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    scheduledAt: r.scheduled_at,
    createdAt: r.created_at,
    itemCount: Number(r.item_count),
    approvedCount: Number(r.approved_count),
  }));
}

const TASK_SELECT = `
  SELECT ai.id, ai.title, ai.priority, ai.review_status, ai.task_status, ai.updated_at,
         DATE_FORMAT(ai.due_date, '%Y-%m-%d') AS due_date,
         u.id AS assignee_id, u.full_name AS assignee_full_name, u.email AS assignee_email, u.is_active AS assignee_is_active,
         m.id AS meeting_id, m.title AS meeting_title, m.scheduled_at AS meeting_scheduled_at
  FROM action_items ai
  JOIN meetings m ON m.id = ai.meeting_id
  LEFT JOIN users u ON u.id = ai.assignee_user_id`;

const toProjectTask = (r) => ({
  id: r.id,
  title: r.title,
  priority: r.priority,
  reviewStatus: r.review_status,
  taskStatus: r.task_status,
  dueDate: r.due_date,
  updatedAt: r.updated_at,
  assignee: toPerson(r.assignee_id, r.assignee_full_name, r.assignee_email, r.assignee_is_active),
  meeting: { id: r.meeting_id, title: r.meeting_title, scheduledAt: r.meeting_scheduled_at },
});

/**
 * Tasks of a project. onlyAssignee = a user id: just that person's tasks, and only the ones the
 * employee portal would show them (approved, meeting review finished). null = every item.
 */
export async function listTasks(projectId, { onlyAssignee = null } = {}) {
  const scope = onlyAssignee === null
    ? ''
    : " AND ai.assignee_user_id = ? AND ai.review_status = 'approved' AND m.status IN (?)";
  const [rows] = await pool.query(
    `${TASK_SELECT} WHERE ai.project_id = ?${scope}
     ORDER BY FIELD(ai.review_status, 'pending', 'approved', 'rejected'), ai.due_date IS NULL, ai.due_date, ai.id`,
    onlyAssignee === null ? [projectId] : [projectId, onlyAssignee, VISIBLE_MEETING_STATUSES],
  );
  return rows.map(toProjectTask);
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** Project-level audit entries, newest first. */
export async function activity(projectId, limit = 50) {
  const [rows] = await pool.query(
    `SELECT a.id, a.action, a.created_at, a.before_json, a.after_json, u.id AS actor_id, u.full_name AS actor_name
     FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.entity_type = 'project' AND a.entity_id = ?
     ORDER BY a.id DESC LIMIT ?`,
    [projectId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    at: r.created_at,
    actor: r.actor_id ? { id: r.actor_id, fullName: r.actor_name } : null,
    before: parse(r.before_json),
    after: parse(r.after_json),
  }));
}
