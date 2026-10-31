import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { listProjects } from '../api/projects.js';
import { listActivities, listActivityTypes } from '../api/workRecords.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { ActivityList } from '../components/ActivityList.jsx';
import { EmptyState } from '../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Loading, inputClass } from '../components/ui.jsx';

const PAGE = 30;
const SUBJECTS = [
  ['', 'Anything'],
  ['task', 'Tasks'],
  ['meeting', 'Meetings'],
  ['project', 'Projects'],
  ['issue', 'Issues'],
  ['pull_request', 'Pull requests'],
  ['commit', 'Commits'],
  ['review', 'Reviews'],
  ['comment', 'Comments'],
];
const FILTER_KEYS = ['projectId', 'provider', 'activityType', 'subjectType', 'from', 'to', 'mine'];

/**
 * The unified activity feed: WorkAgent (tasks, meetings, projects) and connected applications in
 * one timeline. Filters live in the URL, so "View all activity" links from a project open filtered.
 * The server returns only what the person may see.
 */
export function ActivityFeedPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) ?? ''])), [params]);
  const [projects, setProjects] = useState([]);
  const [types, setTypes] = useState([]);
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    listProjects({ includeArchived: true })
      .then((d) => setProjects(d.projects))
      .catch(() => setProjects([]));
    listActivityTypes()
      .then((d) => setTypes(d.activityTypes))
      .catch(() => setTypes([]));
  }, []);

  const query = useMemo(
    () => ({
      projectId: filters.projectId,
      provider: filters.provider,
      activityType: filters.activityType,
      subjectType: filters.subjectType,
      // Dates are whole days in the viewer's timezone: from 00:00 to the end of the "to" day.
      from: filters.from ? new Date(`${filters.from}T00:00:00`).toISOString() : undefined,
      to: filters.to ? new Date(new Date(`${filters.to}T00:00:00`).getTime() + 86_400_000).toISOString() : undefined,
      userId: filters.mine ? user.id : undefined,
      limit: PAGE,
    }),
    [filters, user.id],
  );

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    setError(null);
    listActivities(query)
      .then((d) => {
        if (cancelled) return;
        setItems(d.activities);
        setNext(d.next);
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [query]);

  async function loadMore() {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    try {
      const d = await listActivities({ ...query, before: next });
      setItems((list) => [...list, ...d.activities]);
      setNext(d.next);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMore(false);
    }
  }

  function set(key, value) {
    const p = new URLSearchParams(params);
    if (value) p.set(key, value);
    else p.delete(key);
    setParams(p, { replace: true });
  }

  const project = projects.find((p) => String(p.id) === filters.projectId);
  const anyFilter = FILTER_KEYS.some((k) => filters[k]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{project ? `Activity · ${project.name}` : 'Activity'}</h1>
        <p className="mt-1 text-sm text-slate-500">What happened across WorkAgent and your connected applications, newest first. You see only projects and tasks you have access to.</p>
      </div>

      <Card title="Filters" actions={anyFilter && <Button variant="link" onClick={() => setParams({}, { replace: true })}>Clear filters</Button>}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select label="Project" value={filters.projectId} onChange={(v) => set('projectId', v)} options={[['', 'All my projects'], ...projects.map((p) => [String(p.id), p.name])]} />
          <Select label="Source" value={filters.provider} onChange={(v) => set('provider', v)} options={[['', 'All sources'], ['workagent', 'WorkAgent'], ['github', 'GitHub']]} />
          <Select label="What happened" value={filters.activityType} onChange={(v) => set('activityType', v)} options={[['', 'Anything'], ...types.map((t) => [t.id, t.label])]} />
          <Select label="About" value={filters.subjectType} onChange={(v) => set('subjectType', v)} options={SUBJECTS} />
          <label className="block text-sm">
            <span className="font-medium text-slate-700">From</span>
            <input type="date" className={`${inputClass} mt-1`} value={filters.from} onChange={(e) => set('from', e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="font-medium text-slate-700">To</span>
            <input type="date" className={`${inputClass} mt-1`} value={filters.to} onChange={(e) => set('to', e.target.value)} />
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm text-slate-700">
            <input type="checkbox" checked={Boolean(filters.mine)} onChange={(e) => set('mine', e.target.checked ? '1' : '')} />
            Only things I did
          </label>
        </div>
      </Card>

      <ErrorAlert error={error && (error.status === 404 ? 'That project doesn’t exist or you don’t have access to it.' : error)} />
      {!items && !error && <Loading label="Loading activity…" />}
      {items?.length === 0 && <EmptyState title="No activity">{anyFilter ? 'Nothing matches these filters.' : 'Nothing has happened in your projects yet.'}</EmptyState>}
      {items?.length > 0 && (
        <Card>
          <ActivityList activities={items} showProject={!filters.projectId} />
          {next && (
            <div className="mt-4 text-center">
              <Button variant="secondary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Load more'}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-slate-700">{label}</span>
      <select className={`${inputClass} mt-1`} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
