import { withTransaction } from '../db/transaction.js';
import { extractionStatus } from './extractionController.js';
import * as meetings from '../repositories/meetingsRepository.js';
import * as projects from '../repositories/projectsRepository.js';
import * as transcripts from '../repositories/transcriptsRepository.js';
import * as users from '../repositories/usersRepository.js';
import { audit, recordAudit } from '../services/audit.js';
import { badRequest, notFound } from '../utils/errors.js';

const toParticipant = (row) => ({
  id: row.id,
  email: row.email,
  fullName: row.full_name,
  role: row.role,
  isActive: Boolean(row.is_active),
});

async function assertActiveUsers(userIds) {
  const unique = [...new Set(userIds)];
  const found = new Set(await users.findActiveIds(unique));
  const missing = unique.filter((id) => !found.has(id));
  if (missing.length) {
    throw badRequest('Some participants are not active users', missing.map((id) => ({ field: 'participantIds', message: `User ${id} not found or inactive` })));
  }
  return unique;
}

// A meeting can be linked to an existing, non-archived project, chosen manually by an admin.
async function assertLinkableProject(projectId) {
  if (!projectId) return;
  const project = await projects.findById(projectId);
  if (!project) throw badRequest('Invalid project', [{ field: 'projectId', message: 'Project not found' }]);
  if (project.status === 'archived') throw badRequest('Invalid project', [{ field: 'projectId', message: 'This project is archived' }]);
}

async function recordProjectLink(conn, { actorUserId, meetingId, title, from, to, ip }) {
  if (from) await recordAudit(conn, { actorUserId, action: 'project.meeting_unlinked', entityType: 'project', entityId: from, before: { meetingId, title }, ip });
  if (to) await recordAudit(conn, { actorUserId, action: 'project.meeting_linked', entityType: 'project', entityId: to, after: { meetingId, title }, ip });
}

async function loadDetail(id) {
  const row = await meetings.findById(id);
  if (!row) throw notFound('Meeting not found');
  const [participants, transcript, extraction] = await Promise.all([
    meetings.listParticipants(id),
    transcripts.findSummaryByMeeting(id),
    extractionStatus(id),
  ]);
  return {
    ...meetings.toMeeting(row),
    participants: participants.map(toParticipant),
    transcript: transcript ? transcripts.toTranscriptSummary(transcript) : null,
    extraction,
  };
}

export async function list(req, res) {
  const { rows, total } = await meetings.list(req.query);
  res.json({ meetings: rows.map(meetings.toMeeting), total, limit: req.query.limit, offset: req.query.offset });
}

export async function get(req, res) {
  res.json({ meeting: await loadDetail(req.params.id) });
}

export async function create(req, res) {
  const { participantIds = [], ...fields } = req.body;
  const userIds = await assertActiveUsers(participantIds);
  await assertLinkableProject(fields.projectId);

  const id = await withTransaction(async (conn) => {
    const meetingId = await meetings.create(conn, { ...fields, createdBy: req.user.id });
    await meetings.replaceParticipants(conn, meetingId, userIds);
    if (fields.projectId) {
      await recordProjectLink(conn, { actorUserId: req.user.id, meetingId, title: fields.title, from: null, to: fields.projectId, ip: req.ip });
    }
    return meetingId;
  });

  const meeting = await loadDetail(id);
  await audit({ actorUserId: req.user.id, action: 'meeting.created', entityType: 'meeting', entityId: id, after: meeting, ip: req.ip });
  res.status(201).json({ meeting });
}

export async function update(req, res) {
  const { id } = req.params;
  const { participantIds, ...fields } = req.body;
  const before = await loadDetail(id);
  const userIds = participantIds ? await assertActiveUsers(participantIds) : null;
  const projectChanged = fields.projectId !== undefined && fields.projectId !== before.projectId;
  if (projectChanged) await assertLinkableProject(fields.projectId);

  await withTransaction(async (conn) => {
    await meetings.update(conn, id, fields);
    if (projectChanged) {
      await meetings.moveItemsWithMeeting(conn, id, before.projectId, fields.projectId);
      await recordProjectLink(conn, { actorUserId: req.user.id, meetingId: id, title: before.title, from: before.projectId, to: fields.projectId, ip: req.ip });
    }
    if (userIds) await meetings.replaceParticipants(conn, id, userIds);
  });

  const after = await loadDetail(id);
  await audit({ actorUserId: req.user.id, action: 'meeting.updated', entityType: 'meeting', entityId: id, before, after, ip: req.ip });
  res.json({ meeting: after });
}
