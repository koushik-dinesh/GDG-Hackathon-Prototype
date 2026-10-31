// Intelligence and insights (Phase 7). Computed on request from what WorkAgent already stores
// (tasks, meetings, synced records, activities, relationships), so nothing here can drift from the
// data and nothing is invented: every number is a count of rows the requester may see, every list
// item points at its record, and anything that is a judgement rather than a count is marked
// `kind: 'inference'` together with the rule that produced it.
//
// Visibility is the Phase 4 one (services/records/access.js): projects the person can see, tasks
// they may see (their own; every task of projects they manage; admins all), records and meetings of
// visible projects (records with no project: admins only). Employees therefore get their own
// workload, managers their projects', admins everything.
import { pool } from '../db/pool.js';
import { accessScope, canSeeProject, taskVisibilitySql } from './records/access.js';
import { canViewAllTeams } from './permissions.js';
import * as teams from '../repositories/teamsRepository.js';
import { notFound } from '../utils/errors.js';

const DAY = 86_400_000;
// Thresholds of the inference rules. They are part of the response (`rules`) so the UI can say why.
export const RULES = {
  staleDays: 14, // open work with no update for this long is "stalled"
  reviewWaitDays: 2, // an open, non-draft PR waiting this long for a review is "waiting"
  dueSoonDays: 14, // a project target date this close counts as "soon"
  offTrackOverdueShare: 0.3, // this share of open tasks overdue (and at least 2) = off track
};
const WORK_TYPES = ['issue', 'pull_request'];
const OPEN_CATEGORIES = ['todo', 'in_progress', 'unknown'];
const LIST_LIMIT = 50;

const isoDate = (d) => d.toISOString().slice(0, 10);
const days = (ms) => Math.floor(ms / DAY);
const ref = (type, id) => ({ type, id });
const fact = (text, evidence = []) => ({ kind: 'fact', text, evidence });
const inference = (text, rule, evidence = []) => ({ kind: 'inference', text, rule, evidence });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v) ?? {};

/** Builds the SQL scope pieces for one request, after checking the filters are visible. */
async function resolveFilters(user, { projectId = null, teamId = null, from, to, now = new Date() }, conn) {
  const scope = await accessScope(user, conn);
  if (projectId) {
    const [[p]] = await conn.query('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (!p || !canSeeProject(scope, projectId)) throw notFound('Project not found');
  }
  let teamUserIds = null;
  if (teamId) {
    const team = await teams.findById(teamId, conn);
    if (!team || (!canViewAllTeams(user) && team.leadUserId !== user.id && !(await teams.isMember(teamId, user.id)))) throw notFound('Team not found');
    teamUserIds = (await teams.listMembers(teamId, conn)).map((m) => m.id);
    if (team.leadUserId && !teamUserIds.includes(team.leadUserId)) teamUserIds.push(team.leadUserId);
  }
  const end = to ? new Date(to) : now;
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * DAY);
  // Projects in view: the filter, or every visible one (admins: all).
  const projectIds = projectId ? [projectId] : scope.visible; // null = all (admin)
  return { scope, projectId, projectIds, teamUserIds, start, end, now, today: isoDate(now) };
}

/** `AND <col> IN (?)` for the projects in view; records with no project only for admins without a filter. */
function projectClause(f, col) {
  if (f.projectIds === null) return { sql: '', params: [] };
  if (!f.projectIds.length) return { sql: ' AND FALSE', params: [] };
  return { sql: ` AND ${col} IN (?)`, params: [f.projectIds] };
}

function taskClause(f) {
  // Task visibility already limits non-admins; the project filter applies only when chosen, so a
  // person's own tasks outside any project still count for them.
  const vis = taskVisibilitySql(f.scope);
  const proj = f.projectId ? { sql: ' AND ai.project_id = ?', params: [f.projectId] } : { sql: '', params: [] };
  const team = f.teamUserIds ? { sql: f.teamUserIds.length ? ' AND ai.assignee_user_id IN (?)' : ' AND FALSE', params: f.teamUserIds.length ? [f.teamUserIds] : [] } : { sql: '', params: [] };
  return {
    sql: `${vis.sql ? ` AND ${vis.sql}` : ''}${proj.sql}${team.sql}`,
    params: [...vis.params, ...proj.params, ...team.params],
  };
}

