// Ingest (docs/PHASE_3A_PLAN.md §7–§8): writes a connector's normalized envelopes. Every write the
// sync engine and the webhook processor make goes through here, inside the caller's transaction
// (so a sync chunk and its cursor commit together).
//
// - Idempotent: records upsert by source identity; unchanged content (same hash) writes nothing;
//   activities insert once per dedupe key; identities and links upsert.
// - Stale-safe: an update older than the stored source_updated_at is skipped (webhooks and sync
//   arrive in no particular order).
// - Project: new records take the resource's project; records not set by hand follow the
//   resource; activities carry their record's project.
// - Identity matching is automatic only for an exact, provider-verified email, and never
//   overrides a match made by a person.
import { createHash } from 'node:crypto';
import * as activities from '../../repositories/activitiesRepository.js';
import * as identities from '../../repositories/externalIdentitiesRepository.js';
import * as records from '../../repositories/externalRecordsRepository.js';
import { parseEnvelopes } from './envelopes.js';
import { createLink } from './links.js';

const emptyStats = () => ({
  identities: { inserted: 0, updated: 0, matched: 0 },
  records: { inserted: 0, updated: 0, unchanged: 0, stale: 0 },
  activities: { inserted: 0, duplicate: 0, skipped: 0 },
  links: { inserted: 0, duplicate: 0, skipped: 0 },
});

