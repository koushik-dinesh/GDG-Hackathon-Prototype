// Unified activity feed (Phase 4): WorkAgent and connected-application activities in one timeline,
// newest first, keyset-paginated on (occurred_at, id).
//
// Visibility (services/records/access.js): task activities follow task visibility (Phase 2:
// members see only their own tasks); every other activity follows its project; activities with
// no project are admin-only.
import { pool } from '../../db/pool.js';
import { taskVisibilitySql } from '../records/access.js';
import { hrefFor } from '../records/refs.js';

const TASK_CATEGORY_SQL = "CASE ai.task_status WHEN 'done' THEN 'done' WHEN 'todo' THEN 'todo' ELSE 'in_progress' END";
export const INTERNAL_SUBJECT_TYPES = { task: 'action_item', meeting: 'meeting', project: 'project' };

const SELECT = `
  SELECT a.id, a.provider, a.activity_type, a.origin, a.occurred_at, a.summary, a.details, a.project_id, p.name AS project_name,
         a.external_record_id, r.record_type, r.external_key, r.title AS record_title, r.url AS record_url, r.status_category AS record_status,
         a.entity_type, a.entity_id, ai.assignee_user_id, ai.meeting_id, ai.project_id AS task_project_id,
         COALESCE(ai.title, mm.title, pe.name) AS entity_title,
         i.id AS identity_id, i.login AS identity_login, i.display_name AS identity_name,
         COALESCE(a.actor_user_id, i.user_id) AS actor_uid, au.full_name AS actor_name
  FROM activities a
  LEFT JOIN projects p ON p.id = a.project_id
  LEFT JOIN external_records r ON r.id = a.external_record_id
  LEFT JOIN external_identities i ON i.id = a.actor_identity_id
  LEFT JOIN users au ON au.id = COALESCE(a.actor_user_id, i.user_id)
  LEFT JOIN action_items ai ON a.entity_type = 'action_item' AND ai.id = a.entity_id
  LEFT JOIN meetings m ON m.id = ai.meeting_id
  LEFT JOIN meetings mm ON a.entity_type = 'meeting' AND mm.id = a.entity_id
  LEFT JOIN projects pe ON a.entity_type = 'project' AND pe.id = a.entity_id`;

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);

function toView(row, scope) {
  let subject = null;
  if (row.external_record_id) {
    subject = { type: 'external_record', id: row.external_record_id, provider: row.provider, recordType: row.record_type, title: row.record_title, key: row.external_key, url: row.record_url, href: `/records/${row.external_record_id}`, statusCategory: row.record_status };
  } else if (row.entity_type) {
    const s = { type: row.entity_type, id: row.entity_id, provider: row.provider, recordType: row.entity_type === 'action_item' ? 'task' : row.entity_type, title: row.entity_title, key: null, url: null };
    s.href = hrefFor({ ...s, href: row.entity_type === 'project' ? `/projects/${row.entity_id}` : `/admin/meetings/${row.entity_id}`, assigneeUserId: row.assignee_user_id, meetingId: row.meeting_id, projectId: row.task_project_id ?? row.project_id }, scope);
    subject = s;
  }
  return {
    id: row.id,
    activityType: row.activity_type,
    provider: row.provider,
    origin: row.origin,
    occurredAt: row.occurred_at,
    summary: row.summary,
    details: parse(row.details),
    project: row.project_id ? { id: row.project_id, name: row.project_name } : null,
    actor: row.actor_uid || row.identity_id ? { userId: row.actor_uid ?? null, name: row.actor_name ?? null, login: row.identity_login ?? null, displayName: row.identity_name ?? null } : null,
    subject,
  };
}

/**
 * filters: { projectId, userId, provider, activityTypes[], from, to, recordId, entityType, entityId,
 *            subjectType, status, before: { occurredAt, id }, limit }
 * Returns limit+1 rows' views (the caller trims and builds the next cursor).
 */
export async function listFeed(scope, f) {
  const where = [];
  const params = [];
  if (!scope.admin) {
    const task = taskVisibilitySql(scope, 'ai', 'm');
    const projects = scope.visible.length ? 'a.project_id IN (?)' : 'FALSE';
    where.push(`((a.entity_type IS NULL OR a.entity_type <> 'action_item') AND ${projects} OR (a.entity_type = 'action_item' AND ${task.sql}))`);
    if (scope.visible.length) params.push(scope.visible);
    params.push(...task.params);
  }
  if (f.projectId) {
    where.push('a.project_id = ?');
    params.push(f.projectId);
  }
  if (f.unassigned) where.push('a.project_id IS NULL');
  if (f.userId) {
    where.push('COALESCE(a.actor_user_id, i.user_id) = ?');
    params.push(f.userId);
  }
  if (f.provider) {
    where.push('a.provider = ?');
    params.push(f.provider);
  }
  if (f.activityTypes?.length) {
    where.push('a.activity_type IN (?)');
    params.push(f.activityTypes);
  }
  if (f.from) {
    where.push('a.occurred_at >= ?');
    params.push(f.from);
  }
  if (f.to) {
    where.push('a.occurred_at < ?');
    params.push(f.to);
  }
  if (f.recordId) {
    // The record and what belongs to it (comments and reviews on a pull request, …).
    where.push('(a.external_record_id = ? OR r.parent_record_id = ?)');
    params.push(f.recordId, f.recordId);
  }
  if (f.entityType) {
    where.push('a.entity_type = ? AND a.entity_id = ?');
    params.push(f.entityType, f.entityId);
  }
  if (f.subjectType) {
    if (INTERNAL_SUBJECT_TYPES[f.subjectType]) {
      where.push('a.entity_type = ?');
      params.push(INTERNAL_SUBJECT_TYPES[f.subjectType]);
    } else {
      where.push('r.record_type = ?');
      params.push(f.subjectType);
    }
  }
  if (f.status) {
    where.push(`(r.status_category = ? OR (a.entity_type = 'action_item' AND ${TASK_CATEGORY_SQL} = ?))`);
    params.push(f.status, f.status);
  }
  if (f.before) {
    where.push('(a.occurred_at < ? OR (a.occurred_at = ? AND a.id < ?))');
    params.push(f.before.occurredAt, f.before.occurredAt, f.before.id);
  }
  const [rows] = await pool.query(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`, [...params, f.limit + 1]);
  return rows.map((r) => toView(r, scope));
}
