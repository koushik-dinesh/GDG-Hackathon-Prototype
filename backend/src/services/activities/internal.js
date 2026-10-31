// WorkAgent's own activities (Phase 4): task created/assigned/started/completed, meeting
// scheduled/conducted, project created/status changed. They are derived from the audit entry of
// the change, at the single place every change is audited (services/audit.js), inside the same
// transaction when there is one. The same mapping backfills history (npm run activities:backfill).
//
// Keys are deterministic, so re-running the mapping (backfill, retries) never duplicates:
//   once-only events      workagent:<entity>:<id>:<verb>           (task created, meeting conducted)
//   repeatable events     workagent:<entity>:<id>:<verb>:a<audit id>
// Summaries are written when the event happens and are not rewritten later (history).
import * as activities from '../../repositories/activitiesRepository.js';
import { INTERNAL_PROVIDER } from './types.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v ?? {});

async function one(conn, sql, params) {
  const [rows] = await conn.query(sql, params);
  return rows[0] ?? null;
}

const actorName = async (conn, userId) => (userId ? (await one(conn, 'SELECT full_name FROM users WHERE id = ?', [userId]))?.full_name : null) ?? 'WorkAgent';

const itemRow = (conn, id) =>
  one(
    conn,
    `SELECT ai.id, ai.title, ai.project_id, ai.review_status, ai.assignee_user_id, u.full_name AS assignee_name
     FROM action_items ai LEFT JOIN users u ON u.id = ai.assignee_user_id WHERE ai.id = ?`,
    [id],
  );

const TASK_STATUS_VERB = { done: 'completed', in_progress: 'started', blocked: 'blocked' };

/** Activity inputs (without origin/provider) for one audit entry. Unknown actions -> []. */
async function activitiesFor(conn, entry) {
  const { action, entityId, actorUserId } = entry;
  const before = parse(entry.before);
  const after = parse(entry.after);
  const a = (o) => ({ actorUserId: actorUserId ?? null, ...o });
  const actor = () => actorName(conn, actorUserId);

  switch (action) {
    case 'action_item.approved': {
      const item = await itemRow(conn, entityId);
      if (!item) return [];
      return [
        a({
          key: `action_item:${item.id}:created`,
          activityType: 'created',
          entityType: 'action_item',
          entityId: item.id,
          projectId: item.project_id,
          summary: `${await actor()} approved task “${item.title}”${item.assignee_name ? ` for ${item.assignee_name}` : ''}`,
          details: { assigneeUserId: item.assignee_user_id },
        }),
      ];
    }
    case 'meeting.review_completed': {
      // Finishing a review approves the remaining items; each becomes a task.
      const [items] = await conn.query(
        `SELECT ai.id, ai.title, ai.project_id, ai.assignee_user_id, u.full_name AS assignee_name
         FROM action_items ai LEFT JOIN users u ON u.id = ai.assignee_user_id
         WHERE ai.meeting_id = ? AND ai.review_status = 'approved'`,
        [entityId],
      );
      const name = await actor();
      const meeting = await one(conn, 'SELECT title, project_id FROM meetings WHERE id = ?', [entityId]);
      return [
        ...items.map((item) =>
          a({
            key: `action_item:${item.id}:created`,
            activityType: 'created',
            entityType: 'action_item',
            entityId: item.id,
            projectId: item.project_id,
            summary: `${name} approved task “${item.title}”${item.assignee_name ? ` for ${item.assignee_name}` : ''}`,
            details: { assigneeUserId: item.assignee_user_id },
          }),
        ),
        ...(meeting
          ? [a({ key: `meeting:${entityId}:review_completed`, activityType: 'review_completed', entityType: 'meeting', entityId, projectId: meeting.project_id, summary: `${name} finished reviewing “${meeting.title}”`, details: { approved: items.length } })]
          : []),
      ];
    }
    case 'action_item.updated': {
      if ((before.assigneeUserId ?? null) === (after.assigneeUserId ?? null)) return [];
      const item = await itemRow(conn, entityId);
      if (!item || item.review_status !== 'approved') return []; // only approved items are tasks
      const assigned = Boolean(after.assigneeUserId);
      return [
        a({
          key: `action_item:${item.id}:${assigned ? 'assigned' : 'unassigned'}:a${entry.auditId}`,
          activityType: assigned ? 'assigned' : 'unassigned',
          entityType: 'action_item',
          entityId: item.id,
          projectId: item.project_id,
          summary: assigned ? `${await actor()} assigned “${item.title}” to ${item.assignee_name}` : `${await actor()} unassigned “${item.title}”`,
          details: { from: before.assigneeUserId ?? null, to: after.assigneeUserId ?? null },
        }),
      ];
    }
    case 'task.status_changed': {
      const item = await itemRow(conn, entityId);
      if (!item) return [];
      const from = before.taskStatus;
      const to = after.taskStatus;
      const verb = TASK_STATUS_VERB[to] ?? (from === 'done' ? 'reopened' : 'status_changed');
      return [
        a({
          key: `action_item:${item.id}:${verb}:a${entry.auditId}`,
          activityType: verb,
          entityType: 'action_item',
          entityId: item.id,
          projectId: item.project_id,
          summary: `${await actor()} ${{ completed: 'completed', started: 'started', blocked: 'marked as blocked', reopened: 'reopened', status_changed: 'changed the status of' }[verb]} “${item.title}”`,
          details: { from, to },
        }),
      ];
    }
    case 'meeting.created':
    case 'transcript.uploaded':
    case 'transcript.imported_from_vexa': {
      const meeting = await one(conn, 'SELECT id, title, project_id FROM meetings WHERE id = ?', [entityId]);
      if (!meeting) return [];
      const scheduled = action === 'meeting.created';
      return [
        a({
          key: `meeting:${meeting.id}:${scheduled ? 'scheduled' : 'conducted'}`,
          activityType: scheduled ? 'scheduled' : 'conducted',
          entityType: 'meeting',
          entityId: meeting.id,
          projectId: meeting.project_id,
          summary: scheduled ? `${await actor()} scheduled “${meeting.title}”` : `“${meeting.title}” took place (transcript available)`,
          details: scheduled ? null : { source: action === 'transcript.uploaded' ? 'upload' : 'meeting_bot' },
        }),
      ];
    }
    case 'project.created':
      return [a({ key: `project:${entityId}:created`, activityType: 'created', entityType: 'project', entityId, projectId: entityId, summary: `${await actor()} created project “${after.name ?? ''}”` })];
    case 'project.status_changed':
    case 'project.archived':
    case 'project.reactivated':
      return [
        a({
          key: `project:${entityId}:status_changed:a${entry.auditId}`,
          activityType: action === 'project.archived' ? 'archived' : 'status_changed',
          entityType: 'project',
          entityId,
          projectId: entityId,
          summary: `${await actor()} changed project “${after.name ?? before.name ?? ''}” from ${before.status} to ${after.status}`,
          details: { from: before.status ?? null, to: after.status ?? null },
        }),
      ];
    default:
      return [];
  }
}

