import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import {
  disconnect,
  getConnection,
  refreshResources,
  replayDelivery,
  syncNow,
  updateConnection,
  updateResource,
} from '../../api/integrations.js';
import { listProjects } from '../../api/projects.js';
import { ProjectSelect } from '../../components/ProjectSelect.jsx';
import { Button, Card, ErrorAlert, Loading, SuccessAlert } from '../../components/ui.jsx';
import { formatDateTime } from '../../utils/format.js';
import { CONNECTION_STATUS, DELIVERY_STATUS, HEALTH } from './integrationLabels.js';

export function IntegrationDetailPage() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState(null); // { connection, resources, recentDeliveries, credentialKinds }
  const [projects, setProjects] = useState(null);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(location.state?.connected ? 'Connected. Choose what to sync below.' : '');
  const [busy, setBusy] = useState(null);

  const load = useCallback(
    () =>
      getConnection(id)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch(setError),
    [id],
  );
  useEffect(() => {
    load();
    listProjects()
      .then((d) => setProjects(d.projects))
      .catch(() => setProjects([]));
  }, [load]);

  // Runs one change at a time; shows the server's result rather than guessing.
  async function run(key, fn, message) {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      const result = await fn();
      await load();
      setNotice(typeof message === 'function' ? message(result) : message);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  }

  if (error) return <ErrorAlert error={error.status === 404 ? 'Integration not found.' : error} />;
  if (!data) return <Loading />;
  const { connection: c, resources, recentDeliveries, credentialKinds } = data;
  const status = CONNECTION_STATUS[c.status];
  const disconnected = c.status === 'disconnected';
  const canSync = c.status === 'active' && c.isEnabled;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin/integrations" className="text-sm text-slate-500 hover:underline">
          ← Integrations
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{c.displayName}</h1>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${status?.cls}`}>{status?.label}</span>
          {!c.isEnabled && !disconnected && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">Paused</span>}
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {c.provider} · {c.accountType ? `${c.accountType} ` : ''}
          {c.accountLogin ?? c.externalAccountId}
        </p>
      </div>

      <SuccessAlert>{notice}</SuccessAlert>
      {location.state?.resourceError && <ErrorAlert error={`Connected, but listing resources failed: ${location.state.resourceError}`} />}
      <ErrorAlert error={actionError} />

      <Card
        title="Status"
        actions={
          !disconnected && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" disabled={!canSync || Boolean(busy)} onClick={() => run('sync', () => syncNow(c.id), (r) => (r.queued ? `Sync queued for ${r.queued} resource(s).` : 'Nothing to sync: enable a resource first, or a sync is already queued.'))}>
                {busy === 'sync' ? 'Queuing…' : 'Sync now'}
              </Button>
              <Button variant="secondary" disabled={Boolean(busy)} onClick={() => run('pause', () => updateConnection(c.id, { isEnabled: !c.isEnabled }), c.isEnabled ? 'Paused: nothing syncs until you resume.' : 'Resumed.')}>
                {c.isEnabled ? 'Pause' : 'Resume'}
              </Button>
            </div>
          )
        }
      >
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <Detail label="Health">
            <span className={HEALTH[c.health]?.cls}>{HEALTH[c.health]?.label}</span>
            {c.consecutiveFailures > 0 && <span className="block text-xs text-slate-500">{c.consecutiveFailures} failure(s) in a row</span>}
          </Detail>
          <Detail label="Last successful sync">{formatDateTime(c.lastSyncSucceededAt)}</Detail>
          <Detail label="Last webhook">{formatDateTime(c.lastWebhookAt)}</Detail>
          <Detail label="Connected">{formatDateTime(c.connectedAt)}</Detail>
          <Detail label="Rate limit">
            {c.pausedUntil && new Date(c.pausedUntil) > new Date() ? `Paused until ${formatDateTime(c.pausedUntil)}` : c.rateLimitRemaining ?? '—'}
          </Detail>
          <Detail label="Stored credentials">{credentialKinds.length ? credentialKinds.map((k) => k.kind.replaceAll('_', ' ')).join(', ') : 'None'}</Detail>
        </dl>
        {c.lastErrorMessage && (
          <p role="alert" className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            Last error: {c.lastErrorMessage}
          </p>
        )}
      </Card>

      <Card
        title="Resources"
        actions={
          !disconnected && (
            <Button variant="secondary" disabled={Boolean(busy)} onClick={() => run('refresh', () => refreshResources(c.id), 'Resource list refreshed.')}>
              {busy === 'refresh' ? 'Refreshing…' : 'Refresh list'}
            </Button>
          )
        }
      >
        <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Everyone who can see a project can see the titles and activity of the resources mapped to it, including private repositories
          they have no access to in {c.provider}. Map private resources only to projects whose members should see them.
        </p>
        {resources.length === 0 ? (
          <p className="text-sm text-slate-500">No resources yet. Use “Refresh list” after granting access at the provider.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {resources.map((r) => (
              <ResourceRow key={r.id} resource={r} projects={projects} disabled={disconnected || Boolean(busy)} onChange={(body, message) => run(`res-${r.id}`, () => updateResource(c.id, r.id, body), message)} />
            ))}
          </ul>
        )}
      </Card>

      <Card title="Recent webhook deliveries">
        {recentDeliveries.length === 0 ? (
          <p className="text-sm text-slate-500">No webhooks received yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-1 font-medium">Received</th>
                <th className="py-1 font-medium">Event</th>
                <th className="py-1 font-medium">Status</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recentDeliveries.map((d) => (
                <tr key={d.id}>
                  <td className="py-2 text-slate-600">{formatDateTime(d.receivedAt)}</td>
                  <td className="py-2">
                    {d.eventType}
                    {d.action && <span className="text-slate-500"> · {d.action}</span>}
                  </td>
                  <td className="py-2">
                    <span className={d.status === 'failed' ? 'text-red-700' : 'text-slate-700'}>{DELIVERY_STATUS[d.status] ?? d.status}</span>
                    {d.lastErrorMessage && <span className="block text-xs text-slate-500">{d.lastErrorMessage}</span>}
                  </td>
                  <td className="py-2 text-right">
                    {d.hasPayload && ['processed', 'ignored', 'failed'].includes(d.status) && (
                      <Button variant="link" disabled={Boolean(busy)} onClick={() => run(`replay-${d.id}`, () => replayDelivery(d.id), 'Delivery queued again.')}>
                        Replay
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      {!disconnected && (
        <Card title="Disconnect">
          <p className="text-sm text-slate-600">
            Deletes the stored credentials and stops syncing. Data already synced stays in WorkAgent. You can reconnect the same account later.
          </p>
          <Button
            variant="danger"
            className="mt-3"
            disabled={Boolean(busy)}
            onClick={() => {
              if (!window.confirm(`Disconnect ${c.displayName}? Syncing stops and the stored credentials are deleted.`)) return;
              // Drop the "Connected" banner carried over from the setup redirect.
              navigate(location.pathname, { replace: true, state: null });
              run('disconnect', () => disconnect(c.id), 'Disconnected. Synced data was kept.');
            }}
          >
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </Button>
        </Card>
      )}
    </div>
  );
}

function Detail({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  );
}

function ResourceRow({ resource: r, projects, disabled, onChange }) {
  const removed = r.accessStatus === 'removed';
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3" aria-label={r.name}>
      <div className="min-w-0">
        <p className="font-medium text-slate-900">
          {r.url ? (
            <a href={r.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
              {r.name}
            </a>
          ) : (
            r.name
          )}
          {r.metadata?.private && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">private</span>}
          {removed && <span className="ml-2 rounded bg-red-50 px-1.5 py-0.5 text-xs text-red-700">access removed</span>}
        </p>
        <p className="text-xs text-slate-500">
          {r.isEnabled ? `Synced ${formatDateTime(r.lastSyncedAt)}` : 'Not synced'}
          {r.lastErrorMessage && <span className="text-red-700"> · {r.lastErrorMessage}</span>}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-48">
          <ProjectSelect
            aria-label={`Project for ${r.name}`}
            value={r.projectId}
            projects={projects}
            disabled={disabled}
            onChange={(projectId) => onChange({ projectId }, projectId ? `${r.name} mapped to a project.` : `${r.name} no longer mapped to a project.`)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={r.isEnabled}
            disabled={disabled || (removed && !r.isEnabled)}
            onChange={(e) => onChange({ isEnabled: e.target.checked }, e.target.checked ? `${r.name} will be synced.` : `${r.name} will no longer be synced.`)}
          />
          Sync
        </label>
      </div>
    </li>
  );
}
