import { useCallback, useEffect, useState } from 'react';
import { listLinkSuggestions, reviewRecordLink } from '../api/workRecords.js';
import { EmptyState } from '../components/EmptyState.jsx';
import { LINK_TYPE_LABEL, ProviderBadge, RecordLink, recordTypeLabel } from '../components/records.jsx';
import { Button, Card, ErrorAlert, Loading, SuccessAlert } from '../components/ui.jsx';
import { formatDateTime } from '../utils/format.js';

const MATCHER_LABEL = { 'key-reference': 'Explicit reference', 'wording-overlap': 'Similar wording', 'meeting-window': 'Around a meeting' };

function End({ summary }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <ProviderBadge provider={summary.provider} />
        {recordTypeLabel(summary.recordType)}
      </div>
      <RecordLink summary={summary} />
    </div>
  );
}

/**
 * Relationship suggestions waiting for review (Phase 5). WorkAgent proposes them from explicit
 * references, similar wording and meeting timing; nothing is linked until a person confirms it.
 * Admins see all; managers the ones within projects they manage.
 */
export function SuggestionsPage() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);

  const load = useCallback(
    () =>
      listLinkSuggestions()
        .then((d) => {
          setItems(d.suggestions);
          setError(null);
        })
        .catch(setError),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function review(s, status) {
    if (busy) return;
    setBusy(s.id);
    setError(null);
    try {
      await reviewRecordLink(s.id, status);
      setItems((list) => list.filter((x) => x.id !== s.id));
      setNotice(status === 'confirmed' ? 'Relationship confirmed.' : 'Suggestion rejected; it won’t be suggested again.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Suggested relationships</h1>
        <p className="mt-1 text-sm text-slate-500">
          WorkAgent noticed these records may be related. Nothing is linked until you confirm it; rejected suggestions are not proposed again.
        </p>
      </div>
      <SuccessAlert>{notice}</SuccessAlert>
      <ErrorAlert error={error} />
      {!items && !error && <Loading />}
      {items?.length === 0 && <EmptyState title="Nothing to review">New suggestions appear here as work is synced and meetings and tasks change.</EmptyState>}
      {items?.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100" aria-label="Suggestions">
            {items.map((s) => (
              <li key={s.id} className="space-y-2 py-3" aria-label={`${s.from.title} ${s.linkType} ${s.to.title}`}>
                <div className="grid items-center gap-3 sm:grid-cols-[1fr_auto_1fr]">
                  <End summary={s.from} />
                  <span className="text-sm text-slate-500">{LINK_TYPE_LABEL[s.linkType]}</span>
                  <End summary={s.to} />
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-slate-500">
                    {MATCHER_LABEL[s.evidence?.matcher] ?? 'Suggested'} · {Math.round((s.confidence ?? 0) * 100)}% confidence
                    {s.evidence?.reason && ` · ${s.evidence.reason}`} · {formatDateTime(s.createdAt)}
                  </p>
                  <div className="flex gap-2">
                    <Button className="!px-2 !py-1 text-xs" disabled={busy === s.id} onClick={() => review(s, 'confirmed')}>
                      Confirm
                    </Button>
                    <Button variant="danger" className="!px-2 !py-1 text-xs" disabled={busy === s.id} onClick={() => review(s, 'rejected')}>
                      Reject
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
