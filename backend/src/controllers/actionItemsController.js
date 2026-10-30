// Admin review of action items (Phase 4). Every mutation runs in a transaction that locks the
// meeting row first, then the item row(s): the same order the extraction worker uses when it
// saves results, so a review edit and a worker save can't interleave or deadlock.
import { withTransaction } from '../db/transaction.js';
import * as actionItems from '../repositories/actionItemsRepository.js';
import * as meetings from '../repositories/meetingsRepository.js';
import * as projects from '../repositories/projectsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { audit, recordAudit } from '../services/audit.js';
import { REVIEWABLE_MEETING_STATUSES, ReviewRuleError, applyEdit, approvalProblems, transition } from '../services/review.js';
import { AppError, badRequest, notFound } from '../utils/errors.js';

const reviewLocked = (status) =>
  new AppError(409, 'REVIEW_LOCKED', status === 'extracting'
    ? 'Action items can’t be changed while extraction is running'
    : `Action items can’t be changed while the meeting is "${status.replaceAll('_', ' ')}"`);

async function lockMeeting(conn, meetingId) {
  const meeting = await meetings.findByIdForUpdate(conn, meetingId);
  if (!meeting) throw notFound('Meeting not found');
  if (!REVIEWABLE_MEETING_STATUSES.includes(meeting.status)) throw reviewLocked(meeting.status);
  return meeting;
}

/** Locks the item's meeting, then the item. Returns the item in API shape. */
async function lockItem(conn, itemId) {
  const unlocked = await actionItems.findById(itemId, { conn });
  if (!unlocked) throw notFound('Action item not found');
  await lockMeeting(conn, unlocked.meetingId);
  return actionItems.findById(itemId, { conn, forUpdate: true });
}

async function assertActiveAssignee(userId) {
  if (!userId) return;
  const [active] = await users.findActiveIds([userId]);
  if (!active) throw badRequest('Invalid assignee', [{ field: 'assigneeUserId', message: 'Choose an active registered user' }]);
}

const asRuleError = (err) => (err instanceof ReviewRuleError ? new AppError(409, 'INVALID_TRANSITION', err.message, err.details) : err);

export async function update(req, res) {
  const { id } = req.params;
  await assertActiveAssignee(req.body.assigneeUserId);

  const { before, after } = await withTransaction(async (conn) => {
    const item = await lockItem(conn, id);
    if (item.reviewStatus !== 'pending') {
      throw new AppError(409, 'ITEM_NOT_PENDING', `This item is ${item.reviewStatus}. Reopen it to make changes.`);
    }
    let fields;
    try {
      fields = applyEdit(item, req.body, { actorId: req.user.id });
    } catch (err) {
      if (err instanceof ReviewRuleError) throw badRequest(err.message, [{ field: 'resolveFlags', message: err.message }]);
      throw err;
    }
    await actionItems.update(conn, id, fields);
    return { before: item, after: await actionItems.findById(id, { conn }) };
  });

  await audit({ actorUserId: req.user.id, action: 'action_item.updated', entityType: 'action_item', entityId: id, before: snapshot(before), after: snapshot(after), ip: req.ip });
  res.json({ actionItem: after });
}

function reviewAction(action) {
  return async (req, res) => {
    const { id } = req.params;
    const { before, after } = await withTransaction(async (conn) => {
      const item = await lockItem(conn, id);
      let to;
      try {
        to = transition(action, item.reviewStatus);
      } catch (err) {
        throw asRuleError(err);
      }
      if (action === 'approve') {
        const problems = approvalProblems(item);
        if (problems.length) throw new AppError(409, 'NOT_APPROVABLE', 'This item can’t be approved yet', problems.map((message) => ({ field: '', message })));
      }
      const details = { ...(item.reviewDetails ?? {}) };
      const stamp = { by: req.user.id, at: new Date().toISOString() };
      if (action === 'reject') details.rejection = { ...stamp, reason: req.body?.reason || null };
      if (action === 'reopen') details.reopenedAt = [...(details.reopenedAt ?? []), stamp];
      await actionItems.setReviewStatus(conn, id, to, { actorId: req.user.id, reviewDetails: details });
      return { before: item, after: await actionItems.findById(id, { conn }) };
    });

    const verb = { approve: 'approved', reject: 'rejected', reopen: 'reopened' }[action];
    await audit({ actorUserId: req.user.id, action: `action_item.${verb}`, entityType: 'action_item', entityId: id, before: snapshot(before), after: snapshot(after), ip: req.ip });
    res.json({ actionItem: after });
  };
}

export const approve = reviewAction('approve');
export const reject = reviewAction('reject');
export const reopen = reviewAction('reopen');

