import { useState } from 'react';
import { approveActionItem, rejectActionItem, reopenActionItem, setActionItemProject, updateActionItem } from '../../api/actionItems.js';
import { formatDate, formatTimestamp } from '../../utils/format.js';
import { ProjectSelect } from '../ProjectSelect.jsx';
import { Button, ErrorAlert, inputClass } from '../ui.jsx';
import { ActionItemForm } from './ActionItemForm.jsx';

const STATUS = {
  pending: { label: 'Needs review', cls: 'bg-amber-100 text-amber-800', border: 'border-amber-200' },
  approved: { label: 'Approved', cls: 'bg-emerald-100 text-emerald-800', border: 'border-emerald-200' },
  rejected: { label: 'Rejected', cls: 'bg-slate-200 text-slate-600', border: 'border-slate-200' },
};
const PRIORITY = { high: 'bg-rose-100 text-rose-700', medium: 'bg-slate-100 text-slate-700', low: 'bg-slate-100 text-slate-500' };
const INFO_FLAGS = ['missing_deadline', 'merged_duplicates']; // mirrors backend services/review.js

/**
 * One action item. All changes go through the API; the card shows the server's response
 * (no optimistic status changes). `busy` blocks repeated clicks while a request is running.
 */
export function ActionItemCard({ item, users, projects, flagDescriptions, editable, onChange, onShowEvidence }) {
  const [mode, setMode] = useState('view'); // view | edit | reject
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState('');
  const status = STATUS[item.reviewStatus];
  const pending = item.reviewStatus === 'pending';
  const candidates = (item.reviewDetails?.assignee?.candidates ?? []).filter((c) => c.isActive && c.id !== item.assignee?.id);

  async function run(fn, after) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { actionItem } = await fn();
      onChange(actionItem, after);
      setMode('view');
      setReason('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const patch = (body, message) => run(() => updateActionItem(item.id, body), message);

  return (
    <article className={`rounded-xl border bg-white ${status.border} ${pending ? '' : 'opacity-90'}`} aria-label={item.title}>
      <div className="space-y-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded-full px-2 py-0.5 font-medium ${status.cls}`}>{status.label}</span>
          <span className={`rounded-full px-2 py-0.5 capitalize ${PRIORITY[item.priority]}`}>{item.priority} priority</span>
          {item.source === 'manual' ? (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-sky-700">Added manually</span>
          ) : (
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-violet-700">
              AI suggestion{item.aiConfidence !== null && ` · ${Math.round(item.aiConfidence * 100)}% confidence`}
            </span>
          )}
        </div>

        {mode === 'edit' ? (
          <ActionItemForm
            item={item}
            users={users}
            submitLabel="Save changes"
            dueDateHint={item.dueDateRaw ? `Said: “${item.dueDateRaw}”` : undefined}
            onSubmit={async (body) => {
              const { actionItem } = await updateActionItem(item.id, body);
              onChange(actionItem, 'Changes saved.');
              setMode('view');
            }}
            onCancel={() => setMode('view')}
          />
        ) : (
          <>
            <div>
              <h3 className="break-words text-base font-semibold text-slate-900">{item.title}</h3>
              {item.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">{item.description}</p>}
            </div>

            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Assignee</dt>
                <dd className="mt-0.5">
                  {item.assignee ? (
                    <span className={item.assignee.isActive ? 'text-slate-900' : 'text-red-700'}>
                      {item.assignee.fullName}
                      {!item.assignee.isActive && ' (inactive)'}
                    </span>
                  ) : (
                    <span className="text-amber-700">Unassigned</span>
                  )}
                  {item.assigneeNameRaw && item.assigneeNameRaw !== item.assignee?.fullName && (
                    <span className="block text-xs text-slate-500">Mentioned as “{item.assigneeNameRaw}”</span>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">Due</dt>
                <dd className="mt-0.5">
                  {item.dueDate ? <span className="text-slate-900">{formatDate(item.dueDate)}</span> : <span className="text-slate-500">No date set</span>}
                  {item.dueDateRaw && <span className="block text-xs text-slate-500">Said: “{item.dueDateRaw}”</span>}
                </dd>
              </div>
              {/* The project can change in any review state: it doesn't alter the reviewed task. */}
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  <label htmlFor={`item-project-${item.id}`}>Project</label>
                </dt>
                <dd className="mt-0.5 sm:max-w-xs">
                  <ProjectSelect
                    id={`item-project-${item.id}`}
                    value={item.projectId}
                    current={item.project}
                    projects={projects}
                    disabled={busy}
                    onChange={(projectId) =>
                      run(() => setActionItemProject(item.id, projectId), projectId ? 'Project updated.' : 'Project removed.')
                    }
                  />
                </dd>
              </div>
            </dl>

            {item.flags.length > 0 && (
              <ul className="space-y-1.5" aria-label="Review flags">
                {item.flags.map((flag) => {
                  const info = INFO_FLAGS.includes(flag);
                  return (
                    <li
                      key={flag}
                      className={`flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-1.5 text-sm ${info ? 'bg-slate-50 text-slate-600' : 'bg-amber-50 text-amber-900'}`}
                    >
                      <span>{flagDescriptions[flag] ?? flag.replaceAll('_', ' ')}</span>
                      {pending && editable && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => patch({ resolveFlags: [flag] }, 'Flag resolved.')}
                          className="rounded px-1.5 py-0.5 text-xs font-medium underline-offset-2 hover:underline disabled:opacity-50"
                        >
                          Mark resolved
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            {pending && editable && candidates.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-slate-600">Possible matches:</span>
                {candidates.map((c) => (
                  <Button key={c.id} variant="secondary" className="!px-2 !py-1 text-xs" disabled={busy} onClick={() => patch({ assigneeUserId: c.id }, `Assigned to ${c.fullName}.`)}>
                    Assign {c.fullName}
                  </Button>
                ))}
              </div>
            )}

            <Evidence item={item} onShowEvidence={onShowEvidence} />
          </>
        )}

        <ErrorAlert error={error && <ErrorText error={error} />} />

        {mode === 'reject' && (
          <div className="space-y-2 rounded-md border border-slate-200 p-3">
            <label className="block text-sm">
              <span className="font-medium text-slate-700">Reason (optional)</span>
              <input className={`${inputClass} mt-1`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Only a suggestion, not agreed" />
            </label>
            <div className="flex gap-2">
              <Button variant="danger" disabled={busy} onClick={() => run(() => rejectActionItem(item.id, reason.trim()), 'Item rejected.')}>
                {busy ? 'Rejecting…' : 'Confirm reject'}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setMode('view')}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {editable && mode === 'view' && (
          <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3">
            {pending ? (
              <>
                <Button disabled={busy} onClick={() => run(() => approveActionItem(item.id), 'Item approved.')}>
                  {busy ? 'Working…' : 'Approve'}
                </Button>
                <Button variant="secondary" disabled={busy} onClick={() => setMode('edit')}>
                  Edit
                </Button>
                <Button variant="danger" disabled={busy} onClick={() => setMode('reject')}>
                  Reject
                </Button>
              </>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => run(() => reopenActionItem(item.id), 'Item moved back to review.')}>
                {busy ? 'Working…' : 'Reopen'}
              </Button>
            )}
          </div>
        )}
        {item.reviewStatus === 'rejected' && item.reviewDetails?.rejection?.reason && (
          <p className="text-xs text-slate-500">Rejection reason: {item.reviewDetails.rejection.reason}</p>
        )}
      </div>
    </article>
  );
}

function ErrorText({ error }) {
  return (
    <>
      {error.message}
      {error.details?.length > 0 && (
        <ul className="mt-1 list-disc pl-5">
          {error.details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function Evidence({ item, onShowEvidence }) {
  if (item.source === 'manual') {
    return <p className="text-xs text-slate-500">Added manually — no transcript evidence.</p>;
  }
  if (item.evidence.length === 0) {
    return <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">No verified transcript evidence for this item.</p>;
  }
  return (
    <section aria-label="Transcript evidence" className="space-y-2">
      <p className="text-xs text-slate-500">
        Where this was discussed. Evidence supports the suggestion; check that the task, owner and deadline are right.
      </p>
      {item.evidence.map((e) => (
        <figure key={e.id} className="rounded-md border-l-2 border-slate-300 bg-slate-50 px-3 py-2">
          <blockquote className="break-words text-sm italic text-slate-800">“{e.excerpt}”</blockquote>
          <figcaption className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
            <span>{e.speaker ?? 'Unknown speaker'}</span>
            {e.startSec !== null && <span className="font-mono">{formatTimestamp(e.startSec)}</span>}
            {e.segmentId && onShowEvidence && (
              <button type="button" className="font-medium text-slate-700 underline-offset-2 hover:underline" onClick={() => onShowEvidence(e.segmentId)}>
                Show in transcript
              </button>
            )}
          </figcaption>
        </figure>
      ))}
    </section>
  );
}