// ---- data ---------------------------------------------------------------------------------------

async function loadProjects(f, conn) {
  const p = projectClause(f, 'p.id');
  const [rows] = await conn.query(
    `SELECT p.id, p.name, p.status, p.target_date, p.owner_user_id, u.full_name AS owner_name
     FROM projects p LEFT JOIN users u ON u.id = p.owner_user_id
     WHERE p.status <> 'archived'${p.sql} ORDER BY p.name`,
    p.params,
  );
  return rows;
}

async function loadTasks(f, conn) {
  const t = taskClause(f);
  const [rows] = await conn.query(
    `SELECT ai.id, ai.title, ai.project_id, ai.meeting_id, ai.assignee_user_id, u.full_name AS assignee_name,
            ai.due_date, ai.priority, ai.task_status, ai.updated_at, ai.approved_at, m.title AS meeting_title
     FROM action_items ai JOIN meetings m ON m.id = ai.meeting_id LEFT JOIN users u ON u.id = ai.assignee_user_id
     WHERE ai.review_status = 'approved'${t.sql}`,
    t.params,
  );
  return rows.map((r) => ({ ...r, due: r.due_date ? (r.due_date instanceof Date ? isoDate(r.due_date) : String(r.due_date).slice(0, 10)) : null }));
}

/** Tasks (visible ones) whose completion was recorded inside the window and that are still done. */
async function completedInWindow(f, conn) {
  const t = taskClause(f);
  const [rows] = await conn.query(
    `SELECT a.entity_id AS id, MAX(a.occurred_at) AS at
     FROM activities a JOIN action_items ai ON ai.id = a.entity_id JOIN meetings m ON m.id = ai.meeting_id
     WHERE a.entity_type = 'action_item' AND a.activity_type = 'completed' AND a.occurred_at BETWEEN ? AND ?
       AND ai.task_status = 'done' AND ai.review_status = 'approved'${t.sql}
     GROUP BY a.entity_id`,
    [f.start, f.end, ...t.params],
  );
  return new Map(rows.map((r) => [r.id, r.at]));
}

async function loadWorkRecords(f, conn) {
  const p = projectClause(f, 'r.project_id');
  const [rows] = await conn.query(
    `SELECT r.id, r.provider, r.record_type, r.external_key, r.title, r.state, r.status_category, r.project_id,
            r.metadata, r.source_created_at, r.source_updated_at, r.url
     FROM external_records r
     WHERE r.record_type IN (?) AND r.source_deleted_at IS NULL
       AND (r.status_category IN (?) OR r.source_updated_at >= ?)${p.sql}`,
    [WORK_TYPES, OPEN_CATEGORIES, f.start, ...p.params],
  );
  return rows.map((r) => ({ ...r, metadata: parseJson(r.metadata) }));
}

/** Latest submitted review per pull request (reviews are child records of the PR). */
async function latestReviews(prIds, conn) {
  if (!prIds.length) return new Map();
  const [rows] = await conn.query(
    `SELECT parent_record_id AS pr, state, source_created_at AS at, COUNT(*) OVER (PARTITION BY parent_record_id) AS n,
            ROW_NUMBER() OVER (PARTITION BY parent_record_id ORDER BY source_created_at DESC, id DESC) AS rn
     FROM external_records WHERE record_type = 'review' AND parent_record_id IN (?) AND source_deleted_at IS NULL`,
    [prIds],
  );
  return new Map(rows.filter((r) => Number(r.rn) === 1).map((r) => [r.pr, { state: r.state, at: r.at, count: Number(r.n) }]));
}

async function loadMeetings(f, conn) {
  const p = projectClause(f, 'm.project_id');
  const [rows] = await conn.query(
    `SELECT m.id, m.title, m.project_id, m.status, COALESCE(m.scheduled_at, m.started_at, m.created_at) AS at
     FROM meetings m
     WHERE COALESCE(m.scheduled_at, m.started_at, m.created_at) BETWEEN ? AND ?${p.sql}
     ORDER BY at DESC`,
    [f.start, f.end, ...p.params],
  );
  return rows;
}

