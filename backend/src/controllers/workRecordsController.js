// Read APIs for synced work (Phase 3A, docs/PHASE_3A_PLAN.md §9), plus admin link review.
//
// Visibility follows projects: a record or activity is visible to whoever can see its project
// (admins, the owner, members). Records with no project are admin-only. Invisible things are 404,
// the same as for projects themselves.
import { pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import * as activities from '../repositories/activitiesRepository.js';
import * as records from '../repositories/externalRecordsRepository.js';
import * as projects from '../repositories/projectsRepository.js';
import * as links from '../repositories/recordLinksRepository.js';
import { audit, recordAudit } from '../services/audit.js';
import { createLink } from '../services/integrations/links.js';
import { canViewProject, isAdmin } from '../services/permissions.js';
import { badRequest, notFound } from '../utils/errors.js';

// Opaque keyset cursors: base64url JSON { t: ISO time, id }.
export const encodeCursor = (t, id) => Buffer.from(JSON.stringify({ t: new Date(t).toISOString(), id })).toString('base64url');
export function decodeCursor(value) {
  if (!value) return null;
  try {
    const { t, id } = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    const time = new Date(t);
    if (Number.isNaN(time.getTime()) || !Number.isSafeInteger(id) || id <= 0) throw new Error('bad cursor');
    return { time, id };
  } catch {
    throw badRequest('Invalid cursor', [{ field: 'before', message: 'Use the "next" value from the previous page' }]);
  }
}

async function canSeeProject(user, projectId) {
  if (isAdmin(user)) return true;
  if (!projectId) return false;
  const project = await projects.findById(projectId);
  if (!project) return false;
  return canViewProject(user, project, await projects.isMember(projectId, user.id));
}

/** The project filter a request may use: a visible project id, null (unassigned, admins), or all (admins). */
async function scopeFor(req) {
  const { projectId, unassigned } = req.query;
  if (projectId) {
    if (!(await projects.findById(projectId)) || !(await canSeeProject(req.user, projectId))) throw notFound('Project not found');
    return projectId;
  }
  if (!isAdmin(req.user)) throw badRequest('projectId is required', [{ field: 'projectId', message: 'Choose a project' }]);
  return unassigned ? null : undefined;
}

function page(rows, limit, keyOf) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, next: more && last ? encodeCursor(keyOf(last), last.id) : null };
}

export async function listRecords(req, res) {
  const projectId = await scopeFor(req);
  const cursor = decodeCursor(req.query.before);
  const rows = await records.listForRead({
    projectId,
    recordType: req.query.recordType,
    statusCategory: req.query.statusCategory,
    q: req.query.q,
    before: cursor && { sortAt: cursor.time, id: cursor.id },
    limit: req.query.limit,
  });
  const { items, next } = page(rows, req.query.limit, (r) => r.sortAt);
  res.json({ records: items, next });
}

/** Links of a record that this user may see: admins see all; others only confirmed links to visible records. */
async function visibleLinks(user, recordId) {
  const all = await links.listFor({ type: 'external_record', id: recordId });
  if (isAdmin(user)) return all;
  const out = [];
  for (const link of all) {
    if (link.status !== 'confirmed') continue;
    const other = link.from.type === 'external_record' && link.from.id === recordId ? link.to : link.from;
    if (other.type !== 'external_record') continue;
    const otherRecord = await records.findById(other.id);
    if (otherRecord && (await canSeeProject(user, otherRecord.projectId))) out.push(link);
  }
  return out;
}

export async function getRecord(req, res) {
  const record = await records.findForRead(req.params.id);
  if (!record || !(await canSeeProject(req.user, record.projectId))) throw notFound('Record not found');
  const timeline = await activities.listForRead({ recordId: record.id, limit: 100 });
  res.json({ record, activities: timeline.slice(0, 100), links: await visibleLinks(req.user, record.id) });
}

/** Admin: move one record to a project by hand; it then stays there when its resource is re-mapped. */
export async function setRecordProject(req, res) {
  const { projectId } = req.body;
  if (projectId) {
    const project = await projects.findById(projectId);
    if (!project) throw badRequest('Invalid project', [{ field: 'projectId', message: 'Project not found' }]);
    if (project.status === 'archived') throw badRequest('Invalid project', [{ field: 'projectId', message: 'This project is archived' }]);
  }
  const before = await records.findById(req.params.id);
  if (!before) throw notFound('Record not found');
  await withTransaction(async (conn) => {
    await records.setProjectManually(conn, before.id, projectId);
    await recordAudit(conn, {
      actorUserId: req.user.id,
      action: 'external_record.project_changed',
      entityType: 'external_record',
      entityId: before.id,
      before: { projectId: before.projectId },
      after: { projectId },
      ip: req.ip,
    });
  });
  res.json({ record: await records.findForRead(before.id) });
}

export async function listActivities(req, res) {
  const projectId = await scopeFor(req);
  const cursor = decodeCursor(req.query.before);
  const rows = await activities.listForRead({ projectId, before: cursor && { occurredAt: cursor.time, id: cursor.id }, limit: req.query.limit });
  const { items, next } = page(rows, req.query.limit, (a) => a.occurredAt);
  res.json({ activities: items, next });
}

/** Admin: a person links two things (confirmed immediately). */
export async function createRecordLink(req, res) {
  const { from, to, linkType } = req.body;
  const result = await withTransaction(async (conn) => {
    const r = await createLink(conn, { from, to, linkType, origin: 'manual', createdBy: req.user.id });
    if (r.inserted) {
      await recordAudit(conn, { actorUserId: req.user.id, action: 'record_link.created', entityType: 'record_link', entityId: r.id, after: { from, to, linkType }, ip: req.ip });
    }
    return r;
  });
  res.status(result.inserted ? 201 : 200).json({ link: await links.findById(result.id) });
}

/** Admin: confirm or reject a suggested (or any) link. */
export async function reviewRecordLink(req, res) {
  const link = await links.findById(req.params.id);
  if (!link) throw notFound('Link not found');
  await links.setReview(pool, link.id, { status: req.body.status, reviewedBy: req.user.id });
  await audit({ actorUserId: req.user.id, action: `record_link.${req.body.status}`, entityType: 'record_link', entityId: link.id, before: { status: link.status }, ip: req.ip });
  res.json({ link: await links.findById(link.id) });
}
