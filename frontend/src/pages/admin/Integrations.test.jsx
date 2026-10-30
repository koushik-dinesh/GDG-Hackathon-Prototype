import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import * as api from '../../api/integrations.js';
import { IntegrationSetupPage } from '../IntegrationSetup.jsx';
import { IntegrationDetailPage } from './IntegrationDetail.jsx';
import { IntegrationsPage, redirectTo } from './Integrations.jsx';

vi.mock('../../api/integrations.js');
vi.mock('../../api/projects.js', () => ({
  listProjects: vi.fn(async () => ({ projects: [{ id: 3, name: 'Payments' }, { id: 4, name: 'Mobile' }] })),
}));

const connection = (o = {}) => ({
  id: 7,
  provider: 'fake',
  externalAccountId: 'fake-org',
  accountLogin: 'fake-org',
  accountType: 'Organization',
  displayName: 'Fake Org',
  status: 'active',
  isEnabled: true,
  health: 'healthy',
  consecutiveFailures: 0,
  lastErrorMessage: null,
  rateLimitRemaining: 4800,
  pausedUntil: null,
  lastSyncSucceededAt: '2026-10-30T10:00:00Z',
  lastWebhookAt: null,
  connectedAt: '2026-10-29T10:00:00Z',
  ...o,
});
const resource = (o = {}) => ({
  id: 11,
  connectionId: 7,
  resourceType: 'repository',
  externalId: '101',
  name: 'fake-org/api',
  url: 'https://fake.test/fake-org/api',
  accessStatus: 'accessible',
  isEnabled: false,
  projectId: null,
  metadata: { private: true },
  lastSyncedAt: null,
  lastErrorMessage: null,
  ...o,
});
const detail = (o = {}) => ({
  connection: connection(o.connection),
  resources: o.resources ?? [resource(), resource({ id: 12, externalId: '102', name: 'fake-org/web', metadata: { private: false } })],
  recentDeliveries: o.recentDeliveries ?? [],
  credentialKinds: [{ kind: 'api_token', expiresAt: null }],
});

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}</p>;
}

function renderAt(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/integrations" element={<IntegrationsPage />} />
        <Route path="/admin/integrations/:id" element={<><IntegrationDetailPage /><Where /></>} />
        <Route path="/integrations/:provider/setup" element={<IntegrationSetupPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Integrations list', () => {
  it('lists providers and connections, and starts a connection by redirecting to the provider', async () => {
    api.listProviders.mockResolvedValue({
      providers: [
        { id: 'fake', displayName: 'Fake provider', available: true, problem: null },
        { id: 'github', displayName: 'GitHub', available: false, problem: 'GITHUB_APP_ID is not set' },
      ],
    });
    api.listConnections.mockResolvedValue({ connections: [connection(), connection({ id: 8, displayName: 'Old org', status: 'disconnected', isEnabled: false, health: 'unknown' })] });
    api.startConnect.mockResolvedValue({ redirectUrl: 'https://provider.test/authorize?state=abc' });
    const go = vi.spyOn(redirectTo, 'go').mockImplementation(() => {});
    const user = renderAt('/admin/integrations');

    expect(await screen.findByText('Not configured on the server: GITHUB_APP_ID is not set')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect GitHub' }).disabled).toBe(true);
    const active = screen.getByRole('listitem', { name: 'Fake Org' });
    expect(within(active).getByText('Connected')).toBeTruthy();
    expect(within(active).getByText('Healthy')).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: 'Old org' })).getByText('Disconnected')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Connect Fake provider' }));
    expect(api.startConnect).toHaveBeenCalledWith('fake');
    expect(go).toHaveBeenCalledWith('https://provider.test/authorize?state=abc');
  });

  it('shows why connecting failed', async () => {
    api.listProviders.mockResolvedValue({ providers: [{ id: 'fake', displayName: 'Fake provider', available: true, problem: null }] });
    api.listConnections.mockResolvedValue({ connections: [] });
    api.startConnect.mockRejectedValue(new ApiError(503, 'PROVIDER_UNAVAILABLE', 'This integration is not configured on the server'));
    const user = renderAt('/admin/integrations');
    expect(await screen.findByText('No connections yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Connect Fake provider' }));
    expect(await screen.findByText('This integration is not configured on the server')).toBeTruthy();
  });
});

describe('Setup callback', () => {
  it('sends the state and the provider’s parameters once, then opens the connection', async () => {
    api.completeConnect.mockResolvedValue({ connection: connection(), resources: [], resourceError: null });
    api.getConnection.mockResolvedValue(detail());
    renderAt('/integrations/fake/setup?account_id=fake-org&setup_action=install&state=s-123456789012345678901');
    expect(await screen.findByText('Connected. Choose what to sync below.')).toBeTruthy();
    expect(api.completeConnect).toHaveBeenCalledTimes(1);
    expect(api.completeConnect).toHaveBeenCalledWith('fake', 's-123456789012345678901', { accountId: 'fake-org', setupAction: 'install' });
    expect(screen.getByTestId('where').textContent).toBe('/admin/integrations/7');
  });

  it('explains invalid or missing states', async () => {
    api.completeConnect.mockRejectedValue(new ApiError(400, 'INVALID_STATE', 'This connection link is invalid or has expired.'));
    renderAt('/integrations/fake/setup?state=s-123456789012345678901');
    expect(await screen.findByText('This connection link is invalid or has expired.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Integrations' })).toBeTruthy();
    cleanup();
    renderAt('/integrations/fake/setup?account_id=x');
    expect(await screen.findByText(/opened without a connection request/)).toBeTruthy();
  });
});

