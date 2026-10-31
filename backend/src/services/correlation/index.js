// Correlation boundary (prepared in Phase 4, used by Phase 5). Phase 5's matchers (record
// matching, relationship suggestions, activity correlation, entity resolution) plug in here and
// only ever SUGGEST: nothing inferred is confirmed without a person (services/records/relationships).
//
// Contract for a matcher (Phase 5):
//   { id: 'issue-key-in-text', run: async (conn, record) => [{ to: { type, id }, linkType, confidence, evidence }] }
// registered with registerMatcher(); runMatchers(conn, record) calls every matcher and stores the
// results with suggestLink(). Phase 4 registers no matchers.
import { pool } from '../../db/pool.js';
import * as identities from '../../repositories/externalIdentitiesRepository.js';
import * as links from '../../repositories/recordLinksRepository.js';
import { createLink } from '../integrations/links.js';

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