/** Confirmed blocks/depends_on relationships with an unfinished blocker. */
async function loadDependencies(conn) {
  const [rows] = await conn.query(
    `SELECT id, from_type, from_id, to_type, to_id, link_type FROM record_links
     WHERE status = 'confirmed' AND link_type IN ('blocks', 'depends_on')`,
  );
  return rows;
}

async function endpointInfo(conn, refs) {
  const byType = { external_record: [], action_item: [], meeting: [] };
  for (const r of refs) byType[r.type]?.push(r.id);
  const out = new Map();
  if (byType.external_record.length) {
    const [rows] = await conn.query('SELECT id, title, external_key, project_id, status_category, source_deleted_at FROM external_records WHERE id IN (?)', [byType.external_record]);
    for (const r of rows) out.set(`external_record:${r.id}`, { title: r.external_key ? `${r.external_key} ${r.title ?? ''}`.trim() : r.title, projectId: r.project_id, done: ['done', 'cancelled'].includes(r.status_category) || Boolean(r.source_deleted_at) });
  }
  if (byType.action_item.length) {
    const [rows] = await conn.query("SELECT id, title, project_id, task_status FROM action_items WHERE id IN (?) AND review_status = 'approved'", [byType.action_item]);
    for (const r of rows) out.set(`action_item:${r.id}`, { title: r.title, projectId: r.project_id, done: r.task_status === 'done' });
  }
  if (byType.meeting.length) {
    const [rows] = await conn.query('SELECT id, title, project_id FROM meetings WHERE id IN (?)', [byType.meeting]);
    for (const r of rows) out.set(`meeting:${r.id}`, { title: r.title, projectId: r.project_id, done: true });
  }
  return out;
}

async function weeklyTrend(f, conn) {
  const p = projectClause(f, 'a.project_id');
  // Task activities follow task visibility; record activities follow projects.
  const t = taskClause(f);
  const [rows] = await conn.query(
    `SELECT DATE_FORMAT(DATE_SUB(DATE(a.occurred_at), INTERVAL WEEKDAY(a.occurred_at) DAY), '%Y-%m-%d') AS week,
            SUM(a.entity_type = 'action_item' AND a.activity_type = 'created') AS tasks_created,
            SUM(a.entity_type = 'action_item' AND a.activity_type = 'completed') AS tasks_completed,
            SUM(a.external_record_id IS NOT NULL AND a.activity_type = 'closed') AS records_closed,
            SUM(a.external_record_id IS NOT NULL AND a.activity_type = 'merged') AS prs_merged,
            SUM(a.external_record_id IS NOT NULL AND a.activity_type = 'created') AS records_opened
     FROM activities a
     LEFT JOIN action_items ai ON a.entity_type = 'action_item' AND ai.id = a.entity_id
     LEFT JOIN meetings m ON m.id = ai.meeting_id
     WHERE a.occurred_at BETWEEN ? AND ?
       AND ((a.entity_type = 'action_item' AND ai.id IS NOT NULL${t.sql})
         OR (a.external_record_id IS NOT NULL${p.sql}))
     GROUP BY week ORDER BY week`,
    [f.start, f.end, ...t.params, ...p.params],
  );
  return rows.map((r) => ({
    weekStart: r.week,
    tasksCreated: Number(r.tasks_created),
    tasksCompleted: Number(r.tasks_completed),
    recordsOpened: Number(r.records_opened),
    recordsClosed: Number(r.records_closed),
    pullRequestsMerged: Number(r.prs_merged),
  }));
}

// ---- assembly -----------------------------------------------------------------------------------

const taskRef = (t) => ({ ...ref('action_item', t.id), title: t.title, projectId: t.project_id, meetingId: t.meeting_id, assigneeUserId: t.assignee_user_id });
const recordRef = (r) => ({ ...ref('external_record', r.id), title: r.title, key: r.external_key, provider: r.provider, recordType: r.record_type, url: r.url, projectId: r.project_id });

