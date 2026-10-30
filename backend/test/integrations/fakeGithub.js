// A small fake GitHub REST API for tests (Phase 3B). Real HTTP on 127.0.0.1, so the connector's
// client, pagination (Link headers), auth headers and error handling are exercised for real.
//
// - /app/* endpoints require a valid RS256 App JWT (verified with the test public key).
// - Installation endpoints require an unexpired, unrevoked installation token it issued.
// - Lists paginate with per_page/page and absolute Link headers; rate-limit headers are sent.
// - state.failNext: [{ match: RegExp (on "METHOD /path"), status, body?, headers? }] is consumed in order.
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';

export const user = (id, login, type = 'User') => ({ id, login, type });

export function createFakeGithubState({ appId }) {
  return {
    appId,
    installations: {},
    repos: {}, // full_name -> repo data
    tokens: new Map(),
    tokenCounter: 0,
    calls: [],
    failNext: [],
    rateLimitRemaining: 5000,
    resetAt: Math.floor(Date.now() / 1000) + 3600,
  };
}

/** A repository with its issues, pulls (+reviews), comments and commits. */
export function addRepo(state, installationId, { id, fullName, isPrivate = false, defaultBranch = 'main', owner }) {
  state.repos[fullName] = {
    meta: {
      id,
      name: fullName.split('/')[1],
      full_name: fullName,
      private: isPrivate,
      visibility: isPrivate ? 'private' : 'public',
      description: `${fullName} description`,
      html_url: `https://github.com/${fullName}`,
      default_branch: defaultBranch,
      archived: false,
      owner: owner ?? user(9000, fullName.split('/')[0], 'Organization'),
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    },
    installationId: String(installationId),
    issues: [],
    pulls: [],
    reviews: {}, // number -> []
    issueComments: [],
    reviewComments: [],
    commits: [],
  };
  return state.repos[fullName];
}

export function addInstallation(state, { id, login, type = 'Organization', repositorySelection = 'selected' }) {
  state.installations[String(id)] = {
    id,
    app_id: Number(state.appId),
    app_slug: 'workagent-test',
    account: { id: id + 100000, login, type },
    repository_selection: repositorySelection,
    permissions: { metadata: 'read', issues: 'read', pull_requests: 'read', contents: 'read' },
    events: ['issues', 'issue_comment', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'push', 'repository'],
    suspended_at: null,
  };
  return state.installations[String(id)];
}

