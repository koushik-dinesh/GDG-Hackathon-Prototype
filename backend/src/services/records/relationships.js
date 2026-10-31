// Relationship management (Phase 4) on top of record_links (Phase 3A). Nothing is deleted:
// removing a relationship rejects it, so its provenance stays (and an inferred suggestion that
// was rejected is never suggested again, see services/correlation).
//
//   origin   source (stated by the provider) | rule | ai (inferred, Phase 5/6) | manual (a person)
//   status   confirmed | suggested (inferred, awaiting review) | rejected
import { withTransaction } from '../../db/transaction.js';
import * as links from '../../repositories/recordLinksRepository.js';
import { badRequest, forbidden, notFound } from '../../utils/errors.js';
import { recordAudit } from '../audit.js';
import { createLink } from '../integrations/links.js';
import { canEditLinkBetween, canSeeSummary } from './access.js';
import { hrefFor, refKey, resolveRefs } from './refs.js';

const withHref = (s, scope) => (s ? { ...s, href: hrefFor(s, scope) } : s);

function view(link, ref, summaries, scope) {
  const outgoing = link.from.type === ref.type && link.from.id === ref.id;
  const otherRef = outgoing ? link.to : link.from;
  const other = summaries.get(refKey(otherRef));
  return {
    id: link.id,
    linkType: link.linkType,
    direction: outgoing ? 'outgoing' : 'incoming',
    origin: link.origin,
    status: link.status,
    confidence: link.confidence,
    evidence: link.evidence,
    createdBy: link.createdBy,
    reviewedBy: link.reviewedBy,
    reviewedAt: link.reviewedAt,
    createdAt: link.createdAt,
    other: withHref(other, scope),
    canEdit: canEditLinkBetween(scope, [summaries.get(refKey(ref)), other]),
  };
}

/**
 * Relationships of one record that the scope may see. Throws 404 if the record itself isn't
 * visible. Others see confirmed links to things they can see; people who may edit the
 * relationship also see suggestions and rejected ones (to review or restore them).
 */
export async function relationshipsOf(scope, ref) {
  const self = (await resolveRefs([ref])).get(refKey(ref));
  if (!self || !canSeeSummary(scope, self)) throw notFound('Record not found');
  const all = await links.listFor(ref);
  const summaries = await resolveRefs([ref, ...all.flatMap((l) => [l.from, l.to])]);
  return all
    .map((l) => view(l, ref, summaries, scope))
    .filter((v) => v.other && canSeeSummary(scope, v.other) && (v.status === 'confirmed' || v.canEdit));
}

async function editable(scope, refs) {
  const summaries = await resolveRefs(refs);
  const ends = refs.map((r) => summaries.get(refKey(r)));
  ends.forEach((s, i) => {
    if (!s) throw badRequest('Invalid link', [{ field: i ? 'to' : 'from', message: `${refs[i].type} ${refs[i].id} not found` }]);
  });
  if (!ends.every((s) => canSeeSummary(scope, s))) throw notFound('Record not found');
  if (!canEditLinkBetween(scope, ends)) throw forbidden('Only admins, or managers of the projects involved, can change relationships');
  return summaries;
}

/** A person links two records: confirmed at once (re-confirms a rejected or suggested one). */
export async function createManualLink(scope, { from, to, linkType }, { ip } = {}) {
  await editable(scope, [from, to]);
  return withTransaction(async (conn) => {
    const { id, inserted } = await createLink(conn, { from, to, linkType, origin: 'manual', createdBy: scope.user.id });
    const link = await links.findById(id, conn);
    if (!inserted && link.status !== 'confirmed') await links.setReview(conn, id, { status: 'confirmed', reviewedBy: scope.user.id });
    if (inserted || link.status !== 'confirmed') {
      await recordAudit(conn, { actorUserId: scope.user.id, action: 'record_link.created', entityType: 'record_link', entityId: id, after: { from, to, linkType, previousStatus: inserted ? null : link.status }, ip });
    }
    return { link: await links.findById(id, conn), created: inserted };
  });
}

/** Confirm or reject a relationship (suggestions are reviewed this way; rejecting = removing). */
export async function reviewLink(scope, id, status, { ip } = {}) {
  const link = await links.findById(id);
  if (!link) throw notFound('Link not found');
  await editable(scope, [link.from, link.to]);
  return withTransaction(async (conn) => {
    await links.setReview(conn, id, { status, reviewedBy: scope.user.id });
    await recordAudit(conn, { actorUserId: scope.user.id, action: `record_link.${status}`, entityType: 'record_link', entityId: id, before: { status: link.status }, after: { status }, ip });
    return links.findById(id, conn);
  });
}

/** Suggestions waiting for review that this scope may decide, newest first. */
export async function pendingSuggestions(scope, { limit = 50 } = {}) {
  const pending = await links.listByStatus('suggested', { limit: 500 });
  const summaries = await resolveRefs(pending.flatMap((l) => [l.from, l.to]));
  return pending
    .map((l) => ({ ...l, from: withHref(summaries.get(refKey(l.from)), scope), to: withHref(summaries.get(refKey(l.to)), scope) }))
    .filter((l) => l.from && l.to && canSeeSummary(scope, l.from) && canSeeSummary(scope, l.to) && canEditLinkBetween(scope, [l.from, l.to]))
    .slice(0, limit);
}