function projectHealth(project, facts, f) {
  const reasons = [];
  if (facts.overdueTasks) reasons.push(fact(`${plural(facts.overdueTasks, 'task')} past due`));
  if (facts.blockedTasks) reasons.push(fact(`${plural(facts.blockedTasks, 'task')} marked blocked`));
  if (facts.reviewsWaiting) reasons.push(fact(`${plural(facts.reviewsWaiting, 'pull request')} waiting for review over ${RULES.reviewWaitDays} days`));
  if (facts.stalled) reasons.push(fact(`${plural(facts.stalled, 'open item')} without updates for ${RULES.staleDays}+ days`));
  if (facts.openDependencies) reasons.push(fact(`${plural(facts.openDependencies, 'unresolved dependency', 'unresolved dependencies')}`));
  const target = project.target_date ? (project.target_date instanceof Date ? isoDate(project.target_date) : String(project.target_date).slice(0, 10)) : null;
  const targetPassed = target && target < f.today && project.status !== 'completed';
  const daysToTarget = target ? days(new Date(`${target}T00:00:00Z`) - new Date(`${f.today}T00:00:00Z`)) : null;
  if (targetPassed) reasons.push(fact(`Target date ${target} has passed`));
  else if (target && daysToTarget <= RULES.dueSoonDays && project.status !== 'completed') reasons.push(fact(`Target date ${target} is in ${plural(daysToTarget, 'day')}`));

  const openWork = facts.openTasks + facts.openIssues + facts.openPullRequests;
  let level;
  let rule;
  if (project.status === 'completed') {
    level = 'completed';
    rule = 'Project status is completed';
  } else if (!openWork && !facts.completedTasks && !facts.meetings) {
    level = 'unknown';
    rule = 'No tasks, synced work or meetings in view';
  } else if (targetPassed || (facts.overdueTasks >= 2 && facts.overdueTasks / Math.max(1, facts.openTasks) >= RULES.offTrackOverdueShare)) {
    level = 'off_track';
    rule = targetPassed ? 'Target date passed with the project not completed' : `At least 2 tasks and ${RULES.offTrackOverdueShare * 100}% of open tasks overdue`;
  } else if (facts.overdueTasks || facts.blockedTasks || facts.reviewsWaiting || facts.openDependencies || (daysToTarget !== null && daysToTarget <= RULES.dueSoonDays && facts.openTasks > facts.completedTasks)) {
    level = 'at_risk';
    rule = 'Overdue, blocked, waiting-for-review or dependent work, or a near target date with more open than finished tasks';
  } else {
    level = 'on_track';
    rule = 'No overdue, blocked or waiting work';
  }
  return { level, assessment: inference(`Health: ${level.replace('_', ' ')}`, rule), reasons, targetDate: target, daysToTarget };
}

/**
 * The insights a person may see. Filters: projectId, teamId (people-based figures: tasks,
 * overdue, workload, follow-through), from/to (window for completions, meetings, trends; default
 * the last 30 days). Throws 404 for a project or team the person cannot see.
 */
