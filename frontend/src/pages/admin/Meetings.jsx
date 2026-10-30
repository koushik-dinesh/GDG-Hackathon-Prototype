import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listMeetings } from '../../api/meetings.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, ErrorAlert, Loading, StatusBadge, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const PAGE_SIZE = 25;
const STATUSES = ['draft', 'transcript_ready', 'review_pending', 'approved', 'emails_sent', 'failed'];

export function MeetingsPage() {
  const [status, setStatus] = useState('');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    listMeetings({ status, q: search, limit: PAGE_SIZE, offset })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e));
    return () => {
      cancelled = true;
    };
  }, [status, search, offset]);

  const filtered = Boolean(status || search);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Meetings</h1>
          <p className="mt-1 text-sm text-slate-500">Create meetings and attach their transcripts.</p>
        </div>
        <Link to="/admin/meetings/new" className="rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800">
          New meeting
        </Link>
      </div>

      <form
        className="flex flex-wrap gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setSearch(query.trim());
        }}
      >
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles…"
          aria-label="Search meetings"
          className={`${inputClass} max-w-xs`}
        />
        <select
          value={status}
          onChange={(e) => {
            setOffset(0);
            setStatus(e.target.value);
          }}
          aria-label="Filter by status"
          className={`${inputClass} max-w-[12rem]`}
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {error && <ErrorAlert error={`Could not load meetings: ${error.message}`} />}
      {!data && !error && <Loading />}
      {data?.meetings.length === 0 &&
        (filtered ? (
          <EmptyState title="No matching meetings">Try a different search or status.</EmptyState>
        ) : (
          <EmptyState title="No meetings yet">Create your first meeting to attach a transcript.</EmptyState>
        ))}

      {data?.meetings.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Title</th>
                  <th className="px-4 py-2 font-medium">When</th>
                  <th className="px-4 py-2 font-medium">Project</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Participants</th>
                  <th className="px-4 py-2 font-medium">Transcript</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.meetings.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link to={`/admin/meetings/${m.id}`} className="font-medium text-slate-900 hover:underline">
                        {m.title}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-slate-600">{formatDateTime(m.scheduledAt ?? m.createdAt)}</td>
                    <td className="px-4 py-2 text-slate-600">{m.project?.name ?? '—'}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={m.status} />
                    </td>
                    <td className="px-4 py-2 text-slate-600">{m.participantCount}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {m.transcriptSegmentCount ? `${m.transcriptSegmentCount} segments` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between text-sm text-slate-600">
            <span>
              {offset + 1}–{offset + data.meetings.length} of {data.total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={offset + PAGE_SIZE >= data.total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
