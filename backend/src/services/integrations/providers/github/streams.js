// GitHub sync streams (Phase 3B). Each syncStream() call does one bounded chunk (one list page,
// or up to REVIEWS_PER_CHUNK pull-request review lookups) and returns the cursor to continue from.
// The framework commits envelopes and cursor together, so a worker restart resumes exactly here.
//
// Cursor (owned by this connector): { pass, page, runSince, watermark, nextWatermark, ... }
//   pass 'open'    backfill only: everything still open, however old
//   pass 'recent'  changes since the backfill window (backfill) or since the last run (incremental)
// A run keeps its `runSince` for all its pages, so page numbers stay consistent; the watermark
// only advances when a run completes (pulls are listed newest first).
//
// Only metadata endpoints are used: no repository contents, diffs or files are downloaded.
import { ProviderError } from '../../errors.js';
import { commentEnvelopes, commitEnvelopes, issueEnvelopes, pullEnvelopes, repositoryEnvelopes, restCommit, reviewCommentEnvelopes, reviewEnvelopes } from './mappers.js';

export const STREAMS = ['repository', 'issues', 'pulls', 'issue_comments', 'review_comments', 'commits'];
const PER_PAGE = 100;
const REVIEWS_PER_CHUNK = 5;
const OVERLAP_MS = 2 * 60 * 1000;

const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);
const repoPath = (resource) => `/repos/${resource.name.split('/').map(encodeURIComponent).join('/')}`;
const repoOf = (resource) => ({ id: resource.externalId, full_name: resource.name });

/** Where an incremental run starts: last completed watermark minus overlap, else the engine's since. */
function runStart(cursor, since) {
  if (cursor?.watermark) return new Date(Date.parse(cursor.watermark) - OVERLAP_MS).toISOString();
  return since ? new Date(since).toISOString() : undefined;
}

function finish(cursor, extra = {}) {
  return {
    cursor: { pass: 'recent', page: 1, runSince: null, watermark: maxIso(cursor?.watermark, cursor?.nextWatermark) ?? null, nextWatermark: null, ...extra },
    phase: 'incremental',
    done: true,
  };
}

/** Ascending, `since`-filtered lists (issues, issue comments, review comments). */
async function ascendingStream({ api, resource, cursor, phase, since, path, query, openPass, toEnvelopes }) {
  let c = cursor ?? { pass: openPass && phase === 'backfill' ? 'open' : 'recent', page: 1 };
  if (c.pass === 'recent' && c.page === 1 && !c.runSince) c = { ...c, runSince: runStart(c, since) ?? null };

  const params = c.pass === 'open' ? { ...query, state: 'open', per_page: PER_PAGE, page: c.page } : { ...query, state: query.state ? 'all' : undefined, since: c.runSince ?? undefined, sort: 'updated', direction: 'asc', per_page: PER_PAGE, page: c.page };
  const res = await api.get(`${repoPath(resource)}${path}`, { query: params });
  const items = Array.isArray(res.body) ? res.body : [];
  const envelopes = items.flatMap(toEnvelopes);
  const nextWatermark = items.reduce((w, i) => maxIso(w, i.updated_at), c.nextWatermark ?? null);

  if (res.links.next) return { envelopes, cursor: { ...c, page: c.page + 1, nextWatermark }, phase, done: false };
  if (c.pass === 'open') return { envelopes, cursor: { pass: 'recent', page: 1, runSince: runStart(null, since) ?? null, watermark: null, nextWatermark }, phase, done: false };
  return { envelopes, ...finish({ ...c, nextWatermark }) };
}

/**
 * Pull requests: the list endpoint has no `since`, so pages are read newest-updated first until
 * an item older than the run's start. Every PR seen is queued for its reviews.
 */
