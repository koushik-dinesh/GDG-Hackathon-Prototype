// Projects (Phase 2). Every handler re-checks permissions on the server (services/permissions.js);
// projects a user can't see are reported as 404 so their existence isn't revealed.
import { withTransaction } from '../db/transaction.js';
import * as projects from '../repositories/projectsRepository.js';
import * as teams from '../repositories/teamsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { recordAudit } from '../services/audit.js';
import {
  MANAGER_ROLES,
  canChangeProjectOwner,
  canCreateProjects,
  canManageProject,
  canViewProject,
  isAdmin,
  projectPermissions,
} from '../services/permissions.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

const isDuplicate = (err) => err.code === 'ER_DUP_ENTRY';
const duplicateName = () => conflict('A project with this name already exists', [{ field: 'name', message: 'Already in use' }]);
const archived = () => new AppError(409, 'PROJECT_ARCHIVED', 'This project is archived. Reactivate it to make changes.');

/** Loads a project the caller may see, or throws 404. */
async function loadVisible(req, id) {
  const project = await projects.findById(id);
  if (!project) throw notFound('Project not found');
  const member = await projects.isMember(id, req.user.id);
  if (!canViewProject(req.user, project, member)) throw notFound('Project not found');
  return { project, member };
}

/** Loads a project the caller may manage; 404 if invisible, 403 if visible but read-only. */
async function loadManaged(req, id) {
  const { project } = await loadVisible(req, id);
  if (!canManageProject(req.user, project)) throw forbidden('Only the project owner or an admin can change this project');
  return project;
}

async function assertOwnerCandidate(userId) {
  const row = await users.findById(userId);
  if (!row || !row.is_active) {
    throw badRequest('Invalid owner', [{ field: 'ownerUserId', message: 'Choose an active user' }]);
  }
  if (!MANAGER_ROLES.includes(row.role)) {
    throw badRequest('Invalid owner', [{ field: 'ownerUserId', message: 'The owner must be an admin or a manager' }]);
  }
}

function assertDates(startDate, targetDate) {
  if (startDate && targetDate && targetDate < startDate) {
    throw badRequest('Invalid dates', [{ field: 'targetDate', message: 'Must be on or after the start date' }]);
  }
}

async function assertActiveMembers(userIds) {
  const unique = [...new Set(userIds)];
  const found = new Set(await users.findActiveIds(unique));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw badRequest('Some people are not active users', missing.map((id) => ({ field: 'userIds', message: `User ${id} not found or inactive` })));
  }
  return unique;
}

const audited = (project) =>
  project && {
    name: project.name,
    description: project.description,
    status: project.status,
    ownerUserId: project.ownerUserId,
    startDate: project.startDate,
    targetDate: project.targetDate,
  };

export async function list(req, res) {
  const rows = await projects.list({
    visibleTo: isAdmin(req.user) ? null : req.user.id,
    status: req.query.status,
    includeArchived: req.query.includeArchived,
    q: req.query.q,
  });
  res.json({ projects: rows, permissions: { canCreate: canCreateProjects(req.user) } });
}

export async function get(req, res) {
  const { project } = await loadVisible(req, req.params.id);
  const members = await projects.listMembers(project.id);
  res.json({ project: { ...project, members, permissions: projectPermissions(req.user, project) } });
}

export async function create(req, res) {
  if (!canCreateProjects(req.user)) throw forbidden('Only admins and managers can create projects');
  const { ownerUserId: requestedOwner, memberIds = [], ...fields } = req.body;
  // Managers always own what they create; only admins may name someone else.
  if (requestedOwner && requestedOwner !== req.user.id && !canChangeProjectOwner(req.user)) {
    throw forbidden('Only an admin can make someone else the owner');
  }
  const ownerUserId = requestedOwner ?? req.user.id;
  await assertOwnerCandidate(ownerUserId);
  assertDates(fields.startDate, fields.targetDate);
  const memberUserIds = await assertActiveMembers([ownerUserId, ...memberIds]);

  let id;
  try {
    id = await withTransaction(async (conn) => {
      const projectId = await projects.create(conn, { ...fields, ownerUserId, createdBy: req.user.id });
      await projects.addMembers(conn, projectId, memberUserIds, req.user.id);
      const created = await projects.findById(projectId, conn);
      await recordAudit(conn, { actorUserId: req.user.id, action: 'project.created', entityType: 'project', entityId: projectId, after: audited(created), ip: req.ip });
      return projectId;
    });
  } catch (err) {
    if (isDuplicate(err)) throw duplicateName();
    throw err;
  }
  const project = await projects.findById(id);
  res.status(201).json({ project: { ...project, members: await projects.listMembers(id), permissions: projectPermissions(req.user, project) } });
}

