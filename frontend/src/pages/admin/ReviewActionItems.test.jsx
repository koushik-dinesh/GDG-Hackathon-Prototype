import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as itemsApi from '../../api/actionItems.js';
import * as meetingsApi from '../../api/meetings.js';
import * as projectsApi from '../../api/projects.js';
import { extractionState } from '../../components/review/ExtractionPanel.jsx';
import { MeetingDetailPage } from './MeetingDetail.jsx';
import { ReviewActionItems } from './ReviewActionItems.jsx';

vi.mock('../../api/meetings.js');
// Related records are covered by their own tests; the meeting page only hosts them.
vi.mock('../../components/RelatedRecords.jsx', () => ({ RelatedRecords: () => null }));
vi.mock('../../api/actionItems.js');
// The meeting page also renders the bot panel; keep it offline.
vi.mock('../../api/bot.js', () => ({
  getBot: vi.fn(async () => ({ bot: { configured: false, meetingStatus: 'review_pending', linkValid: true, canRequest: false, bot: null, polling: null, transcript: null } })),
}));
vi.mock('../../api/projects.js', () => ({
  listProjects: vi.fn(async () => ({
    projects: [
      { id: 1, name: 'Payments' },
      { id: 2, name: 'Mobile app' },
    ],
  })),
}));
vi.mock('../../api/users.js', () => ({
  listUsers: vi.fn(async () => ({
    users: [
      { id: 2, fullName: 'Raj Patel', isActive: true },
      { id: 3, fullName: 'Sam Lee', isActive: true },
      { id: 4, fullName: 'Sam Carter', isActive: true },
    ],
  })),
}));

const FLAGS = {
  ambiguous_assignee: 'Owner name matches several users',
  ambiguous_deadline: 'Deadline is vague or ambiguous',
  missing_deadline: 'No deadline was stated',
};

const aiItem = (o = {}) => ({
  id: 1,
  meetingId: 7,
  source: 'ai',
  title: 'Book the venue',
  description: 'Sam books the launch venue.',
  assigneeNameRaw: 'Sam',
  assignee: null,
  assigneeMatch: 'none',
  dueDate: null,
  dueDateRaw: 'next Friday',
  priority: 'medium',
  reviewStatus: 'pending',
  taskStatus: 'todo',
  flags: ['ambiguous_assignee', 'ambiguous_deadline'],
  reviewDetails: { assignee: { candidates: [{ id: 3, fullName: 'Sam Lee', isActive: true }, { id: 4, fullName: 'Sam Carter', isActive: true }] } },
  aiConfidence: 0.87,
  evidence: [{ id: 11, excerpt: "I'll book the venue next Friday", speaker: 'Sam', startSec: 48, segmentId: 104 }],
  ...o,
});

