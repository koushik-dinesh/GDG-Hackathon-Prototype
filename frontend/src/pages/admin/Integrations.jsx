import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { listConnections, listProviders, startConnect } from '../../api/integrations.js';
import { EmptyState } from '../../components/EmptyState.jsx';
import { Button, Card, ErrorAlert, Loading } from '../../components/ui.jsx';
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
              <div>
                <p className="font-medium text-slate-900">{p.displayName}</p>
                {!p.available && <p className="text-xs text-amber-700">Not configured on the server: {p.problem}</p>}
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
    </div>
  );
}
