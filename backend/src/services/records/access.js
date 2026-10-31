// Who may see what across internal and external records (Phase 4). One place for the rules the
// feed, search, record detail and relationships share. They mirror Phase 2:
//   - projects: admins all; others the projects they own or belong to
//   - external records and activities: those in a visible project; records with no project: admins
//   - meetings: admins all; others meetings of visible projects (as on the project page)
//   - tasks (action items): admins all; project owners/managers every task of their projects;
//     everyone their own tasks once approved and the meeting's review is finished (My tasks rule)
import { pool } from '../../db/pool.js';
import { VISIBLE_MEETING_STATUSES } from '../tasks.js';
import { isAdmin } from '../permissions.js';

/** null = every project (admin); otherwise the ids of projects the user owns or belongs to. */
export async function visibleProjectIds(user, conn = pool) {
  if (isAdmin(user)) return null;
  const [rows] = await conn.query(
    `SELECT id FROM projects WHERE owner_user_id = ?
     UNION SELECT project_id FROM project_members WHERE user_id = ?`,
    [user.id, user.id],
  );
  return rows.map((r) => r.id);
}

/** Projects whose tasks the user may see in full (admins: all; managers: the ones they own). */
export async function managedProjectIds(user, conn = pool) {
  if (isAdmin(user)) return null;
  if (user.role !== 'manager') return [];
  const [rows] = await conn.query('SELECT id FROM projects WHERE owner_user_id = ?', [user.id]);
  return rows.map((r) => r.id);
}

/** Everything a request needs to decide visibility, computed once. */
export async function accessScope(user, conn = pool) {
  const [visible, managed] = await Promise.all([visibleProjectIds(user, conn), managedProjectIds(user, conn)]);
  return { user, admin: isAdmin(user), visible, managed, visibleSet: new Set(visible ?? []), managedSet: new Set(managed ?? []) };
}

export const canSeeProject = (scope, projectId) => scope.admin || (projectId !== null && projectId !== undefined && scope.visibleSet.has(projectId));
export const canManageProjectId = (scope, projectId) => scope.admin || (projectId !== null && projectId !== undefined && scope.managedSet.has(projectId));

/**
 * SQL fragment (+params) limiting action_items alias `ai` (joined to meetings `m`) to what the
 * scope may see; '' for admins.
 */
export function taskVisibilitySql(scope, ai = 'ai', m = 'm') {
  if (scope.admin) return { sql: '', params: [] };
  const own = `(${ai}.assignee_user_id = ? AND ${ai}.review_status = 'approved' AND ${m}.status IN (?))`;
  if (!scope.managed.length) return { sql: own, params: [scope.user.id, VISIBLE_MEETING_STATUSES] };
  return { sql: `(${own} OR ${ai}.project_id IN (?))`, params: [scope.user.id, VISIBLE_MEETING_STATUSES, scope.managed] };
}

/** Whether a resolved record summary (services/records/refs.js) is visible to the scope. */
export function canSeeSummary(scope, s) {
  if (!s) return false;
  if (scope.admin) return true;
  switch (s.type) {
    case 'project':
      return scope.visibleSet.has(s.id);
    case 'external_record':
    case 'meeting':
      return canSeeProject(scope, s.projectId);
    case 'action_item':
      return canManageProjectId(scope, s.projectId) || (s.assigneeUserId === scope.user.id && s.reviewStatus === 'approved' && VISIBLE_MEETING_STATUSES.includes(s.meetingStatus));
    case 'user':
      return true; // names of colleagues are visible to every signed-in user (as in the directory)
    default:
      return false;
  }
}

/**
 * Who may create, confirm or reject a relationship: admins; managers when every endpoint
 * belongs to a project they manage (users are linked by admins only); never employees.
 */
export function canEditLinkBetween(scope, summaries) {
  if (scope.admin) return true;
  if (scope.user.role !== 'manager') return false;
  return summaries.every((s) => s && s.type !== 'user' && canManageProjectId(scope, s.type === 'project' ? s.id : s.projectId));
}
