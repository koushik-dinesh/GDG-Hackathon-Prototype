// The unified record model (Phase 4). Internal entities stay in their own tables (meetings,
// action_items, projects, users) and external ones in external_records; this module gives any
// reference { type, id } the same summary shape, used by the feed, search and relationships:
//
//   { type, id, provider, recordType, title, key, url, href, status, statusCategory, projectId,
//     sourceStatus, updatedAt, ... }
//
//   provider      'workagent' for internal entities, else the connector id ('github')
//   url           the source application's page (external records); href the WorkAgent page
//   sourceStatus  for external records: current | deleted | access_removed | not_syncing |
//                 disconnected | needs_reconnect  (history is kept in every case)
import { pool } from '../../db/pool.js';
import { INTERNAL_PROVIDER } from '../activities/types.js';

export const REF_TYPES = ['external_record', 'meeting', 'action_item', 'project', 'user'];
export const refKey = (r) => `${r.type}:${r.id}`;

const TASK_CATEGORY = { todo: 'todo', in_progress: 'in_progress', blocked: 'in_progress', done: 'done' };

export function sourceStatusOf({ deleted, connectionStatus, accessStatus, resourceEnabled }) {
  if (deleted) return 'deleted';
  if (connectionStatus === 'disconnected') return 'disconnected';
  if (connectionStatus === 'error') return 'needs_reconnect';
  if (accessStatus === 'removed') return 'access_removed';
  if (resourceEnabled === false) return 'not_syncing';
  return 'current';
}

export function externalSummary(r) {
  return {
    type: 'external_record',
    id: r.id,
    provider: r.provider,
    recordType: r.record_type,
    title: r.title ?? r.external_key ?? r.external_id,
    key: r.external_key,
    url: r.url,
    href: `/records/${r.id}`,
    state: r.state,
    status: r.state,
    statusCategory: r.status_category,
    projectId: r.project_id,
    parentRecordId: r.parent_record_id ?? null,
    deleted: Boolean(r.source_deleted_at),
    sourceStatus: sourceStatusOf({
      deleted: Boolean(r.source_deleted_at),
      connectionStatus: r.connection_status,
      accessStatus: r.access_status,
      resourceEnabled: r.resource_enabled === null || r.resource_enabled === undefined ? undefined : Boolean(r.resource_enabled),
    }),
    updatedAt: r.source_updated_at ?? r.last_synced_at,
  };
}

export const EXTERNAL_SUMMARY_SELECT = `
  SELECT r.id, r.provider, r.record_type, r.external_id, r.external_key, r.title, r.url, r.state, r.status_category,
         r.project_id, r.parent_record_id, r.source_deleted_at, r.source_updated_at, r.last_synced_at,
         c.status AS connection_status, res.access_status, res.is_enabled AS resource_enabled
  FROM external_records r
  JOIN integration_connections c ON c.id = r.connection_id
  LEFT JOIN integration_resources res ON res.id = r.resource_id`;

/** Resolves references to summaries. Returns Map(refKey -> summary); missing ones are absent. */
export async function resolveRefs(refs, conn = pool) {
  const out = new Map();
  const ids = (type) => [...new Set(refs.filter((r) => r.type === type).map((r) => Number(r.id)))];
  const put = (s) => out.set(refKey(s), s);

  const ext = ids('external_record');
  if (ext.length) {
    const [rows] = await conn.query(`${EXTERNAL_SUMMARY_SELECT} WHERE r.id IN (?)`, [ext]);
    rows.forEach((r) => put(externalSummary(r)));
  }
  const meetings = ids('meeting');
  if (meetings.length) {
    const [rows] = await conn.query('SELECT id, title, status, project_id, scheduled_at, updated_at FROM meetings WHERE id IN (?)', [meetings]);
    rows.forEach((m) =>
      put({ type: 'meeting', id: m.id, provider: INTERNAL_PROVIDER, recordType: 'meeting', title: m.title, key: null, url: null, href: `/admin/meetings/${m.id}`, status: m.status, statusCategory: m.status === 'approved' || m.status === 'emails_sent' ? 'done' : 'in_progress', projectId: m.project_id, sourceStatus: 'current', updatedAt: m.updated_at, scheduledAt: m.scheduled_at }),
    );
  }
  const items = ids('action_item');
  if (items.length) {
    const [rows] = await conn.query(
      `SELECT ai.id, ai.title, ai.task_status, ai.review_status, ai.project_id, ai.assignee_user_id, ai.meeting_id, ai.updated_at,
              m.status AS meeting_status, u.full_name AS assignee_name
       FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id LEFT JOIN users u ON u.id = ai.assignee_user_id
       WHERE ai.id IN (?)`,
      [items],
    );
    rows.forEach((t) =>
      put({
        type: 'action_item',
        id: t.id,
        provider: INTERNAL_PROVIDER,
        recordType: 'task',
        title: t.title,
        key: null,
        url: null,
        href: `/my/tasks/${t.id}`,
        status: t.review_status === 'approved' ? t.task_status : t.review_status,
        statusCategory: t.review_status === 'rejected' ? 'cancelled' : TASK_CATEGORY[t.task_status] ?? 'unknown',
        projectId: t.project_id,
        meetingId: t.meeting_id,
        meetingStatus: t.meeting_status,
        reviewStatus: t.review_status,
        assigneeUserId: t.assignee_user_id,
        assigneeName: t.assignee_name,
        sourceStatus: 'current',
        updatedAt: t.updated_at,
      }),
    );
  }
  const projects = ids('project');
  if (projects.length) {
    const [rows] = await conn.query('SELECT id, name, status, updated_at FROM projects WHERE id IN (?)', [projects]);
    rows.forEach((p) =>
      put({ type: 'project', id: p.id, provider: INTERNAL_PROVIDER, recordType: 'project', title: p.name, key: null, url: null, href: `/projects/${p.id}`, status: p.status, statusCategory: p.status === 'completed' ? 'done' : p.status === 'archived' ? 'cancelled' : 'in_progress', projectId: p.id, sourceStatus: 'current', updatedAt: p.updated_at }),
    );
  }
  const users = ids('user');
  if (users.length) {
    const [rows] = await conn.query('SELECT id, full_name, is_active FROM users WHERE id IN (?)', [users]);
    rows.forEach((u) => put({ type: 'user', id: u.id, provider: INTERNAL_PROVIDER, recordType: 'person', title: u.full_name, key: null, url: null, href: null, status: u.is_active ? 'active' : 'inactive', statusCategory: 'unknown', projectId: null, sourceStatus: 'current', updatedAt: null }));
  }
  return out;
}

/** Where a person should go in WorkAgent for an internal summary, given who they are. */
export function hrefFor(summary, scope) {
  if (summary.type === 'meeting' && !scope.admin) return summary.projectId ? `/projects/${summary.projectId}` : null;
  if (summary.type === 'action_item') {
    if (summary.assigneeUserId === scope.user.id) return `/my/tasks/${summary.id}`;
    if (scope.admin) return `/admin/meetings/${summary.meetingId}`;
    return summary.projectId ? `/projects/${summary.projectId}` : null;
  }
  return summary.href;
}