async function pullsStream({ api, resource, cursor, phase, since, source }) {
  const repo = repoOf(resource);
  let c = cursor ?? { pass: phase === 'backfill' ? 'open' : 'recent', page: 1, pending: [] };
  c = { pending: [], ...c };

  if (c.pending.length) {
    const batch = c.pending.slice(0, REVIEWS_PER_CHUNK);
    const envelopes = [];
    for (const number of batch) {
      try {
        const res = await api.get(`${repoPath(resource)}/pulls/${number}/reviews`, { query: { per_page: PER_PAGE } });
        for (const review of res.body ?? []) envelopes.push(...reviewEnvelopes(source, repo, number, review));
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err; // a deleted PR: skip it
      }
    }
    const pending = c.pending.slice(batch.length);
    if (!pending.length && c.listed) return { envelopes, ...finish(c) };
    return { envelopes, cursor: { ...c, pending }, phase, done: false };
  }

  if (c.pass === 'recent' && c.page === 1 && !c.runSince) c = { ...c, runSince: runStart(c, since) ?? null };
  const query = c.pass === 'open' ? { state: 'open', per_page: PER_PAGE, page: c.page } : { state: 'all', sort: 'updated', direction: 'desc', per_page: PER_PAGE, page: c.page };
  const res = await api.get(`${repoPath(resource)}/pulls`, { query });
  let items = Array.isArray(res.body) ? res.body : [];
  let reachedOld = false;
  if (c.pass === 'recent' && c.runSince) {
    const fresh = items.filter((p) => p.updated_at >= c.runSince);
    reachedOld = fresh.length < items.length;
    items = fresh;
  }
  const envelopes = items.flatMap((pr) => pullEnvelopes(source, repo, pr));
  const pending = [...new Set([...c.pending, ...items.map((p) => p.number)])];
  const nextWatermark = items.reduce((w, p) => maxIso(w, p.updated_at), c.nextWatermark ?? null);

  if (res.links.next && !reachedOld) return { envelopes, cursor: { ...c, page: c.page + 1, pending, nextWatermark }, phase, done: false };
  if (c.pass === 'open') {
    return { envelopes, cursor: { ...c, pass: 'recent', page: 1, runSince: runStart(null, since) ?? null, pending, nextWatermark }, phase, done: false };
  }
  if (pending.length) return { envelopes, cursor: { ...c, pending, nextWatermark, listed: true }, phase, done: false };
  return { envelopes, ...finish({ ...c, nextWatermark }) };
}

/** Default-branch commits (newest first), since the last run. Branch commits arrive by webhook. */
async function commitsStream({ api, resource, cursor, phase, since, source }) {
  const repo = repoOf(resource);
  const branch = resource.metadata?.defaultBranch ?? undefined;
  let c = cursor ?? { pass: 'recent', page: 1 };
  if (c.page === 1 && !c.runSince) c = { ...c, runSince: runStart(c, since) ?? null };
  let res;
  try {
    res = await api.get(`${repoPath(resource)}/commits`, { query: { sha: branch, since: c.runSince ?? undefined, per_page: PER_PAGE, page: c.page } });
  } catch (err) {
    // 409 = empty repository: nothing to sync yet.
    if (err instanceof ProviderError && err.status === 409) return { envelopes: [], ...finish(c) };
    throw err;
  }
  const items = Array.isArray(res.body) ? res.body : [];
  const envelopes = items.flatMap((item) => commitEnvelopes(source, repo, restCommit(item, branch)));
  const nextWatermark = items.reduce((w, i) => maxIso(w, i.commit?.committer?.date), c.nextWatermark ?? null);
  if (res.links.next) return { envelopes, cursor: { ...c, page: c.page + 1, nextWatermark }, phase, done: false };
  return { envelopes, ...finish({ ...c, nextWatermark }) };
}

export async function syncStream({ api, source }, { resource, stream, cursor, phase, since }) {
  const repo = repoOf(resource);
  const common = { api, resource, cursor, phase, since, source };
  switch (stream) {
    case 'repository': {
      const res = await api.get(repoPath(resource));
      return { envelopes: repositoryEnvelopes(source, res.body), cursor: null, phase: 'incremental', done: true };
    }
    case 'issues':
      return ascendingStream({
        ...common,
        path: '/issues',
        query: { state: 'all' },
        openPass: true,
        // The issues API also lists pull requests; those come from the pulls stream.
        toEnvelopes: (issue) => (issue.pull_request ? [] : issueEnvelopes(source, repo, issue)),
      });
    case 'pulls':
      return pullsStream(common);
    case 'issue_comments':
      return ascendingStream({ ...common, path: '/issues/comments', query: {}, openPass: false, toEnvelopes: (c) => commentEnvelopes(source, repo, c) });
    case 'review_comments':
      return ascendingStream({ ...common, path: '/pulls/comments', query: {}, openPass: false, toEnvelopes: (c) => reviewCommentEnvelopes(source, repo, c) });
    case 'commits':
      return commitsStream(common);
    default:
      throw new ProviderError('invalid_request', `Unknown GitHub stream ${stream}`);
  }
}
