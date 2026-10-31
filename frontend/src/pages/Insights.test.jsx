import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../api/insights.js';
import { InsightsPage, insightHref } from './Insights.jsx';

vi.mock('../api/insights.js');
vi.mock('../api/projects.js', () => ({ listProjects: vi.fn(async () => ({ projects: [{ id: 3, name: 'Payments' }] })) }));
vi.mock('../api/teams.js', () => ({ listTeams: vi.fn(async () => ({ teams: [{ id: 5, name: 'Core' }] })) }));
const auth = vi.hoisted(() => ({ user: { id: 9, role: 'manager', fullName: 'Mia Manager' } }));
vi.mock('../auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

const task = { type: 'action_item', id: 7, title: 'Ship refund retries', projectId: 3, meetingId: 4, assigneeUserId: 12 };
const pr = { type: 'external_record', id: 50, title: 'Retry refunds', key: 'acme/payments#3', provider: 'github', recordType: 'pull_request', projectId: 3 };
const insights = {
  generatedAt: '2026-10-31T10:00:00Z',
  window: { from: '2026-10-01T00:00:00Z', to: '2026-10-31T10:00:00Z' },
  rules: { staleDays: 14, reviewWaitDays: 2 },
  totals: { openTasks: 3, overdueTasks: 1, blockedTasks: 1, completedTasks: 2, openPullRequests: 1, medianHoursToMerge: 5.5, reviewsWaiting: 1 },
  highlights: [
    { kind: 'inference', text: '1 project at risk: Payments', rule: 'Project health rules', evidence: [] },
    { kind: 'fact', text: '1 task overdue; the oldest by 4 days (“Ship refund retries”)', evidence: [] },
  ],
  projects: [
    {
      project: { id: 3, name: 'Payments', status: 'active' },
      facts: { openTasks: 3, overdueTasks: 1, blockedTasks: 1, openIssues: 2, openPullRequests: 1 },
      health: { level: 'at_risk', assessment: { kind: 'inference', rule: 'Overdue work' }, reasons: [{ kind: 'fact', text: '1 task past due' }], targetDate: '2026-12-01' },
    },
  ],
  overdue: [{ task, dueDate: '2026-10-27', daysOverdue: 4, assignee: { id: 12, name: 'Em Ployee' } }],
  blockers: [{ kind: 'task_blocked', item: { ...task, id: 8, title: 'Wire settlement' }, evidence: { kind: 'fact', text: 'Task status is blocked' } }],
  dependencies: [],
  reviews: { queue: [{ pullRequest: pr, stage: 'awaiting_review', waitingDays: 5, reviewCount: 0, requestedReviewers: ['octo'] }] },
  followThrough: [{ meeting: { type: 'meeting', id: 4, title: 'Payments weekly', projectId: 3, at: '2026-10-24T10:00:00Z' }, tasks: 4, done: 1, open: 3, overdue: 1 }],
  workload: [{ user: { id: 12, name: 'Em Ployee' }, open: 3, inProgress: 1, blocked: 1, overdue: 1, highPriority: 1, completedInWindow: 2 }],
  stalled: [],
  trend: [{ weekStart: '2026-10-26', tasksCreated: 2, tasksCompleted: 1, recordsOpened: 1, recordsClosed: 0, pullRequestsMerged: 1 }],
};

beforeEach(() => {
  auth.user = { id: 9, role: 'manager', fullName: 'Mia Manager' };
  api.getInsights.mockResolvedValue(insights);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Insights (Phase 7)', () => {
  it('shows facts and labelled inferences with drill-down links', async () => {
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    );
    const highlights = await screen.findByRole('list', { name: 'Highlights' });
    expect(within(highlights).getByText('Inference').getAttribute('title')).toBe('Rule: Project health rules');
    expect(within(highlights).getByText('Fact')).toBeTruthy();
    expect(screen.getByText('At risk').getAttribute('title')).toMatch(/^Inference/);
    expect(screen.getByRole('link', { name: 'Payments' }).getAttribute('href')).toBe('/projects/3');
    // A manager opens another person's task through its project; a PR opens its record page.
    expect(screen.getByRole('link', { name: 'Ship refund retries' }).getAttribute('href')).toBe('/projects/3');
    expect(screen.getByRole('link', { name: 'acme/payments#3 Retry refunds' }).getAttribute('href')).toBe('/records/50');
    expect(screen.getByText(/Awaiting first review · 5 d · requested: octo/)).toBeTruthy();
    expect(screen.getByText(/1\/4 done/)).toBeTruthy();
    expect(screen.getByText('Nothing stalled.')).toBeTruthy();
  });

  it('re-queries with the chosen project, team and period', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    );
    await screen.findByRole('list', { name: 'Highlights' });
    await screen.findByRole('option', { name: 'Payments' });
    await user.selectOptions(screen.getByLabelText('Project'), '3');
    await waitFor(() => expect(api.getInsights).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: '3' })));
    await user.selectOptions(await screen.findByLabelText('Team'), '5');
    await waitFor(() => expect(api.getInsights).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: '3', teamId: '5' })));
    await user.selectOptions(screen.getByLabelText('Period'), '7');
    await waitFor(() => {
      const { from, to } = api.getInsights.mock.lastCall[0];
      expect(Math.round((new Date(to) - new Date(from)) / 86_400_000)).toBe(7);
    });
  });

  it('shows API errors', async () => {
    api.getInsights.mockRejectedValue(new Error('Project not found'));
    render(
      <MemoryRouter>
        <InsightsPage />
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Project not found/)).toBeTruthy();
  });

  it('routes items by role', () => {
    expect(insightHref(task, { id: 12, role: 'employee' })).toBe('/my/tasks/7');
    expect(insightHref(task, { id: 1, role: 'admin' })).toBe('/admin/meetings/4');
    expect(insightHref({ type: 'meeting', id: 4, projectId: 3 }, { id: 2, role: 'manager' })).toBe('/projects/3');
    expect(insightHref({ type: 'meeting', id: 4, projectId: null }, { id: 2, role: 'employee' })).toBe(null);
  });
});
