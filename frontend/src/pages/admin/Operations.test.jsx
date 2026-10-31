import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as emails from '../../api/emails.js';
import * as ops from '../../api/ops.js';
import { OperationsPage } from './Operations.jsx';

vi.mock('../../api/ops.js');
vi.mock('../../api/emails.js');

const summary = {
  generatedAt: '2026-10-31T10:00:00Z',
  jobs: { byStatus: { pending: 2, dead: 1 }, byType: { 'integration.sync': { dead: 1, pending: 2 } }, oldestDueSeconds: 12, failedLast7Days: 1, workers: [] },
  emails: { sent: 4, failed: 1 },
  ai: { last30Days: { succeeded: 3 }, tokens: { input: 12000, output: 3000 }, costUsd: null, priced: false },
  integrations: { connections: [{ provider: 'jira', status: 'error', health: 'failing', problem: 'Reconnect Jira' }], webhooksFailedLast7Days: 0, webhooksWaiting: 0 },
};
const renderAt = (path) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <OperationsPage />
    </MemoryRouter>,
  );
  return userEvent.setup();
};

beforeEach(() => {
  ops.getOpsSummary.mockResolvedValue(summary);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Operations (Phase 8)', () => {
  it('summarizes queue, integrations, e-mail and AI usage without inventing a cost', async () => {
    renderAt('/admin/operations');
    expect(await screen.findByText('Reconnect Jira', { exact: false })).toBeTruthy();
    expect(screen.getByText(/Cost not shown/)).toBeTruthy();
    expect(screen.getByText(/sent: 4 · failed: 1/)).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Jobs by type' })).getByText('integration.sync')).toBeTruthy();
  });

  it('retries a dead job and shows what to do for other types', async () => {
    ops.listJobs.mockResolvedValue({
      jobs: [
        { id: 7, type: 'integration.sync', status: 'dead', payload: { resourceId: 3 }, attempts: 3, maxAttempts: 3, lastError: 'Provider error', createdAt: '2026-10-30T10:00:00Z', updatedAt: '2026-10-30T10:05:00Z', actions: { retry: true, cancel: false, instead: null } },
        { id: 8, type: 'email.send', status: 'dead', payload: { messageId: 1 }, attempts: 5, maxAttempts: 5, lastError: 'SMTP 550', createdAt: '2026-10-30T10:00:00Z', updatedAt: '2026-10-30T10:05:00Z', actions: { retry: false, cancel: false, instead: 'Retry the e-mail from the E-mail tab (it also resets the message status).' } },
      ],
      next: null,
    });
    ops.retryJob.mockResolvedValue({ job: { id: 7, status: 'pending' } });
    const user = renderAt('/admin/operations?tab=jobs&status=dead');
    await screen.findByText('Provider error');
    expect(ops.listJobs).toHaveBeenCalledWith(expect.objectContaining({ status: 'dead' }));
    expect(screen.getByText(/Retry the e-mail from the E-mail tab/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(ops.retryJob).toHaveBeenCalledWith(7);
    expect(await screen.findByText('Job 7 queued again.')).toBeTruthy();
  });

  it('shows the audit trail with details on demand', async () => {
    ops.listAuditActions.mockResolvedValue({ actions: [{ action: 'job.retried', count: 1 }] });
    ops.listAudit.mockResolvedValue({ entries: [{ id: 1, action: 'job.retried', entityType: 'job', entityId: 7, actor: { id: 1, name: 'Ada Admin' }, before: { status: 'dead' }, after: { status: 'pending' }, ip: '127.0.0.1', createdAt: '2026-10-31T10:00:00Z' }], next: null });
    const user = renderAt('/admin/operations?tab=audit');
    const row = await screen.findByRole('button', { name: /job\.retried/ });
    await user.click(row);
    expect(screen.getByText(/"status": "dead"/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Action'), 'job.');
    await waitFor(() => expect(ops.listAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'job.' })));
  });

  it('retries a failed e-mail through its own endpoint', async () => {
    ops.listOpsEmails.mockResolvedValue({ emails: [{ id: 3, meeting: { id: 9, title: 'Weekly' }, to: 'mia@acme.test', subject: 'Your action items', status: 'failed', attempts: 5, lastError: 'SMTP 550', createdAt: '2026-10-30T10:00:00Z' }], next: null });
    emails.retryEmail.mockResolvedValue({});
    const user = renderAt('/admin/operations?tab=emails');
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(emails.retryEmail).toHaveBeenCalledWith(3);
  });
});
