import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { completeConnect } from '../api/integrations.js';
import { ErrorAlert, Loading } from '../components/ui.jsx';

// The provider sends the admin back here (e.g. GitHub's Setup URL) with `state` and its own
// parameters. The server checks the state (single use, same admin) and verifies the account.
// Provider parameter names are converted to camelCase (installation_id -> installationId).
const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

export function IntegrationSetupPage() {
  const { provider } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState(null);
  const started = useRef(false);

  useEffect(() => {
    // Runs once even under React's double-invoked effects: the state can only be used once.
    if (started.current) return;
    started.current = true;
    const state = search.get('state');
    const params = {};
    for (const [key, value] of search.entries()) if (key !== 'state') params[camel(key)] = value;
    // Keep the state out of the address bar and browser history.
    window.history.replaceState(null, '', window.location.pathname);
    if (!state) {
      setError('This page was opened without a connection request. Start again from Integrations.');
      return;
    }
    completeConnect(provider, state, params)
      .then(({ connection, resourceError }) =>
        navigate(`/admin/integrations/${connection.id}`, { replace: true, state: { connected: true, resourceError } }),
      )
      .catch(setError);
  }, [provider, search, navigate]);

  return (
    <div className="mx-auto max-w-lg space-y-4 py-10">
      <h1 className="text-xl font-semibold">Connecting…</h1>
      {!error && <Loading label="Finishing the connection with the provider…" />}
      <ErrorAlert error={error} />
      {error && (
        <Link to="/admin/integrations" className="text-sm font-medium text-slate-700 underline">
          Back to Integrations
        </Link>
      )}
    </div>
  );
}
