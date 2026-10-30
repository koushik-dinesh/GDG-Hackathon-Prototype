// Teams (Phase 2). Admins manage every team; managers create teams and manage the ones they
// lead; employees can only see the teams they belong to.
import { withTransaction } from '../db/transaction.js';
import * as teams from '../repositories/teamsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { recordAudit } from '../services/audit.js';
import { MANAGER_ROLES, canCreateTeams, canManageTeam, canViewAllTeams, isAdmin } from '../services/permissions.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors.js';

const isDuplicate = (err) => err.code === 'ER_DUP_ENTRY';
const duplicateName = () => conflict('A team with this name already exists', [{ field: 'name', message: 'Already in use' }]);

const teamPermissions = (user, team) => ({ canEdit: canManageTeam(user, team), canManageMembers: canManageTeam(user, team), canChangeLead: isAdmin(user) });

async function loadVisible(req, id) {
  const team = await teams.findById(id);
  if (!team) throw notFound('Team not found');
  if (!canViewAllTeams(req.user) && team.leadUserId !== req.user.id && !(await teams.isMember(id, req.user.id))) {
    throw notFound('Team not found');
  }
  return team;
}

async function loadManaged(req, id) {
  const team = await loadVisible(req, id);
  if (!canManageTeam(req.user, team)) throw forbidden('Only the team lead or an admin can change this team');
  return team;
}

async function assertLeadCandidate(userId) {
  const row = await users.findById(userId);
  if (!row || !row.is_active || !MANAGER_ROLES.includes(row.role)) {
    throw badRequest('Invalid lead', [{ field: 'leadUserId', message: 'The lead must be an active admin or manager' }]);
  }
}

async function assertActiveUsers(userIds) {
  const unique = [...new Set(userIds)];
  const found = new Set(await users.findActiveIds(unique));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw badRequest('Some people are not active users', missing.map((id) => ({ field: 'userIds', message: `User ${id} not found or inactive` })));
  }
  return unique;
}

const audited = (t) => t && { name: t.name, description: t.description, leadUserId: t.leadUserId };

async function detail(user, id) {
  const team = await teams.findById(id);
  return { ...team, members: await teams.listMembers(id), permissions: teamPermissions(user, team) };
}

export async function list(req, res) {
  const rows = await teams.list({ memberOf: canViewAllTeams(req.user) ? null : req.user.id });
  res.json({ teams: rows.map((t) => ({ ...t, permissions: teamPermissions(req.user, t) })), permissions: { canCreate: canCreateTeams(req.user) } });
}

export async function get(req, res) {
  const team = await loadVisible(req, req.params.id);
  res.json({ team: await detail(req.user, team.id) });
}

export async function create(req, res) {
  if (!canCreateTeams(req.user)) throw forbidden('Only admins and managers can create teams');
  const { memberIds = [], leadUserId: requestedLead, ...fields } = req.body;
  // A manager leads the teams they create; admins may pick any admin/manager (or none).
  if (requestedLead !== undefined && requestedLead !== req.user.id && !isAdmin(req.user)) {
    throw forbidden('Only an admin can make someone else the team lead');
  }
  const leadUserId = isAdmin(req.user) ? (requestedLead ?? null) : req.user.id;
  if (leadUserId) await assertLeadCandidate(leadUserId);
  const memberUserIds = await assertActiveUsers(memberIds);

  let id;
  try {
    id = await withTransaction(async (conn) => {
      const teamId = await teams.create(conn, { ...fields, leadUserId, createdBy: req.user.id });
      await teams.addMembers(conn, teamId, memberUserIds, req.user.id);
      await recordAudit(conn, { actorUserId: req.user.id, action: 'team.created', entityType: 'team', entityId: teamId, after: { ...fields, leadUserId, memberIds: memberUserIds }, ip: req.ip });
      return teamId;
    });
  } catch (err) {
    if (isDuplicate(err)) throw duplicateName();
    throw err;
  }
  res.status(201).json({ team: await detail(req.user, id) });
}

export async function update(req, res) {
  const { id } = req.params;
  const before = await loadManaged(req, id);
  if (req.body.leadUserId !== undefined && req.body.leadUserId !== before.leadUserId) {
    if (!isAdmin(req.user)) throw forbidden('Only an admin can change the team lead');
    if (req.body.leadUserId !== null) await assertLeadCandidate(req.body.leadUserId);
  }
  try {
    await withTransaction(async (conn) => {
      await teams.lock(conn, id);
      await teams.update(conn, id, req.body);
      const after = await teams.findById(id, conn);
      await recordAudit(conn, { actorUserId: req.user.id, action: 'team.updated', entityType: 'team', entityId: id, before: audited(before), after: audited(after), ip: req.ip });
    });
  } catch (err) {
    if (isDuplicate(err)) throw duplicateName();
    throw err;
  }
  res.json({ team: await detail(req.user, id) });
}

export async function addMembers(req, res) {
  const { id } = req.params;
  await loadManaged(req, id);
  const userIds = await assertActiveUsers(req.body.userIds);
  await withTransaction(async (conn) => {
    await teams.lock(conn, id);
    const fresh = await teams.addMembers(conn, id, userIds, req.user.id);
    if (fresh.length) await recordAudit(conn, { actorUserId: req.user.id, action: 'team.members_added', entityType: 'team', entityId: id, after: { userIds: fresh }, ip: req.ip });
  });
  res.status(201).json({ team: await detail(req.user, id) });
}

export async function removeMember(req, res) {
  const { id, userId } = req.params;
  await loadManaged(req, id);
  await withTransaction(async (conn) => {
    await teams.lock(conn, id);
    if (!(await teams.removeMember(conn, id, userId))) throw notFound('This person is not a member of the team');
    await recordAudit(conn, { actorUserId: req.user.id, action: 'team.member_removed', entityType: 'team', entityId: id, before: { userId }, ip: req.ip });
  });
  res.status(204).end();
}
