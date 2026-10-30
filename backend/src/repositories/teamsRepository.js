// Teams and team membership (Phase 2). A deliberately flat structure: a team has an optional
// lead and members; there is no hierarchy.
import { pool } from '../db/pool.js';

export const toTeam = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  leadUserId: row.lead_user_id,
  lead: row.lead_user_id
    ? { id: row.lead_user_id, fullName: row.lead_full_name, email: row.lead_email, isActive: Boolean(row.lead_is_active) }
    : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  memberCount: Number(row.member_count ?? 0),
});

const SELECT = `
  SELECT t.*, l.full_name AS lead_full_name, l.email AS lead_email, l.is_active AS lead_is_active,
         (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
  FROM teams t LEFT JOIN users l ON l.id = t.lead_user_id`;

/** memberOf: a user id to restrict to that user's teams (and teams they lead); null = all. */
export async function list({ memberOf = null } = {}) {
  const [rows] = await pool.query(
    `${SELECT}
     ${memberOf === null ? '' : 'WHERE t.lead_user_id = ? OR EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = t.id AND tm.user_id = ?)'}
     ORDER BY t.name`,
    memberOf === null ? [] : [memberOf, memberOf],
  );
  return rows.map(toTeam);
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.query(`${SELECT} WHERE t.id = ?`, [id]);
  return rows[0] ? toTeam(rows[0]) : null;
}

export async function lock(conn, id) {
  const [rows] = await conn.query('SELECT id FROM teams WHERE id = ? FOR UPDATE', [id]);
  return rows.length > 0;
}

export async function create(conn, { name, description, leadUserId, createdBy }) {
  const [result] = await conn.execute(
    'INSERT INTO teams (name, description, lead_user_id, created_by) VALUES (?, ?, ?, ?)',
    [name, description ?? null, leadUserId ?? null, createdBy],
  );
  return result.insertId;
}

const UPDATABLE = { name: 'name', description: 'description', leadUserId: 'lead_user_id' };

export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([key, value]) => UPDATABLE[key] && value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${UPDATABLE[key]} = ?`).join(', ');
  await conn.execute(`UPDATE teams SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
}

export async function isMember(teamId, userId) {
  const [rows] = await pool.execute('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]);
  return rows.length > 0;
}

// Deactivated members stay listed (isActive=false); removing them is an explicit admin choice.
export async function listMembers(teamId, conn = pool) {
  const [rows] = await conn.execute(
    `SELECT u.id, u.full_name, u.email, u.role, u.is_active, tm.added_at
     FROM team_members tm JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = ? ORDER BY u.is_active DESC, u.full_name`,
    [teamId],
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name, email: r.email, role: r.role, isActive: Boolean(r.is_active), addedAt: r.added_at }));
}

export async function addMembers(conn, teamId, userIds, addedBy) {
  if (userIds.length === 0) return [];
  const [existing] = await conn.query('SELECT user_id FROM team_members WHERE team_id = ? AND user_id IN (?)', [teamId, userIds]);
  const have = new Set(existing.map((r) => r.user_id));
  const fresh = userIds.filter((id) => !have.has(id));
  if (fresh.length) {
    await conn.query('INSERT INTO team_members (team_id, user_id, added_by) VALUES ?', [fresh.map((id) => [teamId, id, addedBy])]);
  }
  return fresh;
}

export async function removeMember(conn, teamId, userId) {
  const [result] = await conn.execute('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]);
  return result.affectedRows > 0;
}
