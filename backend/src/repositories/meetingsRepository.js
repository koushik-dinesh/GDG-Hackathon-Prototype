import { pool } from '../db/pool.js';

export function toMeeting(row) {
  return {
    id: row.id,
    title: row.title,
    // Optional project (Phase 2). NULL for meetings that belong to no project.
    projectId: row.project_id ?? null,
    project: row.project_id ? { id: row.project_id, name: row.project_name, status: row.project_status } : null,
    meetingUrl: row.meeting_url,
    platform: row.platform,
    nativeMeetingId: row.native_meeting_id,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status,
    languageHint: row.language_hint,
    lastError: row.last_error,
    vexaMeetingId: row.vexa_meeting_id ?? null,
    botStatus: row.bot_status ?? null,
    botReason: row.bot_reason ?? null,
    botRequestedAt: row.bot_requested_at ?? null,
    botCheckedAt: row.bot_checked_at ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    participantCount: row.participant_count === undefined ? undefined : Number(row.participant_count),
    transcriptSegmentCount: row.segment_count === undefined ? undefined : row.segment_count,
  };
}

const LIST_SELECT = `
  SELECT m.*,
         (SELECT COUNT(*) FROM meeting_participants mp WHERE mp.meeting_id = m.id) AS participant_count,
         t.segment_count, p.name AS project_name, p.status AS project_status
  FROM meetings m
  LEFT JOIN transcripts t ON t.meeting_id = m.id
  LEFT JOIN projects p ON p.id = m.project_id`;

export async function list({ status, from, to, q, projectId, limit, offset }) {
  const where = [];
  const params = [];
  // projectId: a project id, or 'none' for meetings without a project.
  if (projectId === 'none') {
    where.push('m.project_id IS NULL');
  } else if (projectId) {
    where.push('m.project_id = ?');
    params.push(projectId);
  }
  if (status) {
    where.push('m.status = ?');
    params.push(status);
  }
  // Date filters apply to the scheduled time, or creation time for unscheduled meetings.
  if (from) {
    where.push('COALESCE(m.scheduled_at, m.created_at) >= ?');
    params.push(from);
  }
  if (to) {
    where.push('COALESCE(m.scheduled_at, m.created_at) < ?');
    params.push(to);
  }
  if (q) {
    where.push('m.title LIKE ?');
    params.push(`%${q.replace(/[\\%_]/g, '\\$&')}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM meetings m ${whereSql}`, params);
  const [rows] = await pool.query(
    `${LIST_SELECT} ${whereSql}
     ORDER BY COALESCE(m.scheduled_at, m.created_at) DESC, m.id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { rows, total };
}

export async function findById(id, conn = pool) {
  const [rows] = await conn.query(`${LIST_SELECT} WHERE m.id = ?`, [id]);
  return rows[0] ?? null;
}

// Locks the meeting row for the rest of the transaction.
export async function findByIdForUpdate(conn, id) {
  const [rows] = await conn.query('SELECT * FROM meetings WHERE id = ? FOR UPDATE', [id]);
  return rows[0] ?? null;
}

export async function create(conn, { title, meetingUrl, scheduledAt, languageHint, projectId, createdBy }) {
  const [result] = await conn.execute(
    `INSERT INTO meetings (title, project_id, meeting_url, scheduled_at, language_hint, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, 'draft')`,
    [title, projectId ?? null, meetingUrl, scheduledAt ?? null, languageHint ?? null, createdBy],
  );
  return result.insertId;
}

const UPDATABLE = {
  title: 'title',
  projectId: 'project_id',
  meetingUrl: 'meeting_url',
  scheduledAt: 'scheduled_at',
  languageHint: 'language_hint',
  status: 'status',
  lastError: 'last_error',
  // Vexa bot tracking (Phase 7)
  platform: 'platform',
  nativeMeetingId: 'native_meeting_id',
  vexaMeetingId: 'vexa_meeting_id',
  botStatus: 'bot_status',
  botReason: 'bot_reason',
  botRequestedAt: 'bot_requested_at',
  botCheckedAt: 'bot_checked_at',
  startedAt: 'started_at',
  endedAt: 'ended_at',
};

export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([key, value]) => UPDATABLE[key] && value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${UPDATABLE[key]} = ?`).join(', ');
  await conn.execute(`UPDATE meetings SET ${sets} WHERE id = ?`, [...entries.map(([, v]) => v), id]);
}

export async function listParticipantIds(meetingId) {
  const [rows] = await pool.execute('SELECT user_id FROM meeting_participants WHERE meeting_id = ?', [meetingId]);
  return rows.map((r) => r.user_id);
}

export async function listParticipants(meetingId) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.email, u.full_name, u.role, u.is_active
     FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
     WHERE mp.meeting_id = ? ORDER BY u.full_name`,
    [meetingId],
  );
  return rows;
}

export async function replaceParticipants(conn, meetingId, userIds) {
  await conn.execute('DELETE FROM meeting_participants WHERE meeting_id = ?', [meetingId]);
  if (userIds.length > 0) {
    await conn.query('INSERT INTO meeting_participants (meeting_id, user_id) VALUES ?', [
      userIds.map((userId) => [meetingId, userId]),
    ]);
  }
}

/** Another meeting of ours whose bot is live on the same link (Vexa allows one bot per link). */
export async function findActiveBotOnLink(conn, platform, nativeMeetingId, excludeId) {
  const [rows] = await conn.query(
    `SELECT id, title FROM meetings
     WHERE platform = ? AND native_meeting_id = ? AND id <> ? AND status IN ('bot_requested','bot_joining','in_progress')`,
    [platform, nativeMeetingId, excludeId],
  );
  return rows[0] ?? null;
}

/**
 * Moves a meeting's action items along when the meeting's project changes: items that followed
 * the meeting (same project as before, including none) get the new one. Items an admin assigned
 * to a different project on purpose keep theirs.
 */
export async function moveItemsWithMeeting(conn, meetingId, fromProjectId, toProjectId) {
  const [result] = await conn.execute(
    'UPDATE action_items SET project_id = ? WHERE meeting_id = ? AND project_id <=> ?',
    [toProjectId, meetingId, fromProjectId],
  );
  return result.affectedRows;
}
