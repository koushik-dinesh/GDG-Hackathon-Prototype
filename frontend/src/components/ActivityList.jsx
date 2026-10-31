import { formatDateTime } from '../utils/format.js';
import { ProviderBadge, RecordLink, recordTypeLabel } from './records.jsx';

function actorName(actor) {
  if (!actor) return null;
  return actor.name ?? actor.displayName ?? actor.login ?? null;
}

/** A timeline of unified activities (WorkAgent and connected applications), newest first. */
export function ActivityList({ activities, showProject = true, showSubject = true }) {
  return (
    <ol className="space-y-3" aria-label="Activity">
      {activities.map((a) => (
        <li key={a.id} className="flex gap-3 text-sm">
          <div className="w-36 shrink-0 text-xs text-slate-500">{formatDateTime(a.occurredAt)}</div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <ProviderBadge provider={a.provider} />
              <span className="text-slate-800">{a.summary}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
              {showSubject && a.subject && (
                <span>
                  {recordTypeLabel(a.subject.recordType)}: <RecordLink summary={a.subject} />
                </span>
              )}
              {actorName(a.actor) && <span>by {actorName(a.actor)}{a.actor.login && a.actor.name ? ` (${a.actor.login})` : ''}</span>}
              {showProject && a.project && <span>in {a.project.name}</span>}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
