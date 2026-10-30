// Authorization rules for projects and teams (Phase 2). Routes and controllers call these; the
// frontend only uses the resulting `permissions` flags to hide controls.
//
//   admin     everything: users, settings, every project and team, meetings and review
//   manager   creates projects and teams; manages the projects they own and the teams they lead
//   employee  reads the projects and teams they belong to; sees only their own tasks there
//
// Ownership of a project can only be changed by an admin. Project owners and team leads must be
// admins or managers, so an employee never gets management rights through ownership.

export const MANAGER_ROLES = ['admin', 'manager'];

export const isAdmin = (user) => user?.role === 'admin';
export const canCreateProjects = (user) => MANAGER_ROLES.includes(user?.role);
export const canCreateTeams = canCreateProjects;

/** project: { ownerUserId } */
export const canManageProject = (user, project) =>
  isAdmin(user) || (user?.role === 'manager' && project.ownerUserId === user.id);

/** isMember: whether the user is in project_members. */
export const canViewProject = (user, project, isMember) =>
  canManageProject(user, project) || project.ownerUserId === user?.id || Boolean(isMember);

export const canChangeProjectOwner = isAdmin;

/** team: { leadUserId } */
export const canManageTeam = (user, team) => isAdmin(user) || (user?.role === 'manager' && team.leadUserId === user.id);

/** Admins and managers can see every team (to staff projects); employees only their own. */
export const canViewAllTeams = (user) => MANAGER_ROLES.includes(user?.role);

export function projectPermissions(user, project) {
  const manage = canManageProject(user, project);
  return {
    canEdit: manage,
    canChangeStatus: manage,
    canManageMembers: manage,
    canChangeOwner: canChangeProjectOwner(user),
    canViewAllTasks: manage,
    canLinkMeetings: isAdmin(user),
  };
}
