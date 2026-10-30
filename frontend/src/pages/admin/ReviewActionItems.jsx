import { useCallback, useEffect, useState } from 'react';
import { createActionItem, finishReview, getActionItems } from '../../api/meetings.js';
import { listProjects } from '../../api/projects.js';
import { listUsers } from '../../api/users.js';
import { ActionItemCard } from '../../components/review/ActionItemCard.jsx';
import { ActionItemForm } from '../../components/review/ActionItemForm.jsx';
import { ExtractionPanel } from '../../components/review/ExtractionPanel.jsx';
import { Button, ErrorAlert, Loading, SuccessAlert } from '../../components/ui.jsx';

// Mirrors REVIEWABLE_MEETING_STATUSES in backend services/review.js.
const REVIEWABLE = ['transcript_ready', 'review_pending', 'failed'];
const GROUPS = [
  ['pending', 'Needs review'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
];

/**
 * Action-item review for one meeting (PLANNING.md: ReviewActionItems).
 * `meeting` comes from the parent, which polls it while extraction runs; items are reloaded
 * whenever the meeting's status or latest extraction changes.
 */
export function ReviewActionItems({ meeting, onMeetingChanged, onShowEvidence }) {
  const [data, setData] = useState(null); // { actionItems, flagDescriptions }
  const [loadError, setLoadError] = useState(null);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState(null); // null until loaded
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState(null);

  const load = useCallback(() => {
    setLoadError(null);
    return getActionItems(meeting.id)
      .then((d) => setData({ actionItems: d.actionItems, flagDescriptions: d.flagDescriptions }))
      .catch(setLoadError);
  }, [meeting.id]);

  useEffect(() => {
    load();
  }, [load, meeting.status, meeting.extraction?.id, meeting.extraction?.status]);

  useEffect(() => {
    listUsers({ includeInactive: false })
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
    listProjects()
      .then((d) => setProjects(d.projects))
      .catch(() => setProjects([]));
  }, []);

  const editable = REVIEWABLE.includes(meeting.status);
  const items = data?.actionItems ?? [];
  const pendingAi = items.filter((i) => i.reviewStatus === 'pending' && i.source === 'ai').length;
  const pendingCount = items.filter((i) => i.reviewStatus === 'pending').length;

  function replaceItem(updated, message) {
    setData((d) => ({ ...d, actionItems: d.actionItems.map((i) => (i.id === updated.id ? updated : i)) }));
    setNotice(message ?? '');
    setFinishError(null);
  }

  async function finish() {
    if (finishing) return;
    if (!window.confirm(`Finish the review? ${pendingCount ? `${pendingCount} pending item(s) will be approved. ` : ''}Items can’t be changed afterwards.`)) return;
    setFinishing(true);
    setFinishError(null);
    try {
      await finishReview(meeting.id);
      setNotice('Review finished.');
      await onMeetingChanged();
    } catch (err) {
      setFinishError(err);
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="space-y-5">
      <ExtractionPanel meeting={meeting} pendingAiItems={pendingAi} onStarted={onMeetingChanged} />
      <SuccessAlert>{notice}</SuccessAlert>

      {loadError && <ErrorAlert error={`Could not load action items: ${loadError.message}`} />}
      {!data && !loadError && <Loading label="Loading action items…" />}

      {data && items.length > 0 && (
        <p className="text-sm text-slate-600">
          {GROUPS.map(([status, label]) => `${items.filter((i) => i.reviewStatus === status).length} ${label.toLowerCase()}`).join(' · ')}
        </p>
      )}
      {data && items.length === 0 && meeting.status !== 'extracting' && (
        <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          No action items yet{meeting.extraction?.status === 'succeeded' ? ': the AI found nothing it could support with transcript evidence.' : '.'}
        </p>
      )}

      {data &&
        GROUPS.map(([status, label]) => {
          const group = items.filter((i) => i.reviewStatus === status);
          if (group.length === 0) return null;
          return (
            <section key={status} aria-label={label} className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {label} ({group.length})
              </h3>
              {group.map((item) => (
                <ActionItemCard
                  key={item.id}
                  item={item}
                  users={users}
                  projects={projects}
                  flagDescriptions={data.flagDescriptions}
                  editable={editable}
                  onChange={replaceItem}
                  onShowEvidence={onShowEvidence}
                />
              ))}
            </section>
          );
        })}

      {editable && data && (
        <div className="space-y-4 border-t border-slate-200 pt-4">
          {adding ? (
            <div className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
              <h3 className="mb-3 text-sm font-semibold text-slate-900">Add action item</h3>
              <ActionItemForm
                users={users}
                submitLabel="Add item"
                onSubmit={async (body) => {
                  const { actionItem } = await createActionItem(meeting.id, body);
                  setData((d) => ({ ...d, actionItems: [...d.actionItems, actionItem] }));
                  setAdding(false);
                  setNotice('Action item added.');
                }}
                onCancel={() => setAdding(false)}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button variant="secondary" onClick={() => setAdding(true)}>
                Add action item
              </Button>
              {items.length > 0 && (
                <Button onClick={finish} disabled={finishing}>
                  {finishing ? 'Finishing…' : 'Finish review'}
                </Button>
              )}
            </div>
          )}
          {finishError && (
            <ErrorAlert
              error={
                <>
                  {finishError.message}
                  {finishError.details?.length > 0 && (
                    <ul className="mt-1 list-disc pl-5">
                      {finishError.details.map((d, i) => (
                        <li key={i}>{d.message}</li>
                      ))}
                    </ul>
                  )}
                </>
              }
            />
          )}
        </div>
      )}
    </div>
  );
}
