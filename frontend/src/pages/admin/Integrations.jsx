import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listConnections, listIdentities, listProviders, matchIdentity, startConnect } from '../../api/integrations.js';
import { listUsers } from '../../api/users.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Loading, inputClass } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';
import { CONNECTION_STATUS, HEALTH } from './integrationLabels.js';

/** Where "Connect" sends the browser. Overridable in tests (jsdom can't navigate). */
export const redirectTo = { go: (url) => window.location.assign(url) };

export function IntegrationsPage() {
  const [providers, setProviders] = useState(null);
  const [connections, setConnections] = useState(null);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(null);

  useEffect(() => {
    Promise.all([listProviders(), listConnections()])
      .then(([p, c]) => {
        setProviders(p.providers);
        setConnections(c.connections);
      })
      .catch(setError);
  }, []);

  async function connect(providerId) {
    if (connecting) return;
    setConnecting(providerId);
    setError(null);
    try {
      const { redirectUrl } = await startConnect(providerId);
      redirectTo.go(redirectUrl);
    } catch (err) {
      setError(err);
      setConnecting(null);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="mt-1 text-sm text-slate-500">
          Connect the applications your teams work in. Nothing is synced until you choose which repositories or projects to include.
        </p>
      </div>
      <ErrorAlert error={error} />

      <Card title="Available applications">
        {!providers && !error && <Loading />}
        {providers?.length === 0 && <p className="text-sm text-slate-500">No integrations are installed on this server yet.</p>}
        <ul className="divide-y divide-slate-100">
          {providers?.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">{p.displayName}</p>
                {!p.available && <p className="text-xs text-amber-700">Not configured on the server: {p.problem}</p>}
                {p.webhookUrl && (
                  <p className="break-all text-xs text-slate-500">
                    Webhook URL: <code className="rounded bg-slate-100 px-1">{p.webhookUrl}</code>
                  </p>
                )}
              </div>
              <Button onClick={() => connect(p.id)} disabled={!p.available || Boolean(connecting)}>
                {connecting === p.id ? 'Opening…' : `Connect ${p.displayName}`}
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      {connections?.length === 0 && <EmptyState title="No connections yet">Connect an application above to start.</EmptyState>}
      {connections?.length > 0 && (
        <Card title="Connections">
          <ul className="divide-y divide-slate-100">
            {connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3" aria-label={c.displayName}>
                <div className="min-w-0">
                  <Link to={`/admin/integrations/${c.id}`} className="font-medium text-slate-900 hover:underline">
                    {c.displayName}
                  </Link>
                  <p className="text-xs text-slate-500">
                    {c.provider} · {c.accountLogin ?? c.externalAccountId} · last synced {formatDateTime(c.lastSyncSucceededAt)}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  {!c.isEnabled && c.status !== 'disconnected' && <span className="text-slate-500">Paused</span>}
                  <span className={HEALTH[c.health]?.cls}>{HEALTH[c.health]?.label}</span>
                  <span className={`rounded-full px-2 py-0.5 font-medium ${CONNECTION_STATUS[c.status]?.cls}`}>{CONNECTION_STATUS[c.status]?.label}</span>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {connections?.length > 0 && <PeopleCard />}
    </div>
  );
}

/**
 * People from connected applications (e.g. GitHub accounts) and the WorkAgent user each one is.
 * Matching is manual: logins and names are never matched automatically (only a verified email
 * from the provider is), and a manual choice is never overwritten by a sync.
 */
function PeopleCard() {
  const [identities, setIdentities] = useState(null);
  const [users, setUsers] = useState([]);
  const [onlyUnmatched, setOnlyUnmatched] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    listIdentities({ unmatched: onlyUnmatched })
      .then((d) => setIdentities(d.identities))
      .catch(setError);
  }, [onlyUnmatched]);
  useEffect(() => {
    listUsers({ includeInactive: false })
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, []);

  async function match(identity, userId) {
    setError(null);
    try {
      const { identity: updated } = await matchIdentity(identity.id, userId);
      setIdentities((list) => (onlyUnmatched && updated.userId ? list.filter((i) => i.id !== updated.id) : list.map((i) => (i.id === updated.id ? updated : i))));
      setNotice(updated.userId ? `${identity.login ?? identity.externalUserId} matched.` : `${identity.login ?? identity.externalUserId} unmatched.`);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <Card
      title="People in connected applications"
      actions={
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={onlyUnmatched} onChange={(e) => setOnlyUnmatched(e.target.checked)} />
          Only unmatched
        </label>
      }
    >
      <p className="mb-3 text-xs text-slate-500">Match accounts to WorkAgent users so their activity is attributed to them. Bots are listed but need no match.</p>
      <ErrorAlert error={error} />
      {notice && <p role="status" className="mb-2 text-sm text-emerald-700">{notice}</p>}
      {!identities && !error && <Loading />}
      {identities?.length === 0 && <p className="text-sm text-slate-500">{onlyUnmatched ? 'Everyone is matched.' : 'No people synced yet.'}</p>}
      {identities?.length > 0 && (
        <ul className="divide-y divide-slate-100">
          {identities.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-2" aria-label={i.login ?? i.externalUserId}>
              <div className="text-sm">
                <span className="font-medium text-slate-900">{i.login ?? i.externalUserId}</span>
                <span className="text-slate-500"> · {i.provider}</span>
                {i.isBot && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">bot</span>}
                {i.matchMethod !== 'none' && <span className="ml-2 text-xs text-slate-500">matched ({i.matchMethod})</span>}
              </div>
              <select
                aria-label={`WorkAgent user for ${i.login ?? i.externalUserId}`}
                className={`${inputClass} w-56`}
                value={i.userId ?? ''}
                onChange={(e) => match(i, e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Not matched</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.fullName} ({u.email})
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