/** Hash of everything that describes the record's content (not when we saw it). */
export function contentHash(r) {
  const normalized = {
    externalKey: r.externalKey,
    url: r.url,
    title: r.title,
    body: r.body,
    state: r.state,
    statusCategory: r.statusCategory,
    authorIdentityId: r.authorIdentityId,
    parentRecordId: r.parentRecordId,
    metadata: r.metadata,
    sourceCreatedAt: r.sourceCreatedAt?.toISOString?.() ?? null,
    sourceUpdatedAt: r.sourceUpdatedAt?.toISOString?.() ?? null,
    deleted: Boolean(r.sourceDeletedAt),
  };
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

// Automatic matching uses only a verified email from the provider's account data (connectors must
// never pass commit/author emails, which anyone can set). Logins and display names are not
// matched: an admin maps those people by hand (Phase 3B: name-only matching is unsafe).
async function autoMatch(conn, identityId, { email }) {
  if (!email) return false;
  const [rows] = await conn.query('SELECT id FROM users WHERE email = ? AND is_active = TRUE', [email.toLowerCase()]);
  if (rows.length === 1) return identities.setAutoMatch(conn, identityId, { userId: rows[0].id, method: 'email' });
  return false;
}

/**
 * @param conn a connection inside a transaction
 * @param {{ connector: { id, sourceInstance }, connection: { id }, resource?: { id, projectId },
 *           envelopes: unknown[], origin: 'sync'|'webhook', webhookDeliveryId?: number }} input
 * @returns per-type counts
 */
export async function ingest(conn, { connector, connection, resource = null, envelopes: raw, origin, webhookDeliveryId = null }) {
  const parsed = parseEnvelopes(raw);
  const stats = emptyStats();
  const source = { provider: connector.id, sourceInstance: connector.sourceInstance };
  const identityIds = new Map(); // externalUserId -> id
  const recordCache = new Map(); // recordType:externalId -> record

  async function identityId(ref) {
    if (!ref) return null;
    if (identityIds.has(ref.externalUserId)) return identityIds.get(ref.externalUserId);
    // Referenced but not described: store a bare identity so the reference isn't lost.
    const { id } = await identities.upsert(conn, { ...source, externalUserId: ref.externalUserId });
    identityIds.set(ref.externalUserId, id);
    return id;
  }

  async function recordFor(ref) {
    const key = `${ref.recordType}:${ref.externalId}`;
    if (recordCache.has(key)) return recordCache.get(key);
    const found = await records.findBySource(conn, { ...source, recordType: ref.recordType, externalId: ref.externalId });
    if (found) recordCache.set(key, found);
    return found;
  }

  // 1. Identities (everything else may refer to them).
  for (const e of parsed.filter((x) => x.type === 'identity')) {
    const { id, inserted } = await identities.upsert(conn, { ...source, ...e });
    identityIds.set(e.externalUserId, id);
    stats.identities[inserted ? 'inserted' : 'updated']++;
    if (await autoMatch(conn, id, e)) stats.identities.matched++;
  }

  // 2. Records, in the order given (connectors list parents before children).
  for (const e of parsed.filter((x) => x.type === 'record')) {
    const key = { ...source, recordType: e.recordType, externalId: e.externalId };
    const existing = await records.findBySource(conn, key, { forUpdate: true });
    if (existing?.sourceUpdatedAt && e.sourceUpdatedAt && e.sourceUpdatedAt < existing.sourceUpdatedAt) {
      stats.records.stale++;
      recordCache.set(`${e.recordType}:${e.externalId}`, existing);
      continue;
    }
    const parent = e.parentRef ? await recordFor(e.parentRef) : null;
    const projectId = existing?.projectLocked ? existing.projectId : resource ? resource.projectId : existing?.projectId ?? null;
    const next = {
      ...key,
      externalKey: e.externalKey,
      connectionId: connection.id,
      resourceId: resource?.id ?? existing?.resourceId ?? null,
      parentRecordId: parent?.id ?? null,
      url: e.url ?? null,
      title: e.title,
      body: e.body.text,
      state: e.state,
      statusCategory: e.statusCategory,
      authorIdentityId: await identityId(e.authorRef),
      projectId,
      metadata: e.body.truncated ? { ...(e.metadata ?? {}), truncated: true } : e.metadata ?? null,
      sourceCreatedAt: e.sourceCreatedAt ?? existing?.sourceCreatedAt ?? null,
      sourceUpdatedAt: e.sourceUpdatedAt ?? null,
      sourceDeletedAt: e.deleted ? existing?.sourceDeletedAt ?? e.sourceUpdatedAt ?? new Date() : null,
    };
    next.contentHash = contentHash(next);

    let id;
    if (!existing) {
      // A concurrent insert of the same record raises ER_DUP_ENTRY (or a deadlock); the caller's
      // transaction rolls back and the job is retried, which then takes the update path.
      id = await records.insert(conn, next);
      stats.records.inserted++;
    } else if (existing.contentHash === next.contentHash && existing.connectionId === next.connectionId && existing.resourceId === next.resourceId && existing.projectId === next.projectId) {
      id = existing.id;
      stats.records.unchanged++;
    } else {
      id = existing.id;
      await records.updateContent(conn, id, next);
      if (existing.projectId !== next.projectId) await activities.syncProjectForRecord(conn, id, next.projectId);
      stats.records.updated++;
    }
    recordCache.set(`${e.recordType}:${e.externalId}`, { ...next, id, projectLocked: existing?.projectLocked ?? false });
  }

  // 3. Activities: once per dedupe key, attached to a known record.
  for (const e of parsed.filter((x) => x.type === 'activity')) {
    const record = await recordFor(e.recordRef);
    if (!record) {
      stats.activities.skipped++;
      continue;
    }
    const inserted = await activities.insertIfNew(conn, {
      dedupeKey: e.dedupeKey,
      provider: connector.id,
      activityType: e.activityType,
      externalRecordId: record.id,
      actorIdentityId: await identityId(e.actorRef),
      projectId: record.projectId,
      occurredAt: e.occurredAt,
      summary: e.summary,
      details: e.details ?? null,
      origin,
      webhookDeliveryId,
    });
    stats.activities[inserted ? 'inserted' : 'duplicate']++;
  }

  // 4. Links stated by the provider (both ends must be known records).
  for (const e of parsed.filter((x) => x.type === 'link')) {
    const [from, to] = [await recordFor(e.fromRef), await recordFor(e.toRef)];
    if (!from || !to || from.id === to.id) {
      stats.links.skipped++;
      continue;
    }
    const { inserted } = await createLink(conn, { from: { type: 'external_record', id: from.id }, to: { type: 'external_record', id: to.id }, linkType: e.linkType, origin: 'source' });
    stats.links[inserted ? 'inserted' : 'duplicate']++;
  }

  return stats;
}