async function assertLinkableProject(projectId) {
  if (!projectId) return;
  const project = await projects.findById(projectId);
  if (!project) throw badRequest('Invalid project', [{ field: 'projectId', message: 'Project not found' }]);
  if (project.status === 'archived') throw badRequest('Invalid project', [{ field: 'projectId', message: 'This project is archived' }]);
}

/**
 * Sets or clears an item's project (Phase 2). Allowed in any review state: it does not change
 * the reviewed content, the assignee's task status or what the assignee can see.
 */
export async function setProject(req, res) {
  const { id } = req.params;
  const { projectId } = req.body;
  await assertLinkableProject(projectId);
  const { before, after } = await withTransaction(async (conn) => {
    const item = await actionItems.findById(id, { conn, forUpdate: true });
    if (!item) throw notFound('Action item not found');
    await actionItems.setProject(conn, id, projectId);
    await recordAudit(conn, {
      actorUserId: req.user.id,
      action: 'action_item.project_changed',
      entityType: 'action_item',
      entityId: id,
      before: { projectId: item.projectId },
      after: { projectId },
      ip: req.ip,
    });
    return { before: item, after: await actionItems.findById(id, { conn }) };
  });
  if (before.projectId !== projectId) {
    if (projectId) await audit({ actorUserId: req.user.id, action: 'project.task_linked', entityType: 'project', entityId: projectId, after: { actionItemId: id, title: after.title }, ip: req.ip });
    if (before.projectId) await audit({ actorUserId: req.user.id, action: 'project.task_unlinked', entityType: 'project', entityId: before.projectId, before: { actionItemId: id, title: after.title }, ip: req.ip });
  }
  res.json({ actionItem: after });
}

export async function createManual(req, res) {
  const { id: meetingId } = req.params;
  await assertActiveAssignee(req.body.assigneeUserId);
  await assertLinkableProject(req.body.projectId);

  const item = await withTransaction(async (conn) => {
    await lockMeeting(conn, meetingId);
    const itemId = await actionItems.createManual(conn, meetingId, { ...req.body, actorId: req.user.id });
    return actionItems.findById(itemId, { conn });
  });

  await audit({ actorUserId: req.user.id, action: 'action_item.created', entityType: 'action_item', entityId: item.id, after: snapshot(item), ip: req.ip });
  res.status(201).json({ actionItem: item });
}

/**
 * Finishes the review (PLANNING.md: "approve all pending, blocks if unresolved flags").
 * Every pending item must be approvable; then all of them are approved and the meeting
 * moves to 'approved'. Rejected items stay rejected.
 */
export async function approveMeeting(req, res) {
  const { id } = req.params;
  const result = await withTransaction(async (conn) => {
    const meeting = await lockMeeting(conn, id);
    const [[{ total }]] = await conn.query('SELECT COUNT(*) AS total FROM action_items WHERE meeting_id = ?', [id]);
    if (total === 0) throw new AppError(409, 'NOTHING_TO_APPROVE', 'There are no action items to review');

    const pending = await actionItems.listPendingForUpdate(conn, id);
    const blocked = pending
      .map((item) => ({ item, problems: approvalProblems(item) }))
      .filter((x) => x.problems.length);
    if (blocked.length) {
      throw new AppError(
        409,
        'ITEMS_NEED_ATTENTION',
        `${blocked.length} pending item${blocked.length === 1 ? '' : 's'} can’t be approved yet`,
        blocked.map(({ item, problems }) => ({ field: `actionItem:${item.id}`, message: `${item.title}: ${problems.join('; ')}` })),
      );
    }
    for (const item of pending) {
      await actionItems.setReviewStatus(conn, item.id, 'approved', { actorId: req.user.id, reviewDetails: item.reviewDetails });
    }
    await meetings.update(conn, id, { status: 'approved', lastError: null });
    return { previousStatus: meeting.status, approved: pending.length };
  });

  await audit({
    actorUserId: req.user.id,
    action: 'meeting.review_completed',
    entityType: 'meeting',
    entityId: id,
    before: { status: result.previousStatus },
    after: { status: 'approved', approvedNow: result.approved },
    ip: req.ip,
  });
  res.json({ meeting: { id, status: 'approved' }, approved: result.approved });
}

// Audit entries keep the reviewable fields, not evidence text.
const snapshot = (item) =>
  item && {
    title: item.title,
    description: item.description,
    assigneeUserId: item.assignee?.id ?? null,
    dueDate: item.dueDate,
    priority: item.priority,
    reviewStatus: item.reviewStatus,
    flags: item.flags,
  };