export async function buildInsights(user, filters = {}, conn = pool) {
  const f = await resolveFilters(user, filters, conn);
  const [projects, tasks, completed, records, meetings, deps, trend] = await Promise.all([
    loadProjects(f, conn),
    loadTasks(f, conn),
    completedInWindow(f, conn),
    loadWorkRecords(f, conn),
    loadMeetings(f, conn),
    loadDependencies(conn),
    weeklyTrend(f, conn),
  ]);
  const nowMs = f.now.getTime();

  // Tasks
  const openTasks = tasks.filter((t) => t.task_status !== 'done');
  const overdue = openTasks
    .filter((t) => t.due && t.due < f.today)
    .map((t) => ({ task: taskRef(t), dueDate: t.due, daysOverdue: days(new Date(`${f.today}T00:00:00Z`) - new Date(`${t.due}T00:00:00Z`)), assignee: t.assignee_user_id ? { id: t.assignee_user_id, name: t.assignee_name } : null, status: t.task_status, priority: t.priority }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  const stalledTasks = openTasks.filter((t) => nowMs - new Date(t.updated_at).getTime() >= RULES.staleDays * DAY);

  // Synced work
  const openRecords = records.filter((r) => OPEN_CATEGORIES.includes(r.status_category));
  const openPrs = openRecords.filter((r) => r.record_type === 'pull_request');
  const reviews = await latestReviews(openPrs.map((r) => r.id), conn);
  const reviewQueue = openPrs
    .filter((r) => !r.metadata.draft)
    .map((r) => {
      const last = reviews.get(r.id);
      const since = last ? new Date(last.at) : new Date(r.source_created_at ?? r.source_updated_at);
      const stage = !last ? 'awaiting_review' : last.state === 'approved' ? 'approved_not_merged' : last.state === 'changes_requested' ? 'changes_requested' : 'reviewed';
      return { pullRequest: recordRef(r), stage, waitingDays: days(nowMs - since.getTime()), reviewCount: last?.count ?? 0, requestedReviewers: (r.metadata.requestedReviewers ?? []).map((p) => p.login) };
    })
    .sort((a, b) => b.waitingDays - a.waitingDays);
  const waitingReviews = reviewQueue.filter((q) => q.stage === 'awaiting_review' && q.waitingDays >= RULES.reviewWaitDays);
  const merged = records.filter((r) => r.record_type === 'pull_request' && r.metadata.merged && r.metadata.mergedAt && new Date(r.metadata.mergedAt) >= f.start && new Date(r.metadata.mergedAt) <= f.end);
  const mergeHours = merged.map((r) => (new Date(r.metadata.mergedAt) - new Date(r.source_created_at)) / 3_600_000).filter((h) => h >= 0).sort((a, b) => a - b);
  const stalledRecords = openRecords.filter((r) => r.source_updated_at && nowMs - new Date(r.source_updated_at).getTime() >= RULES.staleDays * DAY);
  const labelledBlocked = openRecords.filter((r) => (r.metadata.labels ?? []).some((l) => /block/i.test(l)));

  // Dependencies: confirmed blocks/depends_on with an unfinished blocker; both ends must be in view.
  const endpoints = await endpointInfo(conn, deps.flatMap((d) => [ref(d.from_type, d.from_id), ref(d.to_type, d.to_id)]));
  const inView = (pid) => (f.projectIds === null ? true : pid !== null && f.projectIds.includes(pid));
  const taskIds = new Set(tasks.map((t) => t.id));
  const visibleEnd = (type, id, info) => info && (type === 'action_item' ? taskIds.has(id) : inView(info.projectId));
  const dependencies = deps
    .map((d) => {
      // "A blocks B" and "B depends_on A" both mean A must finish first.
      const [blocker, blocked] = d.link_type === 'blocks' ? [ref(d.from_type, d.from_id), ref(d.to_type, d.to_id)] : [ref(d.to_type, d.to_id), ref(d.from_type, d.from_id)];
      const bi = endpoints.get(`${blocker.type}:${blocker.id}`);
      const di = endpoints.get(`${blocked.type}:${blocked.id}`);
      if (!visibleEnd(blocker.type, blocker.id, bi) || !visibleEnd(blocked.type, blocked.id, di) || bi.done) return null;
      return { linkId: d.id, blocker: { ...blocker, title: bi.title, projectId: bi.projectId }, blocked: { ...blocked, title: di.title, projectId: di.projectId }, crossProject: bi.projectId !== di.projectId };
    })
    .filter(Boolean);

  const blockers = [
    ...openTasks.filter((t) => t.task_status === 'blocked').map((t) => ({ kind: 'task_blocked', item: taskRef(t), evidence: fact('Task status is blocked') })),
    ...labelledBlocked.map((r) => ({ kind: 'record_labelled_blocked', item: recordRef(r), evidence: fact(`Labelled ${(r.metadata.labels ?? []).filter((l) => /block/i.test(l)).join(', ')} at the source`) })),
    ...dependencies.map((d) => ({ kind: 'dependency', item: d.blocked, blocker: d.blocker, crossProject: d.crossProject, evidence: fact(`Depends on “${d.blocker.title}”, which is not finished (confirmed relationship)`) })),
  ];

  // Meeting follow-through: approved tasks of meetings in the window (people filters apply).
  const byMeeting = new Map();
  for (const t of tasks) {
    if (!byMeeting.has(t.meeting_id)) byMeeting.set(t.meeting_id, []);
    byMeeting.get(t.meeting_id).push(t);
  }
  const followThrough = meetings
    .map((m) => {
      const items = byMeeting.get(m.id) ?? [];
      const done = items.filter((t) => t.task_status === 'done').length;
      const late = items.filter((t) => t.task_status !== 'done' && t.due && t.due < f.today).length;
      return { meeting: { ...ref('meeting', m.id), title: m.title, projectId: m.project_id, at: m.at }, tasks: items.length, done, open: items.length - done, overdue: late, completionRate: items.length ? Math.round((done / items.length) * 100) / 100 : null };
    })
    .filter((m) => m.tasks > 0);

  // Workload per assignee (open tasks they own that the requester can see).
  const people = new Map();
  for (const t of tasks) {
    if (!t.assignee_user_id) continue;
    const p = people.get(t.assignee_user_id) ?? { user: { id: t.assignee_user_id, name: t.assignee_name }, open: 0, inProgress: 0, blocked: 0, overdue: 0, highPriority: 0, completedInWindow: 0 };
    if (t.task_status !== 'done') {
      p.open += 1;
      if (t.task_status === 'in_progress') p.inProgress += 1;
      if (t.task_status === 'blocked') p.blocked += 1;
      if (t.due && t.due < f.today) p.overdue += 1;
      if (t.priority === 'high') p.highPriority += 1;
    } else if (completed.has(t.id)) p.completedInWindow += 1;
    people.set(t.assignee_user_id, p);
  }
  const workload = [...people.values()].sort((a, b) => b.open - a.open || b.overdue - a.overdue);
  const unassignedOpen = openTasks.filter((t) => !t.assignee_user_id).length;

  // Per project.
  const projectRows = projects.map((p) => {
    const pt = tasks.filter((t) => t.project_id === p.id);
    const pr = records.filter((r) => r.project_id === p.id);
    const facts = {
      openTasks: pt.filter((t) => t.task_status !== 'done').length,
      overdueTasks: overdue.filter((o) => o.task.projectId === p.id).length,
      blockedTasks: pt.filter((t) => t.task_status === 'blocked').length,
      completedTasks: pt.filter((t) => completed.has(t.id)).length,
      openIssues: pr.filter((r) => r.record_type === 'issue' && OPEN_CATEGORIES.includes(r.status_category)).length,
      openPullRequests: pr.filter((r) => r.record_type === 'pull_request' && OPEN_CATEGORIES.includes(r.status_category)).length,
      reviewsWaiting: waitingReviews.filter((q) => q.pullRequest.projectId === p.id).length,
      stalled: stalledTasks.filter((t) => t.project_id === p.id).length + stalledRecords.filter((r) => r.project_id === p.id).length,
      openDependencies: dependencies.filter((d) => d.blocked.projectId === p.id).length,
      meetings: meetings.filter((m) => m.project_id === p.id).length,
    };
    return { project: { id: p.id, name: p.name, status: p.status, owner: p.owner_user_id ? { id: p.owner_user_id, name: p.owner_name } : null }, facts, health: projectHealth(p, facts, f) };
  });

  const stalled = [
    ...stalledTasks.map((t) => ({ item: taskRef(t), lastUpdate: t.updated_at, idleDays: days(nowMs - new Date(t.updated_at).getTime()) })),
    ...stalledRecords.map((r) => ({ item: recordRef(r), lastUpdate: r.source_updated_at, idleDays: days(nowMs - new Date(r.source_updated_at).getTime()) })),
  ].sort((a, b) => b.idleDays - a.idleDays);

  const totals = {
    openTasks: openTasks.length,
    overdueTasks: overdue.length,
    blockedTasks: openTasks.filter((t) => t.task_status === 'blocked').length,
    completedTasks: completed.size,
    unassignedOpenTasks: unassignedOpen,
    openIssues: openRecords.filter((r) => r.record_type === 'issue').length,
    openPullRequests: openPrs.length,
    pullRequestsMerged: merged.length,
    medianHoursToMerge: mergeHours.length ? Math.round(mergeHours[Math.floor((mergeHours.length - 1) / 2)] * 10) / 10 : null,
    reviewsWaiting: waitingReviews.length,
    meetings: meetings.length,
    stalled: stalled.length,
    openDependencies: dependencies.length,
    crossProjectDependencies: dependencies.filter((d) => d.crossProject).length,
  };

  return {
    generatedAt: f.now.toISOString(),
    window: { from: f.start.toISOString(), to: f.end.toISOString() },
    filters: { projectId: f.projectId, teamId: filters.teamId ?? null },
    rules: RULES,
    totals,
    highlights: highlights(totals, projectRows, overdue, waitingReviews, followThrough, workload),
    projects: projectRows,
    overdue: overdue.slice(0, LIST_LIMIT),
    blockers: blockers.slice(0, LIST_LIMIT),
    dependencies: dependencies.slice(0, LIST_LIMIT),
    reviews: { queue: reviewQueue.slice(0, LIST_LIMIT), waiting: waitingReviews.length, merged: merged.length, medianHoursToMerge: totals.medianHoursToMerge },
    followThrough: followThrough.slice(0, LIST_LIMIT),
    workload: workload.slice(0, LIST_LIMIT),
    stalled: stalled.slice(0, LIST_LIMIT),
    trend,
  };
}

/** Plain-language summary, built only from the figures above (no generated text, no guesses). */
function highlights(totals, projectRows, overdue, waitingReviews, followThrough, workload) {
  const out = [];
  const offTrack = projectRows.filter((p) => p.health.level === 'off_track');
  const atRisk = projectRows.filter((p) => p.health.level === 'at_risk');
  if (offTrack.length) out.push(inference(`${plural(offTrack.length, 'project')} off track: ${offTrack.map((p) => p.project.name).join(', ')}`, 'Project health rules', offTrack.map((p) => ref('project', p.project.id))));
  if (atRisk.length) out.push(inference(`${plural(atRisk.length, 'project')} at risk: ${atRisk.map((p) => p.project.name).join(', ')}`, 'Project health rules', atRisk.map((p) => ref('project', p.project.id))));
  if (overdue.length) out.push(fact(`${plural(overdue.length, 'task')} overdue; the oldest by ${plural(overdue[0].daysOverdue, 'day')} (“${overdue[0].task.title}”)`, overdue.slice(0, 5).map((o) => ref('action_item', o.task.id))));
  if (totals.blockedTasks) out.push(fact(`${plural(totals.blockedTasks, 'task')} blocked`));
  if (waitingReviews.length) out.push(fact(`${plural(waitingReviews.length, 'pull request')} waiting for a first review; longest ${plural(waitingReviews[0].waitingDays, 'day')}`, waitingReviews.slice(0, 5).map((q) => ref('external_record', q.pullRequest.id))));
  const lagging = followThrough.filter((m) => m.overdue > 0);
  if (lagging.length) out.push(fact(`${plural(lagging.length, 'meeting')} with overdue follow-up tasks`, lagging.slice(0, 5).map((m) => ref('meeting', m.meeting.id))));
  const busiest = workload[0];
  if (busiest && workload.length > 1 && busiest.open >= 2 * Math.max(1, workload[workload.length - 1].open)) {
    out.push(inference(`${busiest.user.name ?? 'One person'} holds ${plural(busiest.open, 'open task')}, the most in view`, 'Highest open-task count and at least twice the lowest'));
  }
  if (totals.crossProjectDependencies) out.push(fact(`${plural(totals.crossProjectDependencies, 'dependency', 'dependencies')} across projects still open`));
  if (totals.completedTasks || totals.pullRequestsMerged) out.push(fact(`In this period: ${plural(totals.completedTasks, 'task')} completed, ${plural(totals.pullRequestsMerged, 'pull request')} merged`));
  if (!out.length) out.push(fact('Nothing overdue, blocked or waiting in view'));
  return out;
}
