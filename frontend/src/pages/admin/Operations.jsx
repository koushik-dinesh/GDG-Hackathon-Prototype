import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { retryEmail } from '../../api/emails.js';
import { cancelJob, getOpsSummary, listAiRuns, listAudit, listAuditActions, listJobs, listOpsEmails, retryJob } from '../../api/ops.js';
import { Button, Card, ErrorAlert, Loading, SuccessAlert, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';

const TABS = [
  ['overview', 'Overview'],
  ['jobs', 'Jobs'],
  ['audit', 'Audit log'],
  ['emails', 'E-mail'],
  ['ai', 'AI usage'],
];
const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'dead'];
const STATUS_TONE = { dead: 'text-red-700', failed: 'text-red-700', running: 'text-sky-700', pending: 'text-amber-700', succeeded: 'text-emerald-700', sent: 'text-emerald-700' };
const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

function Status({ value }) {
  return <span className={`text-xs font-medium ${STATUS_TONE[value] ?? 'text-slate-600'}`}>{value}</span>;
}

/** Keyset paging shared by the lists: "Load more" appends the next page. */
function usePaged(fetchPage, deps) {
  const [items, setItems] = useState(null);
  const [next, setNext] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(
    async (before) => {
      setError(null);
      try {
        const { items: page, next: n } = await fetchPage(before);
        setItems((prev) => (before ? [...(prev ?? []), ...page] : page));
        setNext(n);
      } catch (err) {
        setError(err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  useEffect(() => {
    setItems(null);
    load();
  }, [load]);
  return { items, next, error, reload: () => load(), more: () => load(next) };
}

function Overview() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    getOpsSummary().then(setData).catch(setError);
  }, []);
  if (error) return <ErrorAlert error={error} />;
  if (!data) return <Loading />;
  const j = data.jobs;
  const failing = data.integrations.connections.filter((c) => c.health === 'failing' || c.status === 'error');
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {['pending', 'running', 'failed', 'dead'].map((s) => (
          <Link key={s} to={`?tab=jobs&status=${s}`} className="rounded-xl border border-slate-200 bg-white px-4 py-3 hover:border-slate-400">
            <p className="text-xs capitalize text-slate-500">{s} jobs</p>
            <p className={`mt-1 text-2xl font-semibold ${['failed', 'dead'].includes(s) && j.byStatus[s] ? 'text-red-700' : ''}`}>{num(j.byStatus[s] ?? 0)}</p>
          </Link>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Queue">
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between"><dt className="text-slate-500">Oldest job waiting to run</dt><dd>{j.oldestDueSeconds === null ? 'none' : `${num(j.oldestDueSeconds)} s`}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Failed or dead in the last 7 days</dt><dd>{num(j.failedLast7Days)}</dd></div>
            <div className="flex justify-between"><dt className="text-slate-500">Workers with running jobs</dt><dd>{j.workers.length ? j.workers.map((w) => `${w.worker} (${w.running})`).join(', ') : 'none right now'}</dd></div>
          </dl>
          <table className="mt-4 w-full text-left text-xs" aria-label="Jobs by type">
            <thead className="text-slate-500">
              <tr><th className="py-1 font-medium">Type</th>{JOB_STATUSES.map((s) => <th key={s} className="py-1 font-medium">{s}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {Object.entries(j.byType).map(([type, counts]) => (
                <tr key={type}><td className="py-1 font-mono">{type}</td>{JOB_STATUSES.map((s) => <td key={s} className="py-1">{num(counts[s] ?? 0)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </Card>
        <Card title="Integrations">
          <p className="text-sm">
            {data.integrations.connections.length} connected · {failing.length} need attention · webhooks failed (7 days): {num(data.integrations.webhooksFailedLast7Days)} · waiting: {num(data.integrations.webhooksWaiting)}
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {failing.map((c, i) => (
              <li key={i} className="text-red-700">{c.provider}: {c.problem ?? c.health}</li>
            ))}
          </ul>
          <Link to="/admin/integrations" className="mt-3 inline-block text-sm font-medium underline">Open Integrations</Link>
        </Card>
        <Card title="E-mail">
          <p className="text-sm">{Object.keys(data.emails).length ? Object.entries(data.emails).map(([s, n]) => `${s}: ${num(n)}`).join(' · ') : 'No e-mail sent yet.'}</p>
        </Card>
        <Card title="AI usage (30 days)">
          <p className="text-sm">
            Runs: {Object.entries(data.ai.last30Days).map(([s, n]) => `${s} ${num(n)}`).join(' · ') || 'none'} · tokens in {num(data.ai.tokens.input)} / out {num(data.ai.tokens.output)}
          </p>
          <p className="mt-1 text-sm">{data.ai.priced ? `Estimated cost: $${data.ai.costUsd.toFixed(2)}` : 'Cost not shown: set AI_PRICE_INPUT_USD_PER_MTOK and AI_PRICE_OUTPUT_USD_PER_MTOK to your contract prices.'}</p>
        </Card>
      </div>
    </div>
  );
}

function Jobs() {
  const [search, setSearch] = useSearchParams();
  const status = search.get('status') ?? '';
  const type = search.get('type') ?? '';
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState(null);
  const list = usePaged(async (before) => {
    const d = await listJobs({ status, type, before });
    return { items: d.jobs, next: d.next };
  }, [status, type]);
  const set = (k, v) => {
    const p = new URLSearchParams(search);
    if (v) p.set(k, v);
    else p.delete(k);
    setSearch(p, { replace: true });
  };
  async function act(fn, job, label) {
    setActionError(null);
    try {
      await fn(job.id);
      setNotice(`Job ${job.id} ${label}.`);
      list.reload();
    } catch (err) {
      setActionError(err);
    }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <select aria-label="Job status" className={inputClass} value={status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option>
          {JOB_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <input aria-label="Job type" placeholder="Type, e.g. integration.sync" className={inputClass} defaultValue={type} onBlur={(e) => set('type', e.target.value.trim())} />
      </div>
      <SuccessAlert>{notice}</SuccessAlert>
      <ErrorAlert error={actionError ?? list.error} />
      {!list.items && !list.error && <Loading />}
      {list.items?.length === 0 && <p className="text-sm text-slate-500">No jobs match.</p>}
      {list.items?.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100" aria-label="Jobs">
            {list.items.map((j) => (
              <li key={j.id} className="space-y-1 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span><span className="font-mono">#{j.id} {j.type}</span> · <Status value={j.status} /> · attempt {j.attempts}/{j.maxAttempts}</span>
                  <span className="flex gap-2">
                    {j.actions.retry && <Button className="!px-2 !py-1 text-xs" onClick={() => act(retryJob, j, 'queued again')}>Retry</Button>}
                    {j.actions.cancel && <Button variant="secondary" className="!px-2 !py-1 text-xs" onClick={() => act(cancelJob, j, 'cancelled')}>Cancel</Button>}
                  </span>
                </div>
                <p className="text-xs text-slate-500">
                  {JSON.stringify(j.payload)} · created {formatDateTime(j.createdAt)} · updated {formatDateTime(j.updatedAt)}{j.worker && ` · ${j.worker}`}
                </p>
                {j.lastError && <p className="text-xs text-red-700">{j.lastError}</p>}
                {j.actions.instead && <p className="text-xs text-slate-500">{j.actions.instead}</p>}
              </li>
            ))}
          </ul>
          {list.next && <Button variant="secondary" className="mt-3" onClick={list.more}>Load more</Button>}
        </Card>
      )}
    </div>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const [actions, setActions] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    listAuditActions().then((d) => setActions(d.actions)).catch(() => setActions([]));
  }, []);
  const list = usePaged(async (before) => {
    const d = await listAudit({ action, before });
    return { items: d.entries, next: d.next };
  }, [action]);
  const groups = [...new Set(actions.map((a) => `${a.action.split('.')[0]}.`))];
  return (
    <div className="space-y-4">
      <select aria-label="Action" className={inputClass} value={action} onChange={(e) => setAction(e.target.value)}>
        <option value="">All actions</option>
        {groups.map((g) => <option key={g} value={g}>{g}*</option>)}
        {actions.map((a) => <option key={a.action} value={a.action}>{a.action} ({a.count})</option>)}
      </select>
      <ErrorAlert error={list.error} />
      {!list.items && !list.error && <Loading />}
      {list.items && (
        <Card>
          <ul className="divide-y divide-slate-100" aria-label="Audit log">
            {list.items.map((e) => (
              <li key={e.id} className="py-2 text-sm">
                <button type="button" className="flex w-full flex-wrap justify-between gap-2 text-left" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                  <span><span className="font-mono">{e.action}</span> · {e.entityType}{e.entityId ? ` #${e.entityId}` : ''}</span>
                  <span className="text-xs text-slate-500">{e.actor ? e.actor.name ?? e.actor.email : 'system'} · {formatDateTime(e.createdAt)}</span>
                </button>
                {open === e.id && (
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-50 p-2 text-xs">{JSON.stringify({ before: e.before, after: e.after, ip: e.ip }, null, 2)}</pre>
                )}
              </li>
            ))}
          </ul>
          {list.next && <Button variant="secondary" className="mt-3" onClick={list.more}>Load more</Button>}
        </Card>
      )}
    </div>
  );
}

function Emails() {
  const [status, setStatus] = useState('');
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState(null);
  const list = usePaged(async (before) => {
    const d = await listOpsEmails({ status, before });
    return { items: d.emails, next: d.next };
  }, [status]);
  async function retry(e) {
    setActionError(null);
    try {
      await retryEmail(e.id);
      setNotice(`E-mail to ${e.to} queued again.`);
      list.reload();
    } catch (err) {
      setActionError(err);
    }
  }
  return (
    <div className="space-y-4">
      <select aria-label="E-mail status" className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
        <option value="">Any status</option>
        {['queued', 'sending', 'sent', 'retry', 'failed'].map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      <SuccessAlert>{notice}</SuccessAlert>
      <ErrorAlert error={actionError ?? list.error} />
      {!list.items && !list.error && <Loading />}
      {list.items?.length === 0 && <p className="text-sm text-slate-500">No e-mail matches.</p>}
      {list.items?.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100" aria-label="E-mail">
            {list.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  {e.subject} → {e.to} · <Status value={e.status} />
                  <span className="block text-xs text-slate-500">
                    <Link to={`/admin/meetings/${e.meeting.id}`} className="underline">{e.meeting.title}</Link> · {formatDateTime(e.sentAt ?? e.createdAt)} · attempts {e.attempts}{e.lastError && ` · ${e.lastError}`}
                  </span>
                </span>
                {e.status === 'failed' && <Button className="!px-2 !py-1 text-xs" onClick={() => retry(e)}>Retry</Button>}
              </li>
            ))}
          </ul>
          {list.next && <Button variant="secondary" className="mt-3" onClick={list.more}>Load more</Button>}
        </Card>
      )}
    </div>
  );
}

function AiRuns() {
  const [priced, setPriced] = useState(false);
  const list = usePaged(async (before) => {
    const d = await listAiRuns({ before });
    setPriced(d.priced);
    return { items: d.runs, next: d.next };
  }, []);
  return (
    <div className="space-y-4">
      {!priced && <p className="text-xs text-slate-500">Costs are not shown until AI prices are configured on the server.</p>}
      <ErrorAlert error={list.error} />
      {!list.items && !list.error && <Loading />}
      {list.items?.length === 0 && <p className="text-sm text-slate-500">No extraction runs yet.</p>}
      {list.items?.length > 0 && (
        <Card>
          <table className="w-full text-left text-sm" aria-label="AI runs">
            <thead className="text-xs text-slate-500">
              <tr><th className="py-1 font-medium">Meeting</th><th className="py-1 font-medium">Model</th><th className="py-1 font-medium">Status</th><th className="py-1 font-medium">Tokens in / out</th>{priced && <th className="py-1 font-medium">Cost</th>}<th className="py-1 font-medium">When</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {list.items.map((r) => (
                <tr key={r.id} className="align-top">
                  <td className="py-1"><Link to={`/admin/meetings/${r.meeting.id}`} className="underline">{r.meeting.title}</Link>{r.error && <span className="block text-xs text-red-700">{r.error}</span>}</td>
                  <td className="py-1 font-mono text-xs">{r.model}</td>
                  <td className="py-1"><Status value={r.status} /></td>
                  <td className="py-1">{num(r.inputTokens)} / {num(r.outputTokens)}</td>
                  {priced && <td className="py-1">{r.costUsd === null ? '—' : `$${r.costUsd.toFixed(2)}`}</td>}
                  <td className="py-1 text-xs text-slate-500">{formatDateTime(r.createdAt)}{r.durationSeconds !== null && ` · ${r.durationSeconds} s`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {list.next && <Button variant="secondary" className="mt-3" onClick={list.more}>Load more</Button>}
        </Card>
      )}
    </div>
  );
}

/** Phase 8: what the background machinery is doing — jobs, audit log, e-mail and AI usage. Admins only. */
export function OperationsPage() {
  const [search, setSearch] = useSearchParams();
  const tab = TABS.some(([id]) => id === search.get('tab')) ? search.get('tab') : 'overview';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Operations</h1>
        <p className="mt-1 text-sm text-slate-500">Background jobs, the audit trail, e-mail delivery and AI usage.</p>
      </div>
      <nav className="flex flex-wrap gap-1 border-b border-slate-200" aria-label="Operations sections">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-slate-900 font-medium' : 'border-transparent text-slate-500 hover:text-slate-900'}`}
            onClick={() => setSearch({ tab: id })}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'overview' && <Overview />}
      {tab === 'jobs' && <Jobs />}
      {tab === 'audit' && <Audit />}
      {tab === 'emails' && <Emails />}
      {tab === 'ai' && <AiRuns />}
    </div>
  );
}
