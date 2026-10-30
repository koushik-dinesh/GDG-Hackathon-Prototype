import { pool } from '../db/pool.js';

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const toNumber = (v) => (v === null || v === undefined ? null : Number(v));

export const toActionItem = (row) => ({
  id: row.id,
  meetingId: row.meeting_id,
  // Project association (Phase 2). Defaults to the meeting's project; independent of review/task status.
  projectId: row.project_id ?? null,
  project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
  extractionRunId: row.extraction_run_id,
  // AI items come from an extraction run; manual items have none (and no AI confidence/evidence).
  source: row.extraction_run_id ? 'ai' : 'manual',
  title: row.title,
  description: row.description,
  assigneeNameRaw: row.assignee_name_raw,
  assignee: row.assignee_user_id
    ? { id: row.assignee_user_id, fullName: row.assignee_full_name, email: row.assignee_email, isActive: Boolean(row.assignee_is_active) }
    : null,
  assigneeMatch: row.assignee_match,
  dueDate: row.due_date,
  dueDateRaw: row.due_date_raw,
  priority: row.priority,
  reviewStatus: row.review_status,
  taskStatus: row.task_status,
  flags: parseJson(row.flags) ?? [],
  reviewDetails: parseJson(row.review_details),
  aiConfidence: toNumber(row.ai_confidence),
  approvedAt: row.approved_at ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toEvidence = (row) => ({
  id: row.id,
  excerpt: row.excerpt,
  speaker: row.speaker,
  startSec: toNumber(row.start_sec),
  segmentId: row.segment_id,
});

// DATE_FORMAT keeps due_date a plain calendar date (no timezone shifting).
const ITEM_SELECT = `
  SELECT ai.*, DATE_FORMAT(ai.due_date, '%Y-%m-%d') AS due_date,
         u.full_name AS assignee_full_name, u.email AS assignee_email, u.is_active AS assignee_is_active,
         p.name AS project_name
  FROM action_items ai LEFT JOIN users u ON u.id = ai.assignee_user_id LEFT JOIN projects p ON p.id = ai.project_id`;

async function withEvidence(rows, conn = pool) {
  if (rows.length === 0) return [];
  const [evidence] = await conn.query(
    'SELECT * FROM action_item_evidence WHERE action_item_id IN (?) ORDER BY start_sec IS NULL, start_sec, id',
    [rows.map((r) => r.id)],
  );
  const byItem = Map.groupBy(evidence, (e) => e.action_item_id);
  return rows.map((r) => ({ ...toActionItem(r), evidence: (byItem.get(r.id) ?? []).map(toEvidence) }));
}

export async function listForMeeting(meetingId) {
  const [rows] = await pool.execute(`${ITEM_SELECT} WHERE ai.meeting_id = ? ORDER BY ai.id`, [meetingId]);
  return withEvidence(rows);
}

/** One item in API shape, or null. With `conn` + forUpdate, locks the item row. */
export async function findById(id, { conn = pool, forUpdate = false } = {}) {
  const [rows] = await conn.query(`${ITEM_SELECT} WHERE ai.id = ?${forUpdate ? ' FOR UPDATE OF ai' : ''}`, [id]);
  return (await withEvidence(rows, conn))[0] ?? null;
}

/** Pending items of a meeting, locked, in API shape. */
export async function listPendingForUpdate(conn, meetingId) {
  const [rows] = await conn.query(`${ITEM_SELECT} WHERE ai.meeting_id = ? AND ai.review_status = 'pending' ORDER BY ai.id FOR UPDATE OF ai`, [meetingId]);
  return withEvidence(rows, conn);
}

const EDITABLE = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  assigneeUserId: 'assignee_user_id',
  assigneeMatch: 'assignee_match',
  dueDate: 'due_date',
  flags: 'flags',
  reviewDetails: 'review_details',
};
const JSON_COLUMNS = new Set(['flags', 'reviewDetails']);

export async function update(conn, id, fields) {
  const entries = Object.entries(fields).filter(([key, value]) => EDITABLE[key] && value !== undefined);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${EDITABLE[key]} = ?`).join(', ');
  const values = entries.map(([key, v]) => (JSON_COLUMNS.has(key) ? JSON.stringify(v) : v));
  await conn.execute(`UPDATE action_items SET ${sets} WHERE id = ?`, [...values, id]);
}

/** approved: records approver; pending/rejected: clears it. */
export async function setReviewStatus(conn, id, status, { actorId, reviewDetails }) {
  await conn.execute(
    `UPDATE action_items SET review_status = ?, approved_by = ?, approved_at = IF(? = 'approved', NOW(), NULL),
            review_details = ?
     WHERE id = ?`,
    [status, status === 'approved' ? actorId : null, status, JSON.stringify(reviewDetails ?? null), id],
  );
}

/** Manual item: no extraction run, no AI confidence, no evidence. Project defaults to the meeting's. */
export async function createManual(conn, meetingId, { title, description, priority, assigneeUserId, dueDate, projectId, actorId }) {
  const [result] = await conn.execute(
    `INSERT INTO action_items
       (meeting_id, project_id, extraction_run_id, title, description, assignee_user_id, assignee_match, due_date, priority, flags, review_details)
     VALUES (?, COALESCE(?, (SELECT project_id FROM meetings WHERE id = ?)), NULL, ?, ?, ?, ?, ?, ?, '[]', ?)`,
    [
      meetingId, projectId ?? null, meetingId, title, description ?? null, assigneeUserId ?? null, assigneeUserId ? 'manual' : 'none', dueDate ?? null,
      priority ?? 'medium', JSON.stringify({ source: 'manual', createdBy: actorId }),
    ],
  );
  return result.insertId;
}

/** Items an admin already decided on; new extractions must not duplicate them. */
export async function listReviewed(meetingId, conn = pool) {
  const [rows] = await conn.execute(
    `SELECT id, title, assignee_user_id, assignee_name_raw FROM action_items
     WHERE meeting_id = ? AND review_status <> 'pending'`,
    [meetingId],
  );
  return rows.map((r) => ({ id: r.id, title: r.title, assigneeUserId: r.assignee_user_id, assigneeNameRaw: r.assignee_name_raw }));
}

/**
 * Replaces the meeting's AI-generated pending items with a new set (PLANNING.md: re-extraction
 * "replaces pending items only"). Approved/rejected items and manually added items are kept.
 */
export async function replacePendingExtracted(conn, meetingId, runId, items) {
  const [deleted] = await conn.execute(
    "DELETE FROM action_items WHERE meeting_id = ? AND review_status = 'pending' AND extraction_run_id IS NOT NULL",
    [meetingId],
  );
  for (const item of items) {
    const [result] = await conn.execute(
      // Extracted items take the meeting's project (never an AI guess); NULL when it has none.
      `INSERT INTO action_items
         (meeting_id, project_id, extraction_run_id, title, description, assignee_name_raw, assignee_user_id, assignee_match,
          due_date, due_date_raw, priority, flags, review_details, ai_confidence)
       VALUES (?, (SELECT project_id FROM meetings WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        meetingId, meetingId, runId, item.title, item.description, item.assigneeNameRaw, item.assigneeUserId, item.assigneeMatch,
        item.dueDate, item.dueDateRaw, item.priority, JSON.stringify(item.flags), JSON.stringify(item.reviewDetails),
        item.aiConfidence,
      ],
    );
    if (item.evidence.length) {
      await conn.query('INSERT INTO action_item_evidence (action_item_id, excerpt, speaker, start_sec, segment_id) VALUES ?', [
        item.evidence.map((e) => [result.insertId, e.excerpt, e.speaker, e.startSec, e.segmentId]),
      ]);
    }
  }
  return { deleted: deleted.affectedRows, inserted: items.length };
}

export async function setProject(conn, id, projectId) {
  await conn.execute('UPDATE action_items SET project_id = ? WHERE id = ?', [projectId, id]);
}