describe('Integration detail', () => {
  it('shows status, health, errors and the private-data warning', async () => {
    api.getConnection.mockResolvedValue(detail({ connection: { health: 'degraded', consecutiveFailures: 2, lastErrorMessage: 'The provider is temporarily unavailable' } }));
    renderAt('/admin/integrations/7');
    expect(await screen.findByRole('heading', { name: 'Fake Org' })).toBeTruthy();
    expect(screen.getByText('Degraded')).toBeTruthy();
    expect(screen.getByText('2 failure(s) in a row')).toBeTruthy();
    expect(screen.getByText('Last error: The provider is temporarily unavailable')).toBeTruthy();
    expect(screen.getByText(/including private repositories/)).toBeTruthy();
    expect(screen.getByText('api token')).toBeTruthy();
    expect(within(screen.getByRole('listitem', { name: 'fake-org/api' })).getByText('private')).toBeTruthy();
  });

  it('enables a resource and maps it to a project through the API, then reloads', async () => {
    api.getConnection.mockResolvedValueOnce(detail()).mockResolvedValue(detail({ resources: [resource({ isEnabled: true, projectId: 3 })] }));
    api.updateResource.mockResolvedValue({ resource: resource({ isEnabled: true }) });
    const user = renderAt('/admin/integrations/7');
    const row = await screen.findByRole('listitem', { name: 'fake-org/api' });
    await user.click(within(row).getByRole('checkbox', { name: 'Sync' }));
    expect(api.updateResource).toHaveBeenCalledWith(7, 11, { isEnabled: true });
    expect(await screen.findByText('fake-org/api will be synced.')).toBeTruthy();

    const select = within(screen.getByRole('listitem', { name: 'fake-org/api' })).getByLabelText('Project for fake-org/api');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Mobile' })).toBeTruthy());
    await user.selectOptions(select, '4');
    expect(api.updateResource).toHaveBeenLastCalledWith(7, 11, { projectId: 4 });
  });

  it('syncs now, pauses, replays a delivery and disconnects', async () => {
    const deliveries = [
      { id: 90, eventType: 'item', action: 'updated', status: 'failed', lastErrorMessage: 'The provider returned an unexpected response', hasPayload: true, receivedAt: '2026-10-30T09:00:00Z' },
      { id: 91, eventType: 'item', action: 'opened', status: 'processed', lastErrorMessage: null, hasPayload: false, receivedAt: '2026-10-29T09:00:00Z' },
    ];
    api.getConnection.mockResolvedValue(detail({ recentDeliveries: deliveries }));
    api.syncNow.mockResolvedValue({ queued: 1 });
    api.updateConnection.mockResolvedValue({ connection: connection({ isEnabled: false }) });
    api.replayDelivery.mockResolvedValue({ delivery: { ...deliveries[0], status: 'received' } });
    api.disconnect.mockResolvedValue({ connection: connection({ status: 'disconnected' }) });
    const user = renderAt('/admin/integrations/7');

    await user.click(await screen.findByRole('button', { name: 'Sync now' }));
    expect(await screen.findByText('Sync queued for 1 resource(s).')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(api.updateConnection).toHaveBeenCalledWith(7, { isEnabled: false });

    expect(screen.getAllByRole('button', { name: 'Replay' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Replay' }));
    expect(api.replayDelivery).toHaveBeenCalledWith(90);
    expect(await screen.findByText('Delivery queued again.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(window.confirm).toHaveBeenCalled();
    expect(api.disconnect).toHaveBeenCalledWith(7);
    expect(await screen.findByText('Disconnected. Synced data was kept.')).toBeTruthy();
  });

  it('offers no actions once disconnected, and shows server errors', async () => {
    api.getConnection.mockResolvedValue(detail({ connection: { status: 'disconnected', isEnabled: false } }));
    renderAt('/admin/integrations/7');
    expect(await screen.findByText('Disconnected')).toBeTruthy();
    for (const name of ['Sync now', 'Pause', 'Refresh list', 'Disconnect']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(within(screen.getByRole('listitem', { name: 'fake-org/api' })).getByRole('checkbox').disabled).toBe(true);

    cleanup();
    api.getConnection.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Integration not found'));
    renderAt('/admin/integrations/99');
    expect(await screen.findByText('Integration not found.')).toBeTruthy();
  });

  it('shows a refused change without changing the page', async () => {
    api.getConnection.mockResolvedValue(detail());
    api.updateResource.mockRejectedValue(new ApiError(409, 'CONFLICT', 'The provider no longer gives access to this resource'));
    const user = renderAt('/admin/integrations/7');
    const row = await screen.findByRole('listitem', { name: 'fake-org/api' });
    await user.click(within(row).getByRole('checkbox', { name: 'Sync' }));
    expect(await screen.findByText('The provider no longer gives access to this resource')).toBeTruthy();
  });
});
