export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'archived'];

export const PROJECT_STATUS_LABEL = {
  planning: 'Planning',
  active: 'Active',
  on_hold: 'On hold',
  completed: 'Completed',
  archived: 'Archived',
};

export const REVIEW_STATUS_LABEL = { pending: 'Pending review', approved: 'Approved', rejected: 'Rejected' };

const ACTIVITY_LABEL = {
  'project.created': 'created the project',
  'project.updated': 'edited the project details',
  'project.status_changed': 'changed the status',
  'project.archived': 'archived the project',
  'project.reactivated': 'reactivated the project',
  'project.owner_changed': 'changed the owner',
  'project.members_added': 'added members',
  'project.member_removed': 'removed a member',
  'project.meeting_linked': 'linked a meeting',
  'project.meeting_unlinked': 'unlinked a meeting',
  'project.task_linked': 'moved a task into the project',
  'project.task_unlinked': 'moved a task out of the project',
};

export function describeActivity(entry) {
  const what = ACTIVITY_LABEL[entry.action] ?? entry.action;
  const detail =
    entry.action === 'project.status_changed' || entry.action === 'project.archived' || entry.action === 'project.reactivated'
      ? `${PROJECT_STATUS_LABEL[entry.before?.status] ?? entry.before?.status} → ${PROJECT_STATUS_LABEL[entry.after?.status] ?? entry.after?.status}`
      : entry.after?.title ?? entry.before?.title ?? null;
  return { what, detail };
}
