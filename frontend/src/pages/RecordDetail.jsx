import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { getExternalRecord } from '../api/workRecords.js';
import { ActivityList } from '../components/ActivityList.jsx';
import { ProviderBadge, RecordLink, SOURCE_STATUS, SourceLink, recordTypeLabel } from '../components/records.jsx';
import { RelatedRecords } from '../components/RelatedRecords.jsx';
import { Card, ErrorAlert, Loading } from '../components/ui.jsx';
import { formatDateTime } from '../utils/format.js';

const STATUS_LABEL = { todo: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Closed', unknown: '—' };

/** Highlights from provider metadata, in plain words (anything else stays out of the way). */
function metadataFacts(m = {}) {
  const facts = [];
  if (m.labels?.length) facts.push(['Labels', m.labels.join(', ')]);
  if (m.assignees?.length) facts.push(['Assignees', m.assignees.map((a) => a.login).join(', ')]);
  if (m.requestedReviewers?.length) facts.push(['Review requested from', m.requestedReviewers.map((a) => a.login).join(', ')]);
  if (m.headRef) facts.push(['Branches', `${m.headRef} → ${m.baseRef}`]);
  if (m.milestone?.title) facts.push(['Milestone', m.milestone.title]);
  if (m.draft) facts.push(['Draft', 'yes']);
  if (m.mergedAt) facts.push(['Merged', formatDateTime(m.mergedAt)]);
  if (m.closedAt && !m.mergedAt) facts.push(['Closed', formatDateTime(m.closedAt)]);
  if (m.sha) facts.push(['Commit', m.sha]);
  if (m.branch) facts.push(['Branch', m.branch]);
  if (m.path) facts.push(['File', `${m.path}${m.line ? `:${m.line}` : ''}`]);
  if (m.visibility) facts.push(['Visibility', m.visibility]);
  if (m.defaultBranch) facts.push(['Default branch', m.defaultBranch]);
  return facts;
}

/** A synced record (GitHub issue, pull request, commit, …) with its timeline and relationships. */
export function RecordDetailPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getExternalRecord(id)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="space-y-4">
        <Link to="/activity" className="text-sm text-slate-500 hover:underline">
          ← Activity
        </Link>
        <ErrorAlert error={error.status === 404 ? 'This record doesn’t exist or you don’t have access to it.' : error} />
      </div>
    );
  }
  if (!data) return <Loading />;
  const { record: r, parent, children, activities } = data;
  const banner = SOURCE_STATUS[r.sourceStatus];
  const facts = metadataFacts(r.metadata ?? {});

  return (
    <div className="space-y-6">
      <div>
        <Link to={r.project ? `/activity?projectId=${r.project.id}` : '/activity'} className="text-sm text-slate-500 hover:underline">
          ← {r.project ? `${r.project.name} activity` : 'Activity'}
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ProviderBadge provider={r.provider} />
          <span className="text-sm text-slate-500">{recordTypeLabel(r.recordType)}</span>
          {r.externalKey && <span className="text-sm text-slate-500">{r.externalKey}</span>}
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">{r.state ?? STATUS_LABEL[r.statusCategory]}</span>
        </div>
        <h1 className="mt-1 break-words text-2xl font-semibold">{r.title}</h1>
        <div className="mt-1 flex flex-wrap gap-x-4 text-sm text-slate-500">
          {r.author && <span>by {r.author.login ?? r.author.displayName}</span>}
          {r.project ? (
            <Link to={`/projects/${r.project.id}`} className="hover:underline">
              Project: {r.project.name}
            </Link>
          ) : (
            <span>No project</span>
          )}
          <SourceLink url={r.url} provider={r.provider} />
        </div>
      </div>

      {banner && (
        <p role="status" className={`rounded-md px-3 py-2 text-sm ${banner.cls}`}>
          {banner.text}
        </p>
      )}

      <Card title="Details">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Fact label="Status">{STATUS_LABEL[r.statusCategory]}</Fact>
          <Fact label="Last changed at the source">{formatDateTime(r.sourceUpdatedAt)}</Fact>
          <Fact label="Created at the source">{formatDateTime(r.sourceCreatedAt)}</Fact>
          <Fact label="Source identity">
            {r.provider} · {r.sourceInstance} · {r.externalId}
          </Fact>
          {facts.map(([k, v]) => (
            <Fact key={k} label={k}>
              {v}
            </Fact>
          ))}
          {r.projectLocked && <Fact label="Project">Set by an admin (kept when the repository is re-mapped)</Fact>}
        </dl>
        {parent && (
          <p className="mt-4 text-sm">
            Part of {recordTypeLabel(parent.recordType).toLowerCase()} <RecordLink summary={parent} />
          </p>
        )}
        {r.body && <div className="mt-4 whitespace-pre-wrap break-words rounded-md bg-slate-50 p-3 text-sm text-slate-800">{r.body}</div>}
        {r.metadata?.truncated && <p className="mt-1 text-xs text-slate-500">Long text was shortened; open it at the source for the full version.</p>}
      </Card>

      {children.length > 0 && (
        <Card title={`Discussion (${children.length})`}>
          <ul className="space-y-3">
            {children.map((c) => (
              <li key={c.id} className="text-sm">
                <span className="text-xs text-slate-500">
                  {recordTypeLabel(c.recordType)} · {c.author?.login ?? 'someone'} · {formatDateTime(c.sourceUpdatedAt)}
                </span>
                <div>
                  <RecordLink summary={{ ...c, type: 'external_record', key: null }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <RelatedRecords type="external_record" id={r.id} />

      <Card title="Timeline">
        {activities.length === 0 ? <p className="text-sm text-slate-500">No activity recorded.</p> : <ActivityList activities={activities} showProject={false} />}
      </Card>
    </div>
  );
}

function Fact({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 break-words text-slate-900">{children}</dd>
    </div>
  );
}
