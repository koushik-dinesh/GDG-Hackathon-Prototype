import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api/integrations.js';
import * as workRecords from '../../api/workRecords.js';
import { DevelopmentCard } from '../../components/DevelopmentCard.jsx';
import { IntegrationDetailPage } from './IntegrationDetail.jsx';
import { IntegrationsPage } from './Integrations.jsx';

vi.mock('../../api/integrations.js');
vi.mock('../../api/workRecords.js');
vi.mock('../../api/projects.js', () => ({ listProjects: vi.fn(async () => ({ projects: [{ id: 3, name: 'Payments' }] })) }));
vi.mock('../../api/users.js', () => ({
  listUsers: vi.fn(async () => ({ users: [{ id: 5, fullName: 'Ana Garcia', email: 'ana@example.test' }, { id: 6, fullName: 'Raj Patel', email: 'raj@example.test' }] })),
}));

const githubConnection = {
  id: 9,
  provider: 'github',
  externalAccountId: '7001',
  accountLogin: 'acme',
  accountType: 'Organization',
  displayName: 'GitHub · acme',
  status: 'active',
  isEnabled: true,
  health: 'healthy',
  consecutiveFailures: 0,
  lastErrorMessage: null,
  settings: {
    repositorySelection: 'selected',
    permissions: { metadata: 'read', issues: 'read', pull_requests: 'read', contents: 'read' },
    manageUrl: 'https://github.com/organizations/acme/settings/installations/7001',
  },
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderAt(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/admin/integrations" element={<IntegrationsPage />} />
        <Route path="/admin/integrations/:id" element={<IntegrationDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

describe('GitHub integration management', () => {
  it('shows the webhook URL to configure and maps GitHub people to users', async () => {
    api.listProviders.mockResolvedValue({
      providers: [{ id: 'github', displayName: 'GitHub', available: true, problem: null, webhookUrl: 'https://wa.example.com/api/v1/webhooks/github' }],
    });
    api.listConnections.mockResolvedValue({ connections: [githubConnection] });
    api.listIdentities.mockResolvedValue({
      identities: [
        { id: 1, provider: 'github', externalUserId: '11', login: 'ana-gh', isBot: false, userId: null, matchMethod: 'none' },
        { id: 2, provider: 'github', externalUserId: '99', login: 'dependabot[bot]', isBot: true, userId: null, matchMethod: 'none' },
      ],
    });
    api.matchIdentity.mockResolvedValue({ identity: { id: 1, provider: 'github', externalUserId: '11', login: 'ana-gh', userId: 5, matchMethod: 'manual' } });
    const user = renderAt('/admin/integrations');

    expect(await screen.findByText('https://wa.example.com/api/v1/webhooks/github')).toBeTruthy();
    const ana = await screen.findByRole('listitem', { name: 'ana-gh' });
    expect(within(screen.getByRole('listitem', { name: 'dependabot[bot]' })).getByText('bot')).toBeTruthy();
    await user.selectOptions(within(ana).getByLabelText('WorkAgent user for ana-gh'), '5');
    expect(api.matchIdentity).toHaveBeenCalledWith(1, 5);
    expect(await screen.findByText('ana-gh matched.')).toBeTruthy();
    expect(screen.queryByRole('listitem', { name: 'ana-gh' })).toBeNull();
  });

  it('shows the installation’s repository access and where to change it on GitHub', async () => {
    api.getConnection.mockResolvedValue({
      connection: githubConnection,
      resources: [{ id: 21, connectionId: 9, name: 'acme/payments', url: 'https://github.com/acme/payments', accessStatus: 'accessible', isEnabled: true, projectId: 3, metadata: { private: true }, lastSyncedAt: '2026-10-30T10:00:00Z', lastErrorMessage: 'The provider is temporarily unavailable' }],
      recentDeliveries: [],
      credentialKinds: [{ kind: 'installation_token', expiresAt: '2026-10-30T11:00:00Z' }],
    });
    renderAt('/admin/integrations/9');
    expect(await screen.findByText('GitHub App installation')).toBeTruthy();
    expect(screen.getByText(/selected repositories/)).toBeTruthy();
    expect(screen.getByText(/Pull requests \(read\)/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage repository access on GitHub' }).getAttribute('href')).toBe(githubConnection.settings.manageUrl);
    expect(screen.getByText('installation token')).toBeTruthy();
    expect(screen.getByText(/temporarily unavailable/)).toBeTruthy();
  });
});

describe('Project development card', () => {
  it('lists open issues and pull requests with links, and recent activity', async () => {
    workRecords.listExternalRecords.mockImplementation(async ({ recordType }) => ({
      records:
        recordType === 'pull_request'
          ? [
              { id: 1, recordType: 'pull_request', externalKey: 'acme/payments#3', title: 'Fix checkout', url: 'https://github.com/acme/payments/pull/3', statusCategory: 'in_progress', author: { login: 'raj' } },
              { id: 2, recordType: 'pull_request', externalKey: 'acme/payments#4', title: 'Merged thing', url: 'https://github.com/acme/payments/pull/4', statusCategory: 'done', author: null },
            ]
          : [{ id: 3, recordType: 'issue', externalKey: 'acme/payments#1', title: 'Refunds fail', url: 'https://github.com/acme/payments/issues/1', statusCategory: 'todo', author: { login: 'ana' } }],
    }));
    workRecords.listActivities.mockResolvedValue({
      activities: [{ id: 9, occurredAt: '2026-10-30T09:00:00Z', summary: 'ana reviewed acme/payments#3 (approved)', record: { url: 'https://github.com/acme/payments/pull/3' } }],
    });
    render(<DevelopmentCard projectId={3} />);
    const open = await screen.findByRole('region', { name: 'Open issues and pull requests' });
    expect(within(open).getByRole('link', { name: 'Fix checkout' }).getAttribute('href')).toBe('https://github.com/acme/payments/pull/3');
    expect(within(open).getByText('Refunds fail')).toBeTruthy();
    expect(within(open).queryByText('Merged thing')).toBeNull();
    expect(within(open).getByText('by raj')).toBeTruthy();
    const activity = screen.getByRole('region', { name: 'Recent development activity' });
    expect(within(activity).getByRole('link', { name: 'ana reviewed acme/payments#3 (approved)' }).getAttribute('rel')).toContain('noopener');
    expect(workRecords.listExternalRecords).toHaveBeenCalledWith({ projectId: 3, recordType: 'pull_request', limit: 20 });
  });

  it('renders nothing for projects without synced work, and reports errors', async () => {
    workRecords.listExternalRecords.mockResolvedValue({ records: [] });
    workRecords.listActivities.mockResolvedValue({ activities: [] });
    const { container } = render(<DevelopmentCard projectId={3} />);
    await vi.waitFor(() => expect(screen.queryByText(/Loading development activity/)).toBeNull());
    expect(container.textContent).toBe('');
    cleanup();
    workRecords.listExternalRecords.mockRejectedValue(new Error('Project not found'));
    render(<DevelopmentCard projectId={3} />);
    expect(await screen.findByText('Could not load development activity: Project not found')).toBeTruthy();
  });
});
