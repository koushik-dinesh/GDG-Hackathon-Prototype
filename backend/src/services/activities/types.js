// The activity vocabulary (Phase 4): one set of verbs for every source. What the verb applies to
// comes from the subject (a task, a meeting, an issue, a pull request…), so "completed" means the
// same thing for a WorkAgent task and, later, a Jira ticket. Connectors must use these verbs;
// envelopes with any other activity type are rejected.
export const ACTIVITY_TYPES = {
  created: 'Created',
  updated: 'Updated',
  status_changed: 'Status changed',
  deleted: 'Deleted at the source',
  archived: 'Archived',
  assigned: 'Assigned',
  unassigned: 'Unassigned',
  started: 'Started',
  blocked: 'Blocked',
  completed: 'Completed',
  reopened: 'Reopened',
  closed: 'Closed',
  merged: 'Merged',
  commented: 'Commented',
  committed: 'Committed',
  pushed: 'Pushed',
  review_requested: 'Review requested',
  review_submitted: 'Review submitted',
  review_dismissed: 'Review dismissed',
  ready_for_review: 'Ready for review',
  converted_to_draft: 'Converted to draft',
  scheduled: 'Scheduled',
  conducted: 'Conducted',
  review_completed: 'Review completed',
};

export const ACTIVITY_TYPE_NAMES = Object.keys(ACTIVITY_TYPES);
export const isActivityType = (t) => Object.hasOwn(ACTIVITY_TYPES, t);

/** Provider id of WorkAgent's own activities (meetings, tasks, projects). */
export const INTERNAL_PROVIDER = 'workagent';
