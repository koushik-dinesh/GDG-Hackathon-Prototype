import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { listMyTasks } from '../../api/tasks.js';
import { useAuth } from '../../auth/AuthContext.jsx';
import { EmptyState } from '../../components/EmptyState.jsx';
import { PRIORITY_STYLE, STATUS_LABEL, TaskStatusBadge, TaskStatusControl } from '../../components/tasks/TaskStatus.jsx';
import { ErrorAlert, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDate } from '../../utils/format.js';

const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };
const SORTS = {
  due: { label: 'Due date (soonest)', fn: (a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] },
  priority: { label: 'Priority (highest)', fn: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999') },
  meeting: { label: 'Meeting (newest)', fn: (a, b) => String(b.meeting.scheduledAt ?? '').localeCompare(String(a.meeting.scheduledAt ?? '')) },
};
const SUMMARY_CARDS = [
  ['total', 'Total'],
  ['todo', 'Not started'],
  ['inProgress', 'In progress'],
  ['done', 'Completed'],
  ['overdue', 'Overdue'],
];

export function MyTasks() {
  const { user } = useAuth();
  const [data, setData] = useState(null); // { tasks, summary, today }
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState('open');
  const [priority, setPriority] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('due');

  const load = useCallback(
    () =>
      listMyTasks()
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch(setError),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    if (!data) return [];
    const needle = search.trim().toLowerCase();
    return data.tasks
      .filter((t) => (status === 'all' ? true : status === 'open' ? t.taskStatus !== 'done' : t.taskStatus === status))
      .filter((t) => !priority || t.priority === priority)
      .filter((t) => !overdueOnly || t.overdue)
      .filter((t) => !needle || t.title.toLowerCase().includes(needle) || t.meeting.title.toLowerCase().includes(needle))
      .sort(SORTS[sort].fn);
  }, [data, status, priority, overdueOnly, search, sort]);

  // After a status change, reload from the server so counts and overdue flags stay authoritative.
  async function handleUpdated(task) {
    setNotice(`“${task.title}” is now ${STATUS_LABEL[task.taskStatus].toLowerCase()}.`);
    await load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">My tasks</h1>
        <p className="mt-1 text-sm text-slate-500">Signed in as {user.email}</p>
      </div>

      {error && !data && <ErrorAlert error={`Could not load your tasks: ${error.message}`} />}
      {!data && !error && <Loading label="Loading your tasks…" />}

      {data && (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {SUMMARY_CARDS.map(([key, label]) => (
              <div key={key} className={`rounded-xl border bg-white px-4 py-3 ${key === 'overdue' && data.summary.overdue ? 'border-red-200' : 'border-slate-200'}`}>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className={`mt-1 text-2xl font-semibold ${key === 'overdue' && data.summary.overdue ? 'text-red-700' : 'text-slate-900'}`}>{data.summary[key]}</dd>
              </div>
            ))}
          </dl>
          {data.summary.blocked > 0 && <p className="text-sm text-amber-800">{data.summary.blocked} task{data.summary.blocked === 1 ? ' is' : 's are'} blocked.</p>}

          {data.tasks.length === 0 ? (
            <EmptyState title="No tasks assigned">Tasks approved from your meetings will appear here.</EmptyState>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_auto] lg:items-end">
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">Search</span>
                  <input type="search" className={`${inputClass} mt-1`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Task or meeting title" />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">Status</span>
                  <select className={`${inputClass} mt-1`} value={status} onChange={(e) => setStatus(e.target.value)}>
                    <option value="open">Open (not completed)</option>
                    <option value="all">All</option>
                    {Object.entries(STATUS_LABEL).map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">Priority</span>
                  <select className={`${inputClass} mt-1`} value={priority} onChange={(e) => setPriority(e.target.value)}>
                    <option value="">Any</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-slate-700">Sort by</span>
                  <select className={`${inputClass} mt-1`} value={sort} onChange={(e) => setSort(e.target.value)}>
                    {Object.entries(SORTS).map(([v, s]) => (
                      <option key={v} value={v}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
                  <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
                  Overdue only
                </label>
              </div>

              <SuccessAlert>{notice}</SuccessAlert>
              {error && <ErrorAlert error={`Could not refresh your tasks: ${error.message}`} />}

              {visible.length === 0 ? (
                <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">No tasks match these filters.</p>
              ) : (
                <ul className="space-y-3" aria-label="Tasks">
                  {visible.map((t) => (
                    <li key={t.id}>
                      <TaskCard task={t} onUpdated={handleUpdated} />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function TaskCard({ task, onUpdated }) {
  return (
    <article aria-label={task.title} className={`rounded-xl border bg-white p-4 sm:p-5 ${task.overdue ? 'border-red-200' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-base font-semibold text-slate-900">
            <Link to={`/my/tasks/${task.id}`} className="hover:underline">
              {task.title}
            </Link>
          </h2>
          <p className="mt-0.5 break-words text-sm text-slate-500">
            From “{task.meeting.title}”{task.project && <> · Project: {task.project.name}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <TaskStatusBadge status={task.taskStatus} />
          <span className={`rounded-full px-2 py-0.5 capitalize ${PRIORITY_STYLE[task.priority]}`}>{task.priority} priority</span>
        </div>
      </div>
      {task.description && <p className="mt-2 line-clamp-2 break-words text-sm text-slate-600">{task.description}</p>}
      <p className="mt-2 text-sm">
        {task.dueDate ? (
          <span className={task.overdue ? 'font-medium text-red-700' : 'text-slate-700'}>
            Due {formatDate(task.dueDate)}
            {task.overdue && ' · Overdue'}
          </span>
        ) : (
          <span className="text-slate-500">No due date</span>
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3 border-t border-slate-100 pt-3">
        <TaskStatusControl task={task} onUpdated={onUpdated} compact />
        <Link to={`/my/tasks/${task.id}`} className="text-sm font-medium text-slate-700 underline-offset-2 hover:underline">
          Details
        </Link>
      </div>
    </article>
  );
}
