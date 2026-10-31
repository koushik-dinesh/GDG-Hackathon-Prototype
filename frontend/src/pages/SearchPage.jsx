import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { searchRecords } from '../api/workRecords.js';
import { EmptyState } from '../components/EmptyState.jsx';
import { ProviderBadge, RecordLink, recordTypeLabel } from '../components/records.jsx';
import { Button, Card, ErrorAlert, Loading, inputClass } from '../components/ui.jsx';
import { formatDateTime } from '../utils/format.js';

const TABS = [
  ['', 'Everything'],
  ['external_record', 'Issues, PRs & commits'],
  ['task', 'Tasks'],
  ['meeting', 'Meetings'],
  ['project', 'Projects'],
];
const COUNT_KEY = { external_record: 'external_record', task: 'task', meeting: 'meeting', project: 'project' };

/** Unified search across projects, meetings, tasks and connected applications. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const q = params.get('q') ?? '';
  const type = params.get('type') ?? '';
  const [input, setInput] = useState(q);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => setInput(q), [q]);
  useEffect(() => {
    if (!q.trim()) {
      setData(null);
      return;
    }
    let cancelled = false;
    setData(null);
    setError(null);
    searchRecords({ q, types: type || undefined, limit: 25 })
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [q, type]);

  function submit(e) {
    e.preventDefault();
    if (!input.trim()) return;
    navigate(`/search?${new URLSearchParams({ q: input.trim(), ...(type && { type }) })}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Search</h1>
        <p className="mt-1 text-sm text-slate-500">Projects, meetings, tasks, and issues, pull requests and commits from connected applications. Only what you can access is shown.</p>
      </div>
      <form onSubmit={submit} role="search" className="flex gap-2">
        <input className={inputClass} value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search for a title, “#12”, a commit sha…" aria-label="Search WorkAgent" autoFocus />
        <Button type="submit">Search</Button>
      </form>
      {q && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Result types">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={type === t}
              onClick={() => setParams(new URLSearchParams({ q, ...(t && { type: t }) }), { replace: true })}
              className={`rounded-md px-3 py-1.5 text-sm ${type === t ? 'bg-slate-900 text-white' : 'bg-white text-slate-700 hover:bg-slate-100'}`}
            >
              {label}
              {!type && data && t && ` (${data.counts[COUNT_KEY[t]] ?? 0})`}
            </button>
          ))}
        </div>
      )}
      <ErrorAlert error={error} />
      {q && !data && !error && <Loading label="Searching…" />}
      {data?.results.length === 0 && <EmptyState title="No results">Try other words, or check the spelling. Results only include records you can access.</EmptyState>}
      {data?.results.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100" aria-label="Search results">
            {data.results.map((r) => (
              <li key={`${r.type}:${r.id}`} className="py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <ProviderBadge provider={r.provider} />
                  <span>{recordTypeLabel(r.recordType)}</span>
                  {r.status && <span>· {String(r.status).replaceAll('_', ' ')}</span>}
                  {r.projectName && <span>· {r.projectName}</span>}
                  {r.updatedAt && <span>· {formatDateTime(r.updatedAt)}</span>}
                </div>
                <div className="mt-0.5 text-sm">
                  <RecordLink summary={r} />
                </div>
                {r.snippet && <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{r.snippet}</p>}
                {r.type === 'action_item' && r.assigneeName && <p className="text-xs text-slate-500">Assigned to {r.assigneeName}</p>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
