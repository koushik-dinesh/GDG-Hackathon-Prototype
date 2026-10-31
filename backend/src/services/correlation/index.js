// Correlation engine (boundary prepared in Phase 4, engine in Phase 5). Matchers (record matching,
// relationship suggestions, activity correlation, entity resolution) only ever SUGGEST: nothing
// inferred is confirmed without a person (services/records/relationships).
//
// Contract for a matcher:
//   { id, appliesTo: ['external_record'|'action_item'|'meeting', ...],
//     run: async (conn, subject) => [{ from?, to: { type, id }, linkType, confidence, evidence }] }
// `subject` comes from loadSubject() (title, body, project, people, dates). Built-in matchers live
// in matchers.js; registerMatcher() adds more (e.g. Phase 6 AI). evaluate(conn, ref) runs them all
// for one record, task or meeting (job correlation.evaluate, queued when records arrive or change).
import { pool } from '../../db/pool.js';
import * as identities from '../../repositories/externalIdentitiesRepository.js';
import * as links from '../../repositories/recordLinksRepository.js';
import { createLink } from '../integrations/links.js';
import { BUILT_IN_MATCHERS } from './matchers.js';

const matchers = [];

export function registerMatcher(matcher) {
  if (!matcher?.id || typeof matcher.run !== 'function') throw new Error('A matcher needs an id and run()');
  if (matchers.some((m) => m.id === matcher.id)) throw new Error(`Duplicate matcher ${matcher.id}`);
  matchers.push(matcher);
}

export const listMatchers = () => matchers.map((m) => m.id);

/**
 * Stores an inferred relationship as a suggestion ('rule' or 'ai', with confidence and evidence).
 * Never resurrects one a person rejected, and never downgrades a confirmed one.
 * Returns { id, created } or null when skipped.
 */
export async function suggestLink(conn, { from, to, linkType, confidence, evidence, method = 'rule' }) {
  if (!['rule', 'ai'].includes(method)) throw new Error('Suggestions come from rules or AI; use createManualLink for people');
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('confidence must be between 0 and 1');
  const existing = await links.findBetween(conn, { from, to, linkType });
  if (existing) return null; // confirmed, already suggested, or rejected by a person: leave it
  const { id, inserted } = await createLink(conn, { from, to, linkType, origin: method, confidence, evidence: evidence ?? null });
  return inserted ? { id, created: true } : null;
}

/** Runs every registered matcher for one record (Phase 5). Returns the number of new suggestions. */
export async function runMatchers(conn, record) {
  let created = 0;
  for (const m of matchers) {
    for (const s of await m.run(conn, record)) {
      if (await suggestLink(conn, { from: { type: 'external_record', id: record.id }, ...s, method: s.method ?? 'rule', evidence: { matcher: m.id, ...(s.evidence ?? {}) } })) created++;
    }
  }
  return created;
}

/** Entity resolution helper: the WorkAgent user behind a provider account, or null. */
export async function resolveUser({ provider, sourceInstance, externalUserId }, conn = pool) {
  const identity = await identities.findBySource(conn, { provider, sourceInstance, externalUserId: String(externalUserId) });
  return identity?.userId ?? null;
}

/** Record matching helper: external records whose human key matches exactly (e.g. "acme/api#12", "PAY-42"). */
export async function findRecordsByKey(externalKey, { provider } = {}, conn = pool) {
  const [rows] = await conn.query(
    `SELECT id, provider, record_type, external_key, title, project_id FROM external_records
     WHERE external_key = ? ${provider ? 'AND provider = ?' : ''} AND source_deleted_at IS NULL`,
    provider ? [externalKey, provider] : [externalKey],
  );
  return rows.map((r) => ({ id: r.id, provider: r.provider, recordType: r.record_type, key: r.external_key, title: r.title, projectId: r.project_id }));
}

