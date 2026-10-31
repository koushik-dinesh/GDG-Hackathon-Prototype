import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import * as api from '../api/workRecords.js';
import { RelatedRecords } from '../components/RelatedRecords.jsx';
import { ActivityFeedPage } from './ActivityFeed.jsx';
import { RecordDetailPage } from './RecordDetail.jsx';
import { SearchPage } from './SearchPage.jsx';
import { SuggestionsPage } from './Suggestions.jsx';

vi.mock('../api/workRecords.js');
vi.mock('../api/projects.js', () => ({ listProjects: vi.fn(async () => ({ projects: [{ id: 3, name: 'Payments' }] })) }));
const auth = vi.hoisted(() => ({ user: { id: 9, role: 'admin', fullName: 'Ada Admin' } }));
vi.mock('../auth/AuthContext.jsx', () => ({ useAuth: () => auth }));

const activity = (id, o = {}) => ({
  id,
  activityType: 'merged',
  provider: 'github',
  origin: 'webhook',
  occurredAt: '2026-10-30T10:00:00Z',
  summary: `Event ${id}`,
  project: { id: 3, name: 'Payments' },
  actor: { userId: null, name: null, login: 'raj' },
  subject: { type: 'external_record', id: 50, provider: 'github', recordType: 'pull_request', title: 'Fix checkout', key: 'acme/payments#3', url: 'https://github.com/acme/payments/pull/3', href: '/records/50' },
  ...o,
});

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}
function renderAt(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/activity" element={<><ActivityFeedPage /><Where /></>} />
        <Route path="/records/:id" element={<RecordDetailPage />} />
        <Route path="/search" element={<><SearchPage /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  auth.user = { id: 9, role: 'admin', fullName: 'Ada Admin' };
  api.listActivityTypes.mockResolvedValue({ activityTypes: [{ id: 'merged', label: 'Merged' }, { id: 'completed', label: 'Completed' }] });
  api.listRecordLinks.mockResolvedValue({ links: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Activity feed', () => {
  it('shows the timeline with providers, subjects, source links and pages with “Load more”', async () => {
    api.listActivities.mockResolvedValueOnce({ activities: [activity(1), activity(2, { provider: 'workagent', summary: 'Ada completed “Refund export”', subject: { type: 'action_item', id: 7, recordType: 'task', title: 'Refund export', href: '/my/tasks/7' } })], next: 'cursor-1' });
    api.listActivities.mockResolvedValueOnce({ activities: [activity(3)], next: null });
    const user = renderAt('/activity');
    expect(await screen.findByText('Event 1')).toBeTruthy();
    expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0);
    expect(screen.getAllByText('WorkAgent').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Fix checkout' })[0].getAttribute('href')).toBe('/records/50');
    expect(screen.getAllByRole('link', { name: 'Open in GitHub ↗' })[0].getAttribute('href')).toBe('https://github.com/acme/payments/pull/3');
    expect(screen.getByRole('link', { name: 'Refund export' }).getAttribute('href')).toBe('/my/tasks/7');
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Event 3')).toBeTruthy();
    expect(api.listActivities).toHaveBeenLastCalledWith(expect.objectContaining({ before: 'cursor-1' }));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('filters through the URL (project links open filtered) and sends them to the API', async () => {
    api.listActivities.mockResolvedValue({ activities: [activity(1)], next: null });
    const user = renderAt('/activity?projectId=3');
    expect(await screen.findByRole('heading', { name: 'Activity · Payments' })).toBeTruthy();
    expect(api.listActivities).toHaveBeenCalledWith(expect.objectContaining({ projectId: '3' }));
    await user.selectOptions(screen.getByLabelText('Source'), 'github');
    await user.selectOptions(screen.getByLabelText('What happened'), 'merged');
    await user.click(screen.getByLabelText('Only things I did'));
    await waitFor(() => expect(api.listActivities).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: '3', provider: 'github', activityType: 'merged', userId: 9 })));
    expect(screen.getByTestId('where').textContent).toContain('provider=github');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByTestId('where').textContent).toBe('/activity');
  });

  it('shows empty and access-denied states', async () => {
    api.listActivities.mockResolvedValue({ activities: [], next: null });
    renderAt('/activity');
    expect(await screen.findByText('Nothing has happened in your projects yet.')).toBeTruthy();
    cleanup();
    api.listActivities.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Project not found'));
    renderAt('/activity?projectId=99');
    expect(await screen.findByText('That project doesn’t exist or you don’t have access to it.')).toBeTruthy();
  });
});

