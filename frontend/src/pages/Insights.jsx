import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { getInsights } from '../api/insights.js';
import { listProjects } from '../api/projects.js';
import { listTeams } from '../api/teams.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { ProviderBadge } from '../components/records.jsx';
import { Card, ErrorAlert, Loading, inputClass } from '../components/ui.jsx';
import { formatDate, formatDateTime } from '../utils/format.js';

const PERIODS = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
];

const HEALTH = {
  on_track: { label: 'On track', className: 'bg-emerald-100 text-emerald-800' },
  at_risk: { label: 'At risk', className: 'bg-amber-100 text-amber-800' },
  off_track: { label: 'Off track', className: 'bg-red-100 text-red-700' },
  completed: { label: 'Completed', className: 'bg-slate-200 text-slate-800' },
  unknown: { label: 'Not enough data', className: 'bg-slate-100 text-slate-600' },
};

const REVIEW_STAGE = {
  awaiting_review: 'Awaiting first review',
  changes_requested: 'Changes requested',
  approved_not_merged: 'Approved, not merged',
  reviewed: 'Reviewed',
};

const BLOCKER_KIND = { task_blocked: 'Blocked task', record_labelled_blocked: 'Labelled blocked', dependency: 'Waiting on another item' };

/** Where an item from the insights response opens in WorkAgent for this person. */
export function insightHref(item, user) {
  if (!item) return null;
  switch (item.type) {
    case 'external_record':
      return `/records/${item.id}`;
    case 'project':
      return `/projects/${item.id}`;
    case 'meeting':
      return user.role === 'admin' ? `/admin/meetings/${item.id}` : item.projectId ? `/projects/${item.projectId}` : null;
    case 'action_item':
      if (item.assigneeUserId === user.id) return `/my/tasks/${item.id}`;
      if (user.role === 'admin' && item.meetingId) return `/admin/meetings/${item.meetingId}`;
      return item.projectId ? `/projects/${item.projectId}` : null;
    default:
      return null;
  }
}

function ItemLink({ item }) {
  const { user } = useAuth();
  const href = insightHref(item, user);
  const label = item.key ? `${item.key} ${item.title ?? ''}`.trim() : (item.title ?? `#${item.id}`);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      {item.provider && <ProviderBadge provider={item.provider} />}
      {href ? (
        <Link to={href} className="truncate font-medium text-slate-900 hover:underline">
          {label}
        </Link>
      ) : (
        <span className="truncate font-medium text-slate-900">{label}</span>
      )}
    </span>
  );
}

function KindBadge({ kind, rule }) {
  return kind === 'inference' ? (
    <span title={rule ? `Rule: ${rule}` : undefined} className="shrink-0 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-800">
      Inference
    </span>
  ) : (
    <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">Fact</span>
  );
}