/** Project context for correlation: the project, its members and the resources mapped to it. */
export async function projectContext(projectId, conn = pool) {
  const [[project]] = await conn.query('SELECT id, name, status, owner_user_id FROM projects WHERE id = ?', [projectId]);
  if (!project) return null;
  const [members] = await conn.query('SELECT user_id FROM project_members WHERE project_id = ?', [projectId]);
  const [resources] = await conn.query("SELECT id, connection_id, resource_type, external_id, name FROM integration_resources WHERE project_id = ? AND is_enabled = TRUE AND access_status = 'accessible'", [projectId]);
  return {
    project: { id: project.id, name: project.name, status: project.status, ownerUserId: project.owner_user_id },
    memberUserIds: [...new Set([project.owner_user_id, ...members.map((m) => m.user_id)])],
    resources: resources.map((r) => ({ id: r.id, connectionId: r.connection_id, resourceType: r.resource_type, externalId: r.external_id, name: r.name })),
  };
}

/**
 * Everything matchers need about one record, task or meeting, or null when it doesn't exist.
 * { type, id, recordType, title, body, key, projectId, deleted, createdAt, authorIdentityId,
 *   assigneeUserId, reviewStatus, scheduledAt, updatedAt }
 */
export async function loadSubject(conn, { type, id }) {
  if (type === 'external_record') {
    const [[r]] = await conn.query(
      'SELECT id, record_type, title, body, external_key, project_id, source_deleted_at, source_created_at, source_updated_at, author_identity_id FROM external_records WHERE id = ?',
      [id],
    );
    return r && { type, id: r.id, recordType: r.record_type, title: r.title, body: r.body, key: r.external_key, projectId: r.project_id, deleted: Boolean(r.source_deleted_at), createdAt: r.source_created_at, updatedAt: r.source_updated_at, authorIdentityId: r.author_identity_id };
  }
  if (type === 'action_item') {
    const [[t]] = await conn.query('SELECT id, title, description, project_id, review_status, assignee_user_id, created_at FROM action_items WHERE id = ?', [id]);
    return t && { type, id: t.id, recordType: 'task', title: t.title, body: t.description, key: null, projectId: t.project_id, deleted: false, createdAt: t.created_at, reviewStatus: t.review_status, assigneeUserId: t.assignee_user_id };
  }
  if (type === 'meeting') {
    const [[m]] = await conn.query('SELECT id, title, project_id, scheduled_at, updated_at FROM meetings WHERE id = ?', [id]);
    return m && { type, id: m.id, recordType: 'meeting', title: m.title, body: null, key: null, projectId: m.project_id, deleted: false, scheduledAt: m.scheduled_at, updatedAt: m.updated_at };
  }
  return null;
}

/**
 * Runs every matcher that applies to this subject and stores new suggestions. Pairs that already
 * have any relationship (confirmed, suggested or rejected by a person) are left alone. A record
 * deleted at the source gets no new suggestions and its pending ones are withdrawn (kept as
 * rejected, for history). Returns { suggested, withdrawn }.
 */
export async function evaluate(conn, ref) {
  const subject = await loadSubject(conn, ref);
  if (!subject) return { suggested: 0, withdrawn: 0 };
  if (subject.deleted) return { suggested: 0, withdrawn: await links.withdrawSuggestions(conn, ref) };
  let suggested = 0;
  for (const m of [...BUILT_IN_MATCHERS, ...matchers]) {
    if (m.appliesTo && !m.appliesTo.includes(subject.type)) continue;
    for (const p of await m.run(conn, subject)) {
      const from = p.from ?? { type: subject.type, id: subject.id };
      if (from.type === p.to.type && from.id === p.to.id) continue;
      if (await links.anyBetween(conn, from, p.to)) continue;
      const stored = await suggestLink(conn, { from, to: p.to, linkType: p.linkType, confidence: p.confidence, method: p.method ?? 'rule', evidence: { matcher: m.id, ...(p.evidence ?? {}) } });
      if (stored) suggested++;
    }
  }
  return { suggested, withdrawn: 0 };
}