export async function startFakeGithub({ appId, publicKey, port = 0 }) {
  const state = createFakeGithubState({ appId });
  let base;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': String(Math.max(0, state.rateLimitRemaining)),
      'x-ratelimit-reset': String(state.resetAt),
      ...headers,
    });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  function paginate(req, res, url, items) {
    const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 30));
    const page = Number(url.searchParams.get('page') ?? 1);
    const slice = items.slice((page - 1) * perPage, page * perPage);
    const headers = {};
    if (page * perPage < items.length) {
      const next = new URL(url.pathname + url.search, base);
      next.searchParams.set('page', String(page + 1));
      next.searchParams.set('per_page', String(perPage));
      headers.link = `<${next}>; rel="next"`;
    }
    return send(res, 200, slice, headers);
  }

  const handler = (req, res) => {
    const url = new URL(req.url, base);
    const auth = req.headers.authorization ?? '';
    const line = `${req.method} ${url.pathname}`;
    state.calls.push({ line, query: Object.fromEntries(url.searchParams), auth });

    const failIdx = state.failNext.findIndex((f) => f.match.test(line));
    if (failIdx !== -1) {
      const [f] = state.failNext.splice(failIdx, 1);
      if (f.remaining !== undefined) state.rateLimitRemaining = f.remaining;
      return send(res, f.status, f.body ?? { message: 'injected failure' }, f.headers);
    }
    state.rateLimitRemaining--;

    // GitHub's "install App" page, for browser checks: approve at once and send the browser to the
    // App's Setup URL like GitHub does (installation_id + setup_action + the state we were given).
    const install = url.pathname.match(/^\/apps\/[^/]+\/installations\/new$/);
    if (install && state.setupUrl) {
      const back = new URL(state.setupUrl);
      back.searchParams.set('installation_id', String(state.defaultInstallationId));
      back.searchParams.set('setup_action', 'install');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }

    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    // --- App endpoints (JWT) ---
    if (url.pathname.startsWith('/app/')) {
      try {
        const claims = jwt.verify(bearer ?? '', publicKey, { algorithms: ['RS256'] });
        if (String(claims.iss) !== String(appId)) throw new Error('iss');
        if (claims.exp - claims.iat > 600) throw new Error('too long');
      } catch {
        return send(res, 401, { message: 'A JSON web token could not be decoded' });
      }
      let m = url.pathname.match(/^\/app\/installations\/(\d+)(\/access_tokens)?$/);
      if (!m) return send(res, 404, { message: 'Not Found' });
      const inst = state.installations[m[1]];
      if (!inst) return send(res, 404, { message: 'Not Found' });
      if (m[2] && req.method === 'POST') {
        if (inst.suspended_at) return send(res, 403, { message: 'This installation has been suspended' });
        const token = `ghs_fake_${++state.tokenCounter}_${Math.random().toString(36).slice(2)}`;
        const expiresAt = new Date(Date.now() + 3600_000);
        state.tokens.set(token, { installationId: m[1], expiresAt, revoked: false });
        return send(res, 201, { token, expires_at: expiresAt.toISOString(), permissions: inst.permissions, repository_selection: inst.repository_selection });
      }
      if (req.method === 'GET') return send(res, 200, inst);
      if (req.method === 'DELETE') {
        delete state.installations[m[1]];
        return send(res, 204);
      }
      return send(res, 404, { message: 'Not Found' });
    }

    // --- Installation endpoints (token) ---
    const tok = state.tokens.get(bearer);
    if (!tok || tok.revoked || tok.expiresAt < new Date() || !state.installations[tok.installationId]) {
      return send(res, 401, { message: 'Bad credentials' });
    }
    const reposOfInstallation = Object.values(state.repos).filter((r) => r.installationId === tok.installationId);

    if (url.pathname === '/installation/repositories') {
      const perPage = Math.min(100, Number(url.searchParams.get('per_page') ?? 30));
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = reposOfInstallation.map((r) => r.meta);
      const headers = {};
      if (page * perPage < all.length) {
        const next = new URL('/installation/repositories', base);
        next.searchParams.set('per_page', String(perPage));
        next.searchParams.set('page', String(page + 1));
        headers.link = `<${next}>; rel="next"`;
      }
      return send(res, 200, { total_count: all.length, repositories: all.slice((page - 1) * perPage, page * perPage) }, headers);
    }

    const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!m) return send(res, 404, { message: 'Not Found' });
    const repo = state.repos[`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`];
    if (!repo || repo.installationId !== tok.installationId) return send(res, 404, { message: 'Not Found' });
    const rest = m[3] ?? '';
    const since = url.searchParams.get('since');
    const stateFilter = url.searchParams.get('state') ?? 'open';
    const byState = (i) => stateFilter === 'all' || i.state === stateFilter;
    const sinceOk = (i) => !since || i.updated_at >= since;
    const asc = (a, b) => a.updated_at.localeCompare(b.updated_at) || a.id - b.id;

    if (rest === '') return send(res, 200, repo.meta);
    if (rest === '/issues') {
      const asIssues = repo.pulls.map((p) => ({ ...p, id: p.id + 1_000_000, pull_request: { url: `${base}repos/${repo.meta.full_name}/pulls/${p.number}` }, state: p.state }));
      return paginate(req, res, url, [...repo.issues, ...asIssues].filter(byState).filter(sinceOk).sort(asc));
    }
    if (rest === '/pulls') {
      const list = repo.pulls.filter(byState);
      list.sort(url.searchParams.get('sort') === 'updated' ? (a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id : (a, b) => b.number - a.number);
      return paginate(req, res, url, list);
    }
    let r = rest.match(/^\/pulls\/(\d+)\/reviews$/);
    if (r) {
      if (!repo.pulls.some((p) => p.number === Number(r[1]))) return send(res, 404, { message: 'Not Found' });
      return paginate(req, res, url, repo.reviews[r[1]] ?? []);
    }
    if (rest === '/issues/comments') return paginate(req, res, url, repo.issueComments.filter(sinceOk).sort(asc));
    if (rest === '/pulls/comments') return paginate(req, res, url, repo.reviewComments.filter(sinceOk).sort(asc));
    if (rest === '/commits') {
      if (!repo.commits.length) return send(res, 409, { message: 'Git Repository is empty.' });
      const list = repo.commits.filter((c) => !since || c.commit.committer.date >= since).sort((a, b) => b.commit.committer.date.localeCompare(a.commit.committer.date));
      return paginate(req, res, url, list);
    }
    return send(res, 404, { message: 'Not Found' });
  };

  const server = createServer(handler);
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
  return {
    url: base.replace(/\/$/, ''),
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
    reset() {
      Object.assign(state, createFakeGithubState({ appId }));
    },
  };
}