describe('Record detail', () => {
  const detail = (o = {}) => ({
    record: { id: 50, provider: 'github', recordType: 'pull_request', externalKey: 'acme/payments#3', externalId: '501#3', sourceInstance: 'github.com', title: 'Fix checkout', url: 'https://github.com/acme/payments/pull/3', state: 'merged', statusCategory: 'done', body: 'Fixes #12', author: { login: 'raj' }, project: { id: 3, name: 'Payments' }, metadata: { headRef: 'fix', baseRef: 'main', mergedAt: '2026-10-30T10:00:00Z' }, sourceStatus: 'current', ...o },
    parent: null,
    children: [{ id: 51, recordType: 'review', title: 'Review (approved) on acme/payments#3', author: { login: 'ana' }, sourceUpdatedAt: '2026-10-30T09:00:00Z' }],
    activities: [activity(1, { subject: null })],
    links: [],
  });

  it('shows the record, its source identity, discussion, relationships and timeline', async () => {
    api.getExternalRecord.mockResolvedValue(detail());
    renderAt('/records/50');
    expect(await screen.findByRole('heading', { name: 'Fix checkout' })).toBeTruthy();
    expect(screen.getByText('github · github.com · 501#3')).toBeTruthy();
    expect(screen.getByText('fix → main')).toBeTruthy();
    expect(screen.getByText('Fixes #12')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open in GitHub ↗' }).getAttribute('href')).toBe('https://github.com/acme/payments/pull/3');
    expect(screen.getByRole('link', { name: 'Review (approved) on acme/payments#3' }).getAttribute('href')).toBe('/records/51');
    expect(screen.getByText('Related records')).toBeTruthy();
    expect(screen.getByText('Event 1')).toBeTruthy();
    expect(api.listRecordLinks).toHaveBeenCalledWith('external_record', 50);
  });

  it('explains deleted or disconnected sources, and refuses records you can’t see', async () => {
    api.getExternalRecord.mockResolvedValue(detail({ sourceStatus: 'deleted' }));
    renderAt('/records/50');
    expect(await screen.findByText('Deleted at the source. WorkAgent keeps its history.')).toBeTruthy();
    cleanup();
    api.getExternalRecord.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Record not found'));
    renderAt('/records/99');
    expect(await screen.findByText('This record doesn’t exist or you don’t have access to it.')).toBeTruthy();
  });
});

describe('Related records', () => {
  const link = (id, o = {}) => ({
    id,
    linkType: 'fixes',
    direction: 'incoming',
    origin: 'source',
    status: 'confirmed',
    confidence: 1,
    evidence: null,
    canEdit: true,
    other: { type: 'external_record', id: 60, provider: 'github', recordType: 'pull_request', title: 'Fix refunds', key: 'acme/payments#13', url: 'https://github.com/acme/payments/pull/13', href: '/records/60' },
    ...o,
  });

  it('lists relationships in plain words and lets editors confirm, reject and remove', async () => {
    api.listRecordLinks.mockResolvedValue({
      links: [link(1), link(2, { status: 'suggested', origin: 'rule', confidence: 0.62, linkType: 'tracks', direction: 'outgoing', other: { type: 'action_item', id: 7, provider: 'workagent', recordType: 'task', title: 'Refund export', href: '/my/tasks/7' } })],
    });
    api.reviewRecordLink.mockResolvedValue({ link: {} });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RelatedRecords type="external_record" id={50} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('is fixed by')).toBeTruthy();
    const suggestions = screen.getByRole('region', { name: 'Suggested relationships' });
    expect(within(suggestions).getByText(/suggested by a rule · 62% confidence/)).toBeTruthy();
    await user.click(within(suggestions).getByRole('button', { name: 'Confirm' }));
    expect(api.reviewRecordLink).toHaveBeenCalledWith(2, 'confirmed');
    expect(await screen.findByText('Relationship confirmed.')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    expect(api.reviewRecordLink).toHaveBeenLastCalledWith(1, 'rejected');
  });

  it('adds a relationship by searching for the other record', async () => {
    api.searchRecords.mockResolvedValue({ results: [{ type: 'action_item', id: 7, provider: 'workagent', recordType: 'task', title: 'Refund export' }], counts: {} });
    api.createRecordLink.mockResolvedValue({ link: {} });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <RelatedRecords type="external_record" id={50} />
      </MemoryRouter>,
    );
    await user.click(await screen.findByRole('button', { name: 'Add relationship' }));
    await user.type(screen.getByRole('textbox', { name: 'Find a record to link' }), 'refund');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(await screen.findByRole('radio'));
    await user.selectOptions(screen.getByLabelText('This record'), 'tracks');
    await user.click(screen.getAllByRole('button', { name: 'Add relationship' }).at(-1));
    expect(api.createRecordLink).toHaveBeenCalledWith({ type: 'external_record', id: 50 }, { type: 'action_item', id: 7 }, 'tracks');
    expect(await screen.findByText('Relationship added.')).toBeTruthy();
  });

  it('employees see relationships but cannot change them', async () => {
    auth.user = { id: 4, role: 'employee', fullName: 'Eve' };
    api.listRecordLinks.mockResolvedValue({ links: [link(1, { canEdit: false })] });
    render(
      <MemoryRouter>
        <RelatedRecords type="action_item" id={7} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Fix refunds')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add relationship|Remove|Confirm/ })).toBeNull();
  });
});

describe('Search', () => {
  it('shows mixed results with providers, projects and the right links; tabs narrow the kind', async () => {
    api.searchRecords.mockResolvedValue({
      results: [
        { type: 'external_record', id: 50, provider: 'github', recordType: 'issue', title: 'Refunds fail', key: 'acme/payments#12', url: 'https://github.com/acme/payments/issues/12', href: '/records/50', status: 'open', projectName: 'Payments', snippet: 'Partial refunds time out' },
        { type: 'action_item', id: 7, provider: 'workagent', recordType: 'task', title: 'Refund export', href: '/my/tasks/7', status: 'todo', assigneeName: 'Eve' },
      ],
      counts: { external_record: 1, task: 1, meeting: 0, project: 0 },
    });
    const user = renderAt('/search?q=refund');
    expect(await screen.findByText('Partial refunds time out')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Refunds fail' }).getAttribute('href')).toBe('/records/50');
    expect(screen.getByRole('link', { name: 'Refund export' }).getAttribute('href')).toBe('/my/tasks/7');
    expect(screen.getByText('Assigned to Eve')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Tasks (1)' })).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: /Tasks/ }));
    await waitFor(() => expect(api.searchRecords).toHaveBeenLastCalledWith({ q: 'refund', types: 'task', limit: 25 }));
  });

  it('searches from the box and explains empty results', async () => {
    api.searchRecords.mockResolvedValue({ results: [], counts: {} });
    const user = renderAt('/search');
    await user.type(screen.getByRole('textbox', { name: 'Search WorkAgent' }), 'nothing here');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No results')).toBeTruthy();
    expect(screen.getByTestId('where').textContent).toBe('/search?q=nothing+here');
  });
});

describe('Suggestions (Phase 5)', () => {
  it('lists suggestions with both ends, reason and confidence, and confirms or rejects them', async () => {
    const s = (id, o = {}) => ({
      id,
      linkType: 'tracks',
      confidence: 0.72,
      evidence: { matcher: 'wording-overlap', reason: 'Same project; both mention refund, partial' },
      createdAt: '2026-10-30T10:00:00Z',
      from: { type: 'action_item', id: 7, provider: 'workagent', recordType: 'task', title: 'Refund export', href: '/my/tasks/7' },
      to: { type: 'external_record', id: 50, provider: 'github', recordType: 'issue', title: 'Refunds fail', key: 'acme/payments#12', url: 'https://github.com/acme/payments/issues/12', href: '/records/50' },
      ...o,
    });
    api.listLinkSuggestions.mockResolvedValue({ suggestions: [s(1), s(2, { from: { ...s(1).from, title: 'Ledger fix' } })] });
    api.reviewRecordLink.mockResolvedValue({ link: {} });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <SuggestionsPage />
      </MemoryRouter>,
    );
    expect(await screen.findAllByText(/Similar wording · 72% confidence · Same project; both mention refund, partial/)).toHaveLength(2);
    expect(screen.getAllByRole('link', { name: 'Refunds fail' })[0].getAttribute('href')).toBe('/records/50');
    await user.click(screen.getAllByRole('button', { name: 'Confirm' })[0]);
    expect(api.reviewRecordLink).toHaveBeenCalledWith(1, 'confirmed');
    expect(await screen.findByText('Relationship confirmed.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    expect(api.reviewRecordLink).toHaveBeenLastCalledWith(2, 'rejected');
    expect(await screen.findByText('Nothing to review')).toBeTruthy();
  });
});
