// record_links rules (docs/PHASE_3A_PLAN.md §4.2). Endpoints are polymorphic, so this module is the
// integrity check: both ends must exist, symmetric links are stored once in canonical order, and
// a source/manual link is confirmed while rule/AI links start as suggestions.
import * as links from '../../repositories/recordLinksRepository.js';
import { badRequest } from '../../utils/errors.js';

export const ENDPOINT_TYPES = { external_record: 'external_records', meeting: 'meetings', action_item: 'action_items', user: 'users' };
export const SYMMETRIC = new Set(['same_as', 'duplicates', 'related']);
const ORDER = Object.keys(ENDPOINT_TYPES);

const compare = (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || a.id - b.id;

/** Swaps from/to for symmetric types so each pair has exactly one row. */
export function canonicalize({ from, to, linkType, ...rest }) {
  if (SYMMETRIC.has(linkType) && compare(from, to) > 0) return { from: to, to: from, linkType, ...rest };
  return { from, to, linkType, ...rest };
}

export async function endpointExists(conn, { type, id }) {
  const table = ENDPOINT_TYPES[type];
  if (!table) return false;
  const [rows] = await conn.query(`SELECT 1 FROM ${table} WHERE id = ?`, [id]);
  return rows.length > 0;
}

/**
 * Validates and stores a link. origin: 'source' | 'rule' | 'ai' | 'manual'.
 * Returns { id, inserted }.
 */
export async function createLink(conn, { from, to, linkType, origin, confidence = null, evidence = null, createdBy = null }) {
  if (from.type === to.type && from.id === to.id) throw badRequest('A record cannot be linked to itself');
  for (const end of [from, to]) {
    if (!(await endpointExists(conn, end))) throw badRequest('Invalid link', [{ field: end === from ? 'from' : 'to', message: `${end.type} ${end.id} not found` }]);
  }
  const confirmed = origin === 'source' || origin === 'manual';
  return links.insertIfNew(
    conn,
    canonicalize({
      from,
      to,
      linkType,
      origin,
      status: confirmed ? 'confirmed' : 'suggested',
      confidence: confirmed ? 1 : confidence,
      evidence,
      createdBy,
    }),
  );
}
