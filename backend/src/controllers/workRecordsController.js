// Synced work, the unified activity feed, relationships and search (Phase 3A read APIs, extended
// in Phase 4).
//
// Visibility follows projects (services/records/access.js): a record or activity is visible to
// whoever can see its project; task activities follow task visibility; records with no project are
// admin-only. Invisible things are 404, the same as for projects themselves.
import { withTransaction } from '../db/transaction.js';
import * as records from '../repositories/externalRecordsRepository.js';
import * as projects from '../repositories/projectsRepository.js';
import { recordAudit } from '../services/audit.js';
import { listFeed } from '../services/activities/feed.js';
import { ACTIVITY_TYPES } from '../services/activities/types.js';
import { accessScope, canSeeProject } from '../services/records/access.js';
import { resolveRefs } from '../services/records/refs.js';
import { createManualLink, pendingSuggestions, relationshipsOf, reviewLink } from '../services/records/relationships.js';
import { search as runSearch } from '../services/search.js';
import { isAdmin } from '../services/permissions.js';
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

/** The project filter a request may use: a visible project id, null (unassigned, admins), or all visible. */
async function scopeFor(req, scope) {
  const { projectId, unassigned } = req.query;
  if (projectId) {
    if (!(await projects.findById(projectId)) || !canSeeProject(scope, projectId)) throw notFound('Project not found');
    return projectId;
  }
  if (unassigned && !scope.admin) throw badRequest('Only admins can list records without a project', [{ field: 'unassigned', message: 'Choose a project' }]);
  return unassigned ? null : undefined;
}

function page(rows, limit, keyOf) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, next: more && last ? encodeCursor(keyOf(last), last.id) : null };
}

export async function listRecords(req, res) {
  const scope = await accessScope(req.user);
  const projectId = await scopeFor(req, scope);
  const cursor = decodeCursor(req.query.before);
  const rows = await records.listForRead({
    projectId,
    // Without a project: every project the person can see (admins: everything).
    visibleProjectIds: projectId === undefined && !scope.admin ? scope.visible : undefined,
    recordType: req.query.recordType,
    statusCategory: req.query.statusCategory,
    provider: req.query.provider,
    includeDeleted: req.query.includeDeleted,
    q: req.query.q,
    before: cursor && { sortAt: cursor.time, id: cursor.id },
    limit: req.query.limit,
  });
  const { items, next } = page(rows, req.query.limit, (r) => r.sortAt);
  res.json({ records: items, next });
}

export async function getRecord(req, res) {
  const scope = await accessScope(req.user);
  const record = await records.findForRead(req.params.id);
  if (!record || !canSeeProject(scope, record.projectId)) throw notFound('Record not found');
  const refs = [{ type: 'external_record', id: record.id }, ...(record.parentRecordId ? [{ type: 'external_record', id: record.parentRecordId }] : []), ...(record.projectId ? [{ type: 'project', id: record.projectId }] : [])];
  const summaries = await resolveRefs(refs);
  const self = summaries.get(`external_record:${record.id}`);
  const parent = record.parentRecordId ? summaries.get(`external_record:${record.parentRecordId}`) : null;
  const children = await records.listChildren(record.id);
  const [timeline, links] = await Promise.all([
    listFeed(scope, { recordId: record.id, limit: 100 }),
    relationshipsOf(scope, { type: 'external_record', id: record.id }),
  ]);
  res.json({
    record: { ...record, sourceStatus: self?.sourceStatus ?? 'current', project: record.projectId ? { id: record.projectId, name: summaries.get(`project:${record.projectId}`)?.title } : null },
    parent: parent && canSeeProject(scope, parent.projectId) ? parent : null,
    children,
    activities: timeline.slice(0, 100),
    links,
    canManageRelationships: isAdmin(req.user) || req.user.role === 'manager',
  });
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

/** The unified activity feed across WorkAgent and connected applications. */
export async function listActivities(req, res) {
  const scope = await accessScope(req.user);
  const projectId = await scopeFor(req, scope);
  const cursor = decodeCursor(req.query.before);
  const q = req.query;
  const rows = await listFeed(scope, {
    projectId: projectId ?? undefined,
    unassigned: projectId === null,
    userId: q.userId,
    provider: q.provider,
    activityTypes: q.activityType,
    from: q.from,
    to: q.to,
    recordId: q.recordId,
    entityType: q.entityType,
    entityId: q.entityId,
    subjectType: q.subjectType,
    status: q.status,
    before: cursor && { occurredAt: cursor.time, id: cursor.id },
    limit: q.limit,
  });
  const { items, next } = page(rows, q.limit, (a) => a.occurredAt);
  res.json({ activities: items, next });
}

/** The vocabulary, for filters. */
export function listActivityTypes(req, res) {
  res.json({ activityTypes: Object.entries(ACTIVITY_TYPES).map(([id, label]) => ({ id, label })) });
}

/** Relationships of any record (external record, meeting, task, user) the person can see. */
export async function listRecordLinks(req, res) {
  const scope = await accessScope(req.user);
  if (req.query.status === 'suggested' && !req.query.type) {
    res.json({ suggestions: await pendingSuggestions(scope) });
    return;
  }
  if (!req.query.type) throw badRequest('Choose a record', [{ field: 'type', message: 'type and id are required' }]);
  res.json({ links: await relationshipsOf(scope, { type: req.query.type, id: req.query.id }) });
}

/** A person links two records (admins; managers within projects they manage). Confirmed at once. */
export async function createRecordLink(req, res) {
  const scope = await accessScope(req.user);
  const { link, created } = await createManualLink(scope, req.body, { ip: req.ip });
  res.status(created ? 201 : 200).json({ link });
}

/** Confirm or reject a relationship (rejecting is how a relationship is removed; history stays). */
export async function reviewRecordLink(req, res) {
  const scope = await accessScope(req.user);
  res.json({ link: await reviewLink(scope, req.params.id, req.body.status, { ip: req.ip }) });
}

/** Unified search across projects, meetings, tasks and external records. */
export async function search(req, res) {
  const scope = await accessScope(req.user);
  const { q, types, projectId, recordType, provider, includeDeleted, limit } = req.query;
  if (projectId && (!(await projects.findById(projectId)) || !canSeeProject(scope, projectId))) throw notFound('Project not found');
  res.json(await runSearch(scope, q, { types, projectId, recordType, provider, includeDeleted, limit }));
}

