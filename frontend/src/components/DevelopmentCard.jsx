import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listActivities, listExternalRecords } from '../api/workRecords.js';
import { formatDateTime } from '../utils/format.js';
import { Card, ErrorAlert, Loading } from './ui.jsx';

const KIND = { issue: 'Issue', pull_request: 'Pull request' };
const STATUS = {
  todo: { label: 'Open', cls: 'bg-sky-50 text-sky-800' },
  in_progress: { label: 'In progress', cls: 'bg-amber-50 text-amber-800' },
  done: { label: 'Done', cls: 'bg-emerald-50 text-emerald-800' },
  cancelled: { label: 'Closed', cls: 'bg-slate-100 text-slate-600' },
  unknown: { label: '—', cls: 'bg-slate-100 text-slate-600' },
};

// Open links to the source application in a new tab; URLs are http(s) only (checked on ingest).
function SourceLink({ url, children }) {
  return url ? (
    <a href={url} target="_blank" rel="noreferrer noopener" className="font-medium text-slate-900 hover:underline">
      {children}
    </a>
  ) : (
    <span className="font-medium text-slate-900">{children}</span>
  );
}

/**
 * GitHub (and later other applications) work mapped to a project: open issues and pull requests,
 * and the recent activity timeline. Renders nothing when the project has no synced work.
 * The API only returns what the signed-in person may see.
 */
export function DevelopmentCard({ projectId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listExternalRecords({ projectId, recordType: 'pull_request', limit: 20 }),
      listExternalRecords({ projectId, recordType: 'issue', limit: 20 }),
      listActivities({ projectId, limit: 15 }),
    ])
      .then(([prs, issues, timeline]) => {
        if (cancelled) return;
        const open = (r) => r.statusCategory === 'todo' || r.statusCategory === 'in_progress';
        setData({ items: [...prs.records, ...issues.records].filter(open), activities: timeline.activities });
      })
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (error) return <ErrorAlert error={`Could not load development activity: ${error.message}`} />;
  if (!data) return <Loading label="Loading development activity…" />;
  if (data.items.length === 0 && data.activities.length === 0) return null;

  return (
    <Card
      title="Development"
      actions={
        <Link to={`/activity?projectId=${projectId}`} className="text-sm font-medium text-slate-700 underline-offset-2 hover:underline">
          View all activity
        </Link>
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <section aria-label="Open issues and pull requests">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Open issues &amp; pull requests</h3>
          {data.items.length === 0 ? (
            <p className="text-sm text-slate-500">Nothing open.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.items.map((r) => (
                <li key={r.id} className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS[r.statusCategory]?.cls}`}>{STATUS[r.statusCategory]?.label}</span>
                    <span className="text-xs text-slate-500">{KIND[r.recordType] ?? r.recordType}</span>
                  </div>
                  <p className="mt-0.5 break-words">
                    <Link to={`/records/${r.id}`} className="font-medium text-slate-900 hover:underline">
                      {r.title}
                    </Link>{' '}
                    <span className="text-slate-500">{r.externalKey}</span> <SourceLink url={r.url}>↗</SourceLink>
                  </p>
                  {r.author && <p className="text-xs text-slate-500">by {r.author.login ?? r.author.displayName}</p>}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-label="Recent development activity">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Recent activity</h3>
          {data.activities.length === 0 ? (
            <p className="text-sm text-slate-500">No activity yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {data.activities.map((a) => (
                <li key={a.id} className="text-slate-600">
                  <span className="text-slate-400">{formatDateTime(a.occurredAt)}</span>{' '}
                  {a.subject?.url ? <SourceLink url={a.subject.url}>{a.summary}</SourceLink> : <span>{a.summary}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Card>
  );
}