function Stat({ label, value, tone = '' }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone}`}>{value ?? '—'}</p>
    </div>
  );
}

function Section({ title, empty, items, children }) {
  return (
    <Card title={title}>
      {items.length === 0 ? <p className="text-sm text-slate-500">{empty}</p> : <ul className="divide-y divide-slate-100">{children}</ul>}
    </Card>
  );
}

function Trend({ weeks }) {
  const max = Math.max(1, ...weeks.flatMap((w) => [w.tasksCompleted, w.tasksCreated, w.pullRequestsMerged, w.recordsClosed]));
  const bar = (n, color) => <span className={`block h-2 rounded ${color}`} style={{ width: `${(n / max) * 100}%`, minWidth: n ? 4 : 0 }} />;
  return (
    <Card title="Weekly trend">
      {weeks.length === 0 ? (
        <p className="text-sm text-slate-500">No recorded activity in this period.</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-sky-500" /> Tasks created</span>
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-emerald-500" /> Tasks completed</span>
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-violet-500" /> PRs merged</span>
            <span className="flex items-center gap-1"><span className="h-2 w-3 rounded bg-slate-400" /> Records closed</span>
          </div>
          <table className="w-full text-sm" aria-label="Weekly trend">
            <tbody>
              {weeks.map((w) => (
                <tr key={w.weekStart} className="align-middle">
                  <td className="w-28 py-1 pr-3 text-xs text-slate-500">Week of {formatDate(w.weekStart)}</td>
                  <td className="space-y-0.5 py-1">
                    {bar(w.tasksCreated, 'bg-sky-500')}
                    {bar(w.tasksCompleted, 'bg-emerald-500')}
                    {bar(w.pullRequestsMerged, 'bg-violet-500')}
                    {bar(w.recordsClosed, 'bg-slate-400')}
                  </td>
                  <td className="w-40 py-1 pl-3 text-right text-xs text-slate-500">
                    {w.tasksCreated} / {w.tasksCompleted} / {w.pullRequestsMerged} / {w.recordsClosed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Card>
  );
}

/**
 * Insights (Phase 7): project health, overdue work, blockers and dependencies, review progress,
 * meeting follow-through, workload, stalled work and trends — for what the signed-in person may see.
 * Every figure is a count of real records; judgements are labelled "Inference" with their rule.
 */
export function InsightsPage({ title = 'Insights' }) {
  const { user } = useAuth();
  const [projectId, setProjectId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [period, setPeriod] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [projects, setProjects] = useState([]);
  const [teams, setTeams] = useState([]);

  useEffect(() => {
    listProjects()
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]));
    listTeams()
      .then((d) => setTeams(d.teams ?? []))
      .catch(() => setTeams([]));
  }, []);

  const params = useMemo(() => {
    const to = new Date();
    return { projectId, teamId, from: new Date(to.getTime() - period * 86_400_000).toISOString(), to: to.toISOString() };
  }, [projectId, teamId, period]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    getInsights(params)
      .then((d) => live && setData(d))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [params]);

  const t = data?.totals;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="mt-1 text-sm text-slate-500">
            {user.role === 'employee' ? 'Your tasks and the work of your projects.' : user.role === 'manager' ? 'Projects you own or belong to.' : 'Every project.'} Figures are counts of
            real records; anything marked “Inference” is a rule-based judgement.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="text-xs text-slate-500">
            Project
            <select aria-label="Project" className={`${inputClass} mt-1 block`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          {teams.length > 0 && (
            <label className="text-xs text-slate-500">
              Team
              <select aria-label="Team" className={`${inputClass} mt-1 block`} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                <option value="">Everyone</option>
                {teams.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="text-xs text-slate-500">
            Period
            <select aria-label="Period" className={`${inputClass} mt-1 block`} value={period} onChange={(e) => setPeriod(Number(e.target.value))}>
              {PERIODS.map((p) => (
                <option key={p.days} value={p.days}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <ErrorAlert error={error} />
      {!data && !error && <Loading />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Open tasks" value={t.openTasks} />
            <Stat label="Overdue tasks" value={t.overdueTasks} tone={t.overdueTasks ? 'text-red-700' : ''} />
            <Stat label="Blocked" value={t.blockedTasks + data.blockers.filter((b) => b.kind !== 'task_blocked').length} tone={t.blockedTasks ? 'text-amber-700' : ''} />
            <Stat label="Completed (period)" value={t.completedTasks} />
            <Stat label="Open pull requests" value={t.openPullRequests} />
            <Stat label="Median hours to merge" value={t.medianHoursToMerge} />
          </div>

          <Card title="Summary">
            <ul className="space-y-2" aria-label="Highlights">
              {data.highlights.map((h) => (
                <li key={h.text} className="flex items-start gap-2 text-sm">
                  <KindBadge kind={h.kind} rule={h.rule} />
                  <span>{h.text}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-slate-400">Generated {formatDateTime(data.generatedAt)} from WorkAgent data; nothing here is written by AI.</p>
          </Card>

          <Card title="Project health">
            {data.projects.length === 0 ? (
              <EmptyState title="No projects in view">Projects you own or belong to appear here.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" aria-label="Project health">
                  <thead className="text-xs text-slate-500">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Project</th>
                      <th className="py-2 pr-3 font-medium">Health</th>
                      <th className="py-2 pr-3 font-medium">Open / overdue / blocked tasks</th>
                      <th className="py-2 pr-3 font-medium">Open issues / PRs</th>
                      <th className="py-2 pr-3 font-medium">Why</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.projects.map((p) => (
                      <tr key={p.project.id} className="align-top">
                        <td className="py-2 pr-3">
                          <Link to={`/projects/${p.project.id}`} className="font-medium hover:underline">
                            {p.project.name}
                          </Link>
                          {p.health.targetDate && <p className="text-xs text-slate-500">Target {formatDate(p.health.targetDate)}</p>}
                        </td>
                        <td className="py-2 pr-3">
                          <span title={`Inference. Rule: ${p.health.assessment.rule}`} className={`rounded-full px-2 py-0.5 text-xs font-medium ${HEALTH[p.health.level].className}`}>
                            {HEALTH[p.health.level].label}
                          </span>
                        </td>
                        <td className="py-2 pr-3">
                          {p.facts.openTasks} / {p.facts.overdueTasks} / {p.facts.blockedTasks}
                        </td>
                        <td className="py-2 pr-3">
                          {p.facts.openIssues} / {p.facts.openPullRequests}
                        </td>
                        <td className="py-2 pr-3 text-xs text-slate-600">{p.health.reasons.length ? p.health.reasons.map((r) => r.text).join('; ') : 'Nothing overdue, blocked or waiting'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Section title={`Overdue tasks (${t.overdueTasks})`} empty="Nothing overdue." items={data.overdue}>
              {data.overdue.map((o) => (
                <li key={o.task.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <ItemLink item={o.task} />
                  <span className="shrink-0 text-xs text-slate-500">
                    {o.assignee?.name ?? 'Unassigned'} · due {formatDate(o.dueDate)} · <span className="text-red-700">{o.daysOverdue} d late</span>
                  </span>
                </li>
              ))}
            </Section>

            <Section title="Blockers and dependencies" empty="Nothing blocked." items={data.blockers}>
              {data.blockers.map((b) => (
                <li key={`${b.kind}:${b.item.type}:${b.item.id}:${b.blocker?.id ?? ''}`} className="space-y-1 py-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <ItemLink item={b.item} />
                    <span className="shrink-0 text-xs text-slate-500">
                      {BLOCKER_KIND[b.kind]}
                      {b.crossProject && ' · across projects'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {b.evidence.text}
                    {b.blocker && (
                      <>
                        {' '}
                        → <ItemLink item={b.blocker} />
                      </>
                    )}
                  </p>
                </li>
              ))}
            </Section>

            <Section title={`Review progress (${t.reviewsWaiting} waiting over ${data.rules.reviewWaitDays} days)`} empty="No open pull requests." items={data.reviews.queue}>
              {data.reviews.queue.map((q) => (
                <li key={q.pullRequest.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <ItemLink item={q.pullRequest} />
                  <span className="shrink-0 text-xs text-slate-500">
                    {REVIEW_STAGE[q.stage]} · {q.waitingDays} d{q.requestedReviewers.length > 0 && ` · requested: ${q.requestedReviewers.join(', ')}`}
                  </span>
                </li>
              ))}
            </Section>

            <Section title="Meeting follow-through" empty="No meetings with approved tasks in this period." items={data.followThrough}>
              {data.followThrough.map((m) => (
                <li key={m.meeting.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0">
                    <ItemLink item={m.meeting} />
                    <span className="block text-xs text-slate-500">{formatDateTime(m.meeting.at)}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {m.done}/{m.tasks} done{m.overdue > 0 && <span className="text-red-700"> · {m.overdue} overdue</span>}
                  </span>
                </li>
              ))}
            </Section>

            <Section title="Workload" empty="No assigned tasks in view." items={data.workload}>
              {data.workload.map((w) => (
                <li key={w.user.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span className="font-medium">{w.user.name}</span>
                  <span className="shrink-0 text-xs text-slate-500">
                    {w.open} open · {w.inProgress} in progress · {w.blocked} blocked · <span className={w.overdue ? 'text-red-700' : ''}>{w.overdue} overdue</span> · {w.highPriority} high · {w.completedInWindow} done
                  </span>
                </li>
              ))}
            </Section>

            <Section title={`Stalled (no update for ${data.rules.staleDays}+ days)`} empty="Nothing stalled." items={data.stalled}>
              {data.stalled.map((s) => (
                <li key={`${s.item.type}:${s.item.id}`} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <ItemLink item={s.item} />
                  <span className="shrink-0 text-xs text-slate-500">idle {s.idleDays} d</span>
                </li>
              ))}
            </Section>
          </div>

          <Trend weeks={data.trend} />
        </>
      )}
    </div>
  );
}