export const MAPPED_AUDIT_ACTIONS = [
  'action_item.approved',
  'meeting.review_completed',
  'action_item.updated',
  'task.status_changed',
  'meeting.created',
  'transcript.uploaded',
  'transcript.imported_from_vexa',
  'project.created',
  'project.status_changed',
  'project.archived',
  'project.reactivated',
];

/**
 * Writes the activities for an audit entry ({ auditId, action, entityId, actorUserId, before,
 * after }) at `occurredAt`. Returns how many were new.
 */
export async function recordInternalActivities(conn, entry, occurredAt = new Date()) {
  if (!MAPPED_AUDIT_ACTIONS.includes(entry.action)) return 0;
  let inserted = 0;
  for (const act of await activitiesFor(conn, entry)) {
    const ok = await activities.insertIfNew(conn, {
      dedupeKey: `${INTERNAL_PROVIDER}:${act.key}`,
      provider: INTERNAL_PROVIDER,
      activityType: act.activityType,
      entityType: act.entityType,
      entityId: act.entityId,
      actorUserId: act.actorUserId,
      projectId: act.projectId ?? null,
      occurredAt,
      summary: act.summary.slice(0, 500),
      details: act.details ?? null,
      origin: 'internal',
    });
    if (ok) inserted++;
  }
  return inserted;
}

/**
 * Creates activities for history recorded before Phase 4 (npm run activities:backfill).
 * Idempotent: activity keys are deterministic. Returns { auditEntries, activitiesCreated }.
 */
export async function backfillFromAudit(conn) {
  const [rows] = await conn.query(
    `SELECT id, action, entity_id, actor_user_id, before_json, after_json, created_at
     FROM audit_logs WHERE action IN (?) ORDER BY id`,
    [MAPPED_AUDIT_ACTIONS],
  );
  let created = 0;
  for (const r of rows) {
    created += await recordInternalActivities(
      conn,
      { auditId: r.id, action: r.action, entityId: r.entity_id, actorUserId: r.actor_user_id, before: r.before_json, after: r.after_json },
      r.created_at,
    );
  }
  return { auditEntries: rows.length, activitiesCreated: created };
}