export async function update(req, res) {
  const { id } = req.params;
  const before = await loadManaged(req, id);
  const fields = { ...req.body };

  if (fields.ownerUserId !== undefined && fields.ownerUserId !== before.ownerUserId) {
    if (!canChangeProjectOwner(req.user)) throw forbidden('Only an admin can change the project owner');
    await assertOwnerCandidate(fields.ownerUserId);
  }
  // An archived project is read-only; the only allowed change is its status (reactivation).
  const otherFields = Object.keys(fields).filter((k) => k !== 'status');
  if (before.status === 'archived' && (otherFields.length > 0 || fields.status === undefined)) throw archived();
  assertDates(
    fields.startDate !== undefined ? fields.startDate : before.startDate,
    fields.targetDate !== undefined ? fields.targetDate : before.targetDate,
  );

  let after;
  try {
    after = await withTransaction(async (conn) => {
      await projects.lock(conn, id);
      await projects.update(conn, id, fields);
      if (fields.ownerUserId) await projects.addMembers(conn, id, [fields.ownerUserId], req.user.id);
      const updated = await projects.findById(id, conn);
      const action = fields.status && fields.status !== before.status
        ? (fields.status === 'archived' ? 'project.archived' : before.status === 'archived' ? 'project.reactivated' : 'project.status_changed')
        : 'project.updated';
      await recordAudit(conn, { actorUserId: req.user.id, action, entityType: 'project', entityId: id, before: audited(before), after: audited(updated), ip: req.ip });
      if (fields.ownerUserId && fields.ownerUserId !== before.ownerUserId) {
        await recordAudit(conn, { actorUserId: req.user.id, action: 'project.owner_changed', entityType: 'project', entityId: id, before: { ownerUserId: before.ownerUserId }, after: { ownerUserId: fields.ownerUserId }, ip: req.ip });
      }
      return updated;
    });
  } catch (err) {
    if (isDuplicate(err)) throw duplicateName();
    throw err;
  }
  res.json({ project: { ...after, members: await projects.listMembers(id), permissions: projectPermissions(req.user, after) } });
}

// ---------- members ----------

export async function listMembers(req, res) {
  const { project } = await loadVisible(req, req.params.id);
  res.json({ members: await projects.listMembers(project.id) });
}

/** Body: { userIds?: number[], teamId?: number } — a team adds its active members. */
export async function addMembers(req, res) {
  const { id } = req.params;
  const project = await loadManaged(req, id);
  if (project.status === 'archived') throw archived();

  let candidates = req.body.userIds ?? [];
  if (req.body.teamId) {
    const team = await teams.findById(req.body.teamId);
    if (!team) throw badRequest('Team not found', [{ field: 'teamId', message: 'Choose an existing team' }]);
    const teamMembers = await teams.listMembers(team.id);
    candidates = [...candidates, ...teamMembers.filter((m) => m.isActive).map((m) => m.id)];
  }
  const userIds = await assertActiveMembers(candidates);
  if (userIds.length === 0) throw badRequest('Choose at least one active person', [{ field: 'userIds', message: 'Required' }]);

  const added = await withTransaction(async (conn) => {
    await projects.lock(conn, id);
    const fresh = await projects.addMembers(conn, id, userIds, req.user.id);
    if (fresh.length) {
      await recordAudit(conn, { actorUserId: req.user.id, action: 'project.members_added', entityType: 'project', entityId: id, after: { userIds: fresh, teamId: req.body.teamId ?? null }, ip: req.ip });
    }
    return fresh;
  });
  res.status(201).json({ added, members: await projects.listMembers(id) });
}

// Removing someone keeps everything they did (tasks, meetings, audit); only the membership goes.
export async function removeMember(req, res) {
  const { id, userId } = req.params;
  const project = await loadManaged(req, id);
  if (project.status === 'archived') throw archived();
  if (userId === project.ownerUserId) throw conflict('The owner can’t be removed. Change the owner first.');

  await withTransaction(async (conn) => {
    await projects.lock(conn, id);
    if (!(await projects.removeMember(conn, id, userId))) throw notFound('This person is not a member of the project');
    await recordAudit(conn, { actorUserId: req.user.id, action: 'project.member_removed', entityType: 'project', entityId: id, before: { userId }, ip: req.ip });
  });
  res.status(204).end();
}

// ---------- associated work ----------

export async function listMeetings(req, res) {
  const { project } = await loadVisible(req, req.params.id);
  res.json({ meetings: await projects.listMeetings(project.id) });
}

// Owners/admins see every item with its review state; other members only their own visible tasks.
export async function listTasks(req, res) {
  const { project } = await loadVisible(req, req.params.id);
  const all = canManageProject(req.user, project);
  res.json({
    tasks: await projects.listTasks(project.id, { onlyAssignee: all ? null : req.user.id }),
    scope: all ? 'all' : 'mine',
  });
}

export async function activity(req, res) {
  const { project } = await loadVisible(req, req.params.id);
  res.json({ activity: await projects.activity(project.id) });
}