// ---- Fixture builders ------------------------------------------------------------------------
let seq = 1;
const at = (day, hour = 9) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
export { at };

export function issue(repo, number, { state = 'open', updated = at(1), created, author = user(1, 'ana'), title, assignees = [], labels = [], closedAt = null, reason = null } = {}) {
  const i = {
    id: 50_000 + seq++,
    number,
    title: title ?? `Issue ${number}`,
    body: `Body of issue ${number}`,
    state,
    state_reason: reason,
    user: author,
    assignees,
    labels: labels.map((name) => ({ name })),
    milestone: null,
    comments: 0,
    created_at: created ?? updated,
    updated_at: updated,
    closed_at: closedAt,
    html_url: `https://github.com/${repo.meta.full_name}/issues/${number}`,
  };
  repo.issues.push(i);
  return i;
}

export function pull(repo, number, { state = 'open', updated = at(1), created, author = user(2, 'raj'), title, mergedAt = null, closedAt = null, reviewers = [], draft = false } = {}) {
  const p = {
    id: 70_000 + seq++,
    number,
    title: title ?? `PR ${number}`,
    body: `Body of PR ${number}`,
    state,
    draft,
    user: author,
    assignees: [],
    requested_reviewers: reviewers,
    requested_teams: [],
    labels: [],
    milestone: null,
    head: { ref: `feature-${number}`, sha: `head${number}` },
    base: { ref: 'main' },
    merged_at: mergedAt,
    merge_commit_sha: mergedAt ? `merge${number}` : null,
    created_at: created ?? updated,
    updated_at: updated,
    closed_at: closedAt ?? mergedAt,
    html_url: `https://github.com/${repo.meta.full_name}/pull/${number}`,
  };
  repo.pulls.push(p);
  return p;
}

export function review(repo, number, { state = 'APPROVED', submitted = at(2), reviewer = user(1, 'ana'), body = 'Looks good' } = {}) {
  const r = { id: 90_000 + seq++, user: reviewer, state, body, submitted_at: submitted, commit_id: 'abc', html_url: `https://github.com/${repo.meta.full_name}/pull/${number}#review` };
  (repo.reviews[number] ??= []).push(r);
  return r;
}

export function issueComment(repo, number, { onPull = false, updated = at(2), author = user(1, 'ana'), body = 'A comment' } = {}) {
  const c = {
    id: 110_000 + seq++,
    user: author,
    body,
    created_at: updated,
    updated_at: updated,
    issue_url: `https://api.github.com/repos/${repo.meta.full_name}/issues/${number}`,
    html_url: `https://github.com/${repo.meta.full_name}/${onPull ? 'pull' : 'issues'}/${number}#issuecomment`,
  };
  repo.issueComments.push(c);
  return c;
}

export function reviewComment(repo, number, { updated = at(2), author = user(1, 'ana'), body = 'Nit', path = 'src/app.js' } = {}) {
  const c = {
    id: 130_000 + seq++,
    user: author,
    body,
    path,
    line: 10,
    diff_hunk: '@@ -1 +1 @@ very long diff text',
    created_at: updated,
    updated_at: updated,
    pull_request_url: `https://api.github.com/repos/${repo.meta.full_name}/pulls/${number}`,
    html_url: `https://github.com/${repo.meta.full_name}/pull/${number}#discussion`,
  };
  repo.reviewComments.push(c);
  return c;
}

export function commit(repo, sha, { date = at(3), author = user(2, 'raj'), message = `Commit ${sha}` } = {}) {
  const c = {
    sha,
    html_url: `https://github.com/${repo.meta.full_name}/commit/${sha}`,
    author,
    commit: {
      message,
      author: { name: author?.login ?? 'someone', email: 'unverified@example.test', date },
      committer: { name: author?.login ?? 'someone', email: 'unverified@example.test', date },
      verification: { verified: false },
    },
  };
  repo.commits.push(c);
  return c;
}
