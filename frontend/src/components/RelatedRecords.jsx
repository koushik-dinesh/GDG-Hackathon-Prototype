import { useCallback, useEffect, useState } from 'react';
import { createRecordLink, listRecordLinks, reviewRecordLink, searchRecords } from '../api/workRecords.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { INCOMING_LABEL, LINK_TYPE_LABEL, ProviderBadge, RecordLink, recordTypeLabel } from './records.jsx';
import { Button, Card, ErrorAlert, Loading, SuccessAlert, inputClass } from './ui.jsx';

const ORIGIN_LABEL = { source: 'stated by the source', manual: 'added by a person', rule: 'suggested by a rule', ai: 'suggested by AI' };
// Types a person can choose when linking (provider-only types like "includes" come from sources).
const MANUAL_TYPES = ['tracks', 'implements', 'fixes', 'references', 'related', 'discussed_in', 'blocks', 'depends_on', 'duplicates', 'same_as'];
// Search result type -> link endpoint type.
const ENDPOINT_OF = { external_record: 'external_record', action_item: 'action_item', meeting: 'meeting' };

/**
 * Relationships of one record: confirmed ones for everyone who can see both ends; suggestions and
 * rejected ones only for people who may decide (admins; managers within their projects).
 */
export function RelatedRecords({ type, id }) {
  const { user } = useAuth();
  const [links, setLinks] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(null);
  const [adding, setAdding] = useState(false);
  const mayManage = user.role === 'admin' || user.role === 'manager';

  const load = useCallback(
    () =>
      listRecordLinks(type, id)
        .then((d) => {
          setLinks(d.links);
          setError(null);
        })
        .catch(setError),
    [type, id],
  );
  useEffect(() => {
    load();
  }, [load]);

  async function review(link, status) {
    if (busy) return;
    setBusy(link.id);
    setError(null);
    try {
      await reviewRecordLink(link.id, status);
      await load();
      setNotice(status === 'confirmed' ? 'Relationship confirmed.' : 'Relationship removed (kept in history as rejected).');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const confirmed = links?.filter((l) => l.status === 'confirmed') ?? [];
  const suggested = links?.filter((l) => l.status === 'suggested') ?? [];
  const rejected = links?.filter((l) => l.status === 'rejected') ?? [];

  return (
    <Card
      title="Related records"
      actions={
        mayManage &&
        !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add relationship
          </Button>
        )
      }
    >
      <SuccessAlert>{notice}</SuccessAlert>
      <ErrorAlert error={error && (error.status === 403 ? 'You can’t change relationships of this record.' : error)} className="mb-3" />
      {adding && (
        <AddRelationship
          self={{ type, id }}
          onCancel={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false);
            await load();
            setNotice('Relationship added.');
          }}
        />
      )}
      {!links && !error && <Loading />}
      {links && confirmed.length === 0 && suggested.length === 0 && <p className="text-sm text-slate-500">No related records yet.</p>}
      {confirmed.length > 0 && <LinkList links={confirmed} busy={busy} onReview={review} />}
      {suggested.length > 0 && (
        <section aria-label="Suggested relationships" className="mt-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">Suggestions to review</h3>
          <LinkList links={suggested} busy={busy} onReview={review} />
        </section>
      )}
      {rejected.length > 0 && (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-slate-500">Rejected ({rejected.length})</summary>
          <div className="mt-2">
            <LinkList links={rejected} busy={busy} onReview={review} />
          </div>
        </details>
      )}
    </Card>
  );
}

function LinkList({ links, busy, onReview }) {
  return (
    <ul className="divide-y divide-slate-100">
      {links.map((l) => (
        <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 py-2" aria-label={`${l.linkType} ${l.other?.title ?? ''}`}>
          <div className="min-w-0 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-slate-500">{l.direction === 'outgoing' ? LINK_TYPE_LABEL[l.linkType] : INCOMING_LABEL[l.linkType]}</span>
              <ProviderBadge provider={l.other.provider} />
              <span className="text-xs text-slate-500">{recordTypeLabel(l.other.recordType)}</span>
            </div>
            <RecordLink summary={l.other} />
            <p className="text-xs text-slate-500">
              {ORIGIN_LABEL[l.origin]}
              {l.confidence !== null && l.origin !== 'source' && l.origin !== 'manual' && ` · ${Math.round(l.confidence * 100)}% confidence`}
              {l.evidence?.reason && ` · ${l.evidence.reason}`}
            </p>
          </div>
          {l.canEdit && (
            <div className="flex gap-2">
              {l.status !== 'confirmed' && (
                <Button variant="secondary" className="!px-2 !py-1 text-xs" disabled={busy === l.id} onClick={() => onReview(l, 'confirmed')}>
                  Confirm
                </Button>
              )}
              {l.status !== 'rejected' && (
                <Button variant="danger" className="!px-2 !py-1 text-xs" disabled={busy === l.id} onClick={() => onReview(l, 'rejected')}>
                  {l.status === 'suggested' ? 'Reject' : 'Remove'}
                </Button>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Pick another record with unified search, choose how they relate, save. */
function AddRelationship({ self, onCancel, onAdded }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [target, setTarget] = useState(null);
  const [linkType, setLinkType] = useState('related');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function find(e) {
    e.preventDefault();
    if (!q.trim()) return;
    setError(null);
    try {
      const d = await searchRecords({ q: q.trim(), types: 'external_record,task,meeting', limit: 8 });
      setResults(d.results.filter((r) => ENDPOINT_OF[r.type] && !(ENDPOINT_OF[r.type] === self.type && r.id === Number(self.id))));
    } catch (err) {
      setError(err);
    }
  }

  async function save() {
    if (!target || saving) return;
    setSaving(true);
    setError(null);
    try {
      await createRecordLink({ type: self.type, id: Number(self.id) }, { type: ENDPOINT_OF[target.type], id: target.id }, linkType);
      await onAdded();
    } catch (err) {
      setError(err.status === 403 ? 'You can only link records in projects you manage.' : err);
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded-md border border-slate-200 p-3">
      <form onSubmit={find} className="flex gap-2" role="search" aria-label="Find a record to link">
        <input className={inputClass} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search issues, pull requests, tasks, meetings…" aria-label="Find a record to link" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      <ErrorAlert error={error} />
      {results?.length === 0 && <p className="text-sm text-slate-500">Nothing found that you can link.</p>}
      {results?.length > 0 && (
        <ul className="max-h-56 space-y-1 overflow-y-auto" aria-label="Records to link">
          {results.map((r) => (
            <li key={`${r.type}:${r.id}`}>
              <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
                <input type="radio" name="link-target" checked={target === r} onChange={() => setTarget(r)} />
                <ProviderBadge provider={r.provider} />
                <span className="text-xs text-slate-500">{recordTypeLabel(r.recordType)}</span>
                <span className="truncate">{r.title}</span>
                {r.key && <span className="text-xs text-slate-500">{r.key}</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-slate-600" htmlFor="link-type">
          This record
        </label>
        <select id="link-type" className={`${inputClass} w-auto`} value={linkType} onChange={(e) => setLinkType(e.target.value)}>
          {MANUAL_TYPES.map((t) => (
            <option key={t} value={t}>
              {LINK_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <span className="text-sm text-slate-600">the selected one.</span>
      </div>
      <div className="flex gap-2">
        <Button onClick={save} disabled={!target || saving}>
          {saving ? 'Saving…' : 'Add relationship'}
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