const meeting = (o = {}) => ({
  id: 7,
  title: 'Launch sync',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  status: 'review_pending',
  scheduledAt: '2026-11-04T10:00:00Z',
  createdAt: '2026-11-01T10:00:00Z',
  languageHint: null,
  lastError: null,
  participants: [],
  transcript: { id: 1, segmentCount: 9, format: 'text', filename: null, detectedLanguages: [], fetchedAt: '2026-11-04T11:00:00Z' },
  extraction: { id: 5, status: 'succeeded', summary: { saved: 1, rejected: 0 }, createdAt: '2026-11-04T11:05:00Z', finishedAt: '2026-11-04T11:06:00Z' },
  ...o,
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

function renderReview(items = [aiItem()], m = meeting(), props = {}) {
  meetingsApi.getActionItems.mockResolvedValue({ actionItems: items, flagDescriptions: FLAGS });
  const onMeetingChanged = vi.fn(async () => {});
  const onShowEvidence = vi.fn();
  render(<ReviewActionItems meeting={m} onMeetingChanged={onMeetingChanged} onShowEvidence={onShowEvidence} {...props} />);
  return { onMeetingChanged, onShowEvidence, user: userEvent.setup() };
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('extraction state', () => {
  it('derives every state from the meeting as the backend reports it', () => {
    expect(extractionState(meeting({ transcript: null, extraction: null, status: 'draft' }))).toBe('no_transcript');
    expect(extractionState(meeting({ extraction: null, status: 'transcript_ready' }))).toBe('not_started');
    expect(extractionState(meeting({ status: 'extracting', extraction: { status: 'queued' } }))).toBe('queued');
    expect(extractionState(meeting({ status: 'extracting', extraction: { status: 'running' } }))).toBe('processing');
    expect(extractionState(meeting())).toBe('done');
    expect(extractionState(meeting({ status: 'failed', extraction: { status: 'failed' } }))).toBe('failed');
    expect(extractionState(meeting({ status: 'approved' }))).toBe('reviewed');
  });

  it('shows failures with the backend message and offers a retry', async () => {
    meetingsApi.startExtraction.mockResolvedValue({});
    const { onMeetingChanged, user } = renderReview([], meeting({ status: 'failed', lastError: 'The AI provider is temporarily unavailable', extraction: { id: 5, status: 'failed' } }));
    expect(await screen.findByText(/Extraction failed: The AI provider is temporarily unavailable/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(meetingsApi.startExtraction).toHaveBeenCalledWith(7);
    expect(onMeetingChanged).toHaveBeenCalled();
  });

  it('starts extraction once even when clicked repeatedly, and explains a missing API key', async () => {
    const pending = deferred();
    meetingsApi.startExtraction.mockReturnValue(pending.promise);
    const { user } = renderReview([], meeting({ status: 'transcript_ready', extraction: null }));
    const button = await screen.findByRole('button', { name: 'Extract action items' });
    await user.click(button);
    await user.click(button);
    expect(meetingsApi.startExtraction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Starting…' }).disabled).toBe(true);
    await act(async () => pending.reject(Object.assign(new Error('x'), { code: 'AI_NOT_CONFIGURED', status: 503 })));
    expect(await screen.findByText(/isn’t configured on the server/)).toBeTruthy();
  });

  it('shows queued/processing progress and no start button', async () => {
    renderReview([], meeting({ status: 'extracting', extraction: { id: 6, status: 'running' } }));
    expect(await screen.findByText('Extracting action items…')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /extract/i })).toBeNull();
  });
});

describe('reviewing items', () => {
  it('lists items with flags, raw deadline wording, confidence and evidence', async () => {
    const { onShowEvidence, user } = renderReview([
      aiItem(),
      aiItem({ id: 2, title: 'Send the deck', reviewStatus: 'approved', flags: [], assignee: { id: 2, fullName: 'Raj Patel', isActive: true } }),
      aiItem({ id: 3, title: 'Manual follow-up', source: 'manual', aiConfidence: null, evidence: [], flags: [] }),
    ]);
    const card = await screen.findByRole('article', { name: 'Book the venue' });
    expect(within(card).getByText('Needs review')).toBeTruthy();
    expect(within(card).getByText(/87% confidence/)).toBeTruthy();
    expect(within(card).getByText('Unassigned')).toBeTruthy();
    expect(within(card).getByText('Said: “next Friday”')).toBeTruthy();
    expect(within(card).getByText(FLAGS.ambiguous_assignee)).toBeTruthy();
    expect(within(card).getByText('“I\'ll book the venue next Friday”')).toBeTruthy();
    await user.click(within(card).getByRole('button', { name: 'Show in transcript' }));
    expect(onShowEvidence).toHaveBeenCalledWith(104);

    expect(within(screen.getByRole('region', { name: 'Approved' })).getByText('Send the deck')).toBeTruthy();
    const manual = screen.getByRole('article', { name: 'Manual follow-up' });
    expect(within(manual).getByText('Added manually')).toBeTruthy();
    expect(within(manual).getByText(/no transcript evidence/)).toBeTruthy();
  });

  it('shows a load error', async () => {
    meetingsApi.getActionItems.mockRejectedValue(new Error('Cannot reach the server. Is the backend running?'));
    render(<ReviewActionItems meeting={meeting()} onMeetingChanged={vi.fn()} onShowEvidence={vi.fn()} />);
    expect(await screen.findByText(/Could not load action items: Cannot reach the server/)).toBeTruthy();
  });

  it('edits an item and sends only the changed fields', async () => {
    itemsApi.updateActionItem.mockImplementation(async (id, body) => ({ actionItem: aiItem({ title: body.title, priority: body.priority }) }));
    const { user } = renderReview();
    const card = await screen.findByRole('article', { name: 'Book the venue' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const title = within(card).getByLabelText('Title');
    await user.clear(title);
    await user.type(title, 'Book the launch venue');
    await user.selectOptions(within(card).getByLabelText('Priority'), 'high');
    await user.click(within(card).getByRole('button', { name: 'Save changes' }));
    expect(itemsApi.updateActionItem).toHaveBeenCalledWith(1, { title: 'Book the launch venue', priority: 'high' });
    expect(await screen.findByRole('article', { name: 'Book the launch venue' })).toBeTruthy();
    expect(screen.getByText('Changes saved.')).toBeTruthy();
  });

  it('shows server validation errors next to fields', async () => {
    itemsApi.updateActionItem.mockRejectedValue(Object.assign(new Error('Invalid request body'), { status: 400, code: 'VALIDATION_ERROR', details: [{ field: 'dueDate', message: 'Use a valid date (YYYY-MM-DD)' }] }));
    const { user } = renderReview();
    const card = await screen.findByRole('article', { name: 'Book the venue' });
    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    await user.type(within(card).getByLabelText('Due date'), '2026-11-13');
    await user.click(within(card).getByRole('button', { name: 'Save changes' }));
    expect(await within(card).findByText('Use a valid date (YYYY-MM-DD)')).toBeTruthy();
    expect(within(card).getByText('Please fix the highlighted fields.')).toBeTruthy();
  });

  it('resolves an ambiguous assignee by picking a candidate, and a flag explicitly', async () => {
    itemsApi.updateActionItem
      .mockResolvedValueOnce({ actionItem: aiItem({ assignee: { id: 3, fullName: 'Sam Lee', isActive: true }, assigneeMatch: 'manual', flags: ['ambiguous_deadline'] }) })
      .mockResolvedValueOnce({ actionItem: aiItem({ assignee: { id: 3, fullName: 'Sam Lee', isActive: true }, flags: [] }) });
    const { user } = renderReview();
    const card = await screen.findByRole('article', { name: 'Book the venue' });
    await user.click(within(card).getByRole('button', { name: 'Assign Sam Lee' }));
    expect(itemsApi.updateActionItem).toHaveBeenLastCalledWith(1, { assigneeUserId: 3 });
    expect(await within(card).findByText('Sam Lee')).toBeTruthy();
    expect(within(card).queryByText(FLAGS.ambiguous_assignee)).toBeNull();

    await user.click(within(card).getByRole('button', { name: 'Mark resolved' }));
    expect(itemsApi.updateActionItem).toHaveBeenLastCalledWith(1, { resolveFlags: ['ambiguous_deadline'] });
    await waitFor(() => expect(within(card).queryByRole('list', { name: 'Review flags' })).toBeNull());
  });

  it('approves only after the server confirms, once, and keeps the item pending on failure', async () => {
    const pending = deferred();
    itemsApi.approveActionItem.mockReturnValueOnce(pending.promise);
    const { user } = renderReview();
    const card = await screen.findByRole('article', { name: 'Book the venue' });
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    await user.click(within(card).getByRole('button', { name: 'Working…' }));
    expect(itemsApi.approveActionItem).toHaveBeenCalledTimes(1);
    expect(within(card).getByText('Needs review')).toBeTruthy(); // not optimistic

    await act(async () =>
      pending.reject(Object.assign(new Error('This item can’t be approved yet'), { status: 409, details: [{ message: 'Choose an assignee' }] })),
    );
    expect(await within(card).findByText('Choose an assignee')).toBeTruthy();
    expect(within(card).getByText('Needs review')).toBeTruthy();

    itemsApi.approveActionItem.mockResolvedValueOnce({ actionItem: aiItem({ reviewStatus: 'approved', flags: [] }) });
    await user.click(within(card).getByRole('button', { name: 'Approve' }));
    const approved = await screen.findByRole('region', { name: 'Approved' });
    expect(within(approved).getByText('Book the venue')).toBeTruthy();
    expect(screen.getByText('Item approved.')).toBeTruthy();
  });

  it('rejects with an optional reason after confirmation', async () => {
    itemsApi.rejectActionItem.mockResolvedValue({ actionItem: aiItem({ reviewStatus: 'rejected', reviewDetails: { rejection: { reason: 'Only an idea' } } }) });
    const { user } = renderReview();
    const card = await screen.findByRole('article', { name: 'Book the venue' });
    await user.click(within(card).getByRole('button', { name: 'Reject' }));
    expect(itemsApi.rejectActionItem).not.toHaveBeenCalled();
    await user.type(within(card).getByLabelText('Reason (optional)'), 'Only an idea');
    await user.click(within(card).getByRole('button', { name: 'Confirm reject' }));
    expect(itemsApi.rejectActionItem).toHaveBeenCalledWith(1, 'Only an idea');
    const rejected = await screen.findByRole('region', { name: 'Rejected' });
    expect(within(rejected).getByText('Rejection reason: Only an idea')).toBeTruthy();
    expect(within(rejected).getByRole('button', { name: 'Reopen' })).toBeTruthy();
  });

  it('adds a manual item through the API', async () => {
    meetingsApi.createActionItem.mockResolvedValue({ actionItem: aiItem({ id: 9, title: 'Order badges', source: 'manual', aiConfidence: null, evidence: [], flags: [], assignee: { id: 2, fullName: 'Raj Patel', isActive: true } }) });
    const { user } = renderReview([]);
    await user.click(await screen.findByRole('button', { name: 'Add action item' }));
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getByText('Required')).toBeTruthy();
    expect(meetingsApi.createActionItem).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText('Title'), 'Order badges');
    await user.selectOptions(screen.getByLabelText('Assignee'), '2');
    await user.type(screen.getByLabelText('Due date'), '2026-11-20');
    await user.click(screen.getByRole('button', { name: 'Add item' }));
    expect(meetingsApi.createActionItem).toHaveBeenCalledWith(7, { title: 'Order badges', description: null, assigneeUserId: 2, dueDate: '2026-11-20', priority: 'medium' });
    expect(await screen.findByRole('article', { name: 'Order badges' })).toBeTruthy();
    expect(screen.getByText('Action item added.')).toBeTruthy();
  });

  it('shows what blocks finishing the review', async () => {
    meetingsApi.finishReview.mockRejectedValue(Object.assign(new Error('1 pending item can’t be approved yet'), { status: 409, details: [{ field: 'actionItem:1', message: 'Book the venue: Choose an assignee' }] }));
    const { onMeetingChanged, user } = renderReview();
    await user.click(await screen.findByRole('button', { name: 'Finish review' }));
    expect(await screen.findByText('Book the venue: Choose an assignee')).toBeTruthy();
    expect(onMeetingChanged).not.toHaveBeenCalled();
  });

  it('is read-only once the review is finished', async () => {
    renderReview([aiItem({ reviewStatus: 'approved', flags: [] })], meeting({ status: 'approved' }));
    await screen.findByRole('article', { name: 'Book the venue' });
    expect(screen.queryByRole('button', { name: /Approve|Edit|Reject|Reopen|Add action item|Finish review/ })).toBeNull();
    expect(screen.getByText(/Review finished/)).toBeTruthy();
  });

  it('moves an item to another project in any review state, loading projects once', async () => {
    const items = [aiItem({ reviewStatus: 'approved', flags: [], projectId: 1, project: { id: 1, name: 'Payments' } }), aiItem({ id: 2, title: 'Write notes' })];
    itemsApi.setActionItemProject.mockResolvedValue({ actionItem: { ...items[0], projectId: 2, project: { id: 2, name: 'Mobile app' } } });
    const { user } = renderReview(items, meeting({ status: 'approved' }));
    const card = await screen.findByRole('article', { name: 'Book the venue' });
    const select = within(card).getByLabelText('Project');
    await waitFor(() => expect(within(select).getByRole('option', { name: 'Mobile app' })).toBeTruthy());
    expect(select.value).toBe('1');
    expect(projectsApi.listProjects).toHaveBeenCalledTimes(1);

    await user.selectOptions(select, '2');
    expect(itemsApi.setActionItemProject).toHaveBeenCalledWith(1, 2);
    expect(await screen.findByText('Project updated.')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: 'Book the venue' })).getByLabelText('Project').value).toBe('2');
  });
});

describe('meeting page polling', () => {
  it('polls while extracting and stops once the backend reports a terminal state', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    meetingsApi.getTranscript.mockResolvedValue({ segments: [{ id: 104, speaker: 'Sam', text: "I'll book the venue next Friday", startSec: 48 }] });
    meetingsApi.getActionItems.mockResolvedValue({ actionItems: [], flagDescriptions: FLAGS });
    meetingsApi.getMeeting
      .mockResolvedValueOnce({ meeting: meeting({ status: 'extracting', extraction: { id: 6, status: 'queued' } }) })
      .mockResolvedValueOnce({ meeting: meeting({ status: 'extracting', extraction: { id: 6, status: 'running' } }) })
      .mockResolvedValue({ meeting: meeting({ extraction: { id: 6, status: 'succeeded', summary: { saved: 1, rejected: 0 }, createdAt: '2026-11-04T11:05:00Z' } }) });

    render(
      <MemoryRouter initialEntries={['/admin/meetings/7']}>
        <Routes>
          <Route path="/admin/meetings/:id" element={<MeetingDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Extraction queued…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await screen.findByText('Extracting action items…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(await screen.findByRole('button', { name: 'Run extraction again' })).toBeTruthy();
    const calls = meetingsApi.getMeeting.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(meetingsApi.getMeeting.mock.calls.length).toBe(calls); // stopped
  });
});
