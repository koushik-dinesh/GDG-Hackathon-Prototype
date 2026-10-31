// A small fake of Atlassian's OAuth and Jira Cloud REST v3 for tests. Real HTTP on 127.0.0.1, so
// the connector's token exchange, refresh rotation, bearer auth, paging and errors run for real.
//
// - POST /oauth/token: authorization_code (state.codes) and refresh_token (rotating: a used refresh
//   token stops working) grants; JSON bodies like Atlassian's.
// - Access tokens expire (state.accessTtlS) and can be revoked (state.revokeAll()).
// - /ex/jira/<cloudId>/rest/api/3/*: myself, project/search, search/jql (project, open-only and
//   `updated >=` clauses; nextPageToken paging), issue/<id>/comment.
// - state.failNext: [{ match: RegExp on "METHOD /path", status, body?, headers? }] consumed in order.
import { createServer } from 'node:http';

export const CLOUD_ID = '11111111-2222-3333-4444-555555555555';
export const SITE_URL = 'https://acme.atlassian.net';
export const person = (accountId, displayName, accountType = 'atlassian') => ({ accountId, displayName, accountType });

export function createFakeJiraState() {
  return {
    codes: new Map(), // code -> { scopes }
    access: new Map(), // token -> { expiresAt }
    refresh: new Map(), // token -> true while valid
    counter: 0,
    accessTtlS: 3600,
    sites: [{ id: CLOUD_ID, url: SITE_URL, name: 'acme', scopes: ['read:jira-work', 'read:jira-user', 'offline_access'] }],
    issueRefresh: true,
    projects: [],
    issues: [],
    timeZone: 'UTC',
    calls: [],
    failNext: [],
  };
}

export function project(state, { id, key, name }) {
  const p = { id: String(id), key, name: name ?? key, projectTypeKey: 'software' };
  state.projects.push(p);
  return p;
}

const STATUS = {
  todo: { name: 'To Do', statusCategory: { key: 'new' } },
  progress: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
  done: { name: 'Done', statusCategory: { key: 'done' } },
};
const adf = (text) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

export function issue(state, p, { id, number, summary, status = 'todo', updated, created, reporter = person('acc-ana', 'Ana'), assignee = null, labels = [], description = null, links = [], parent = null, comments = [], due = null }) {
  const i = {
    id: String(id),
    key: `${p.key}-${number}`,
    fields: {
      summary,
      status: STATUS[status],
      project: { id: p.id, key: p.key },
      issuetype: { name: parent ? 'Sub-task' : 'Task', subtask: Boolean(parent) },
      priority: { name: 'Medium' },
      reporter,
      creator: reporter,
      assignee,
      labels,
      duedate: due,
      description: description ? adf(description) : null,
      created: created ?? updated,
      updated,
      resolution: status === 'done' ? { name: 'Done' } : null,
      resolutiondate: status === 'done' ? updated : null,
      parent: parent ? { id: parent.id, key: parent.key } : undefined,
      subtasks: [],
      issuelinks: links,
      comment: { comments: [], total: 0 },
    },
    allComments: comments.map((c, n) => ({ id: String(c.id ?? `${id}${n}`), author: c.author ?? person('acc-raj', 'Raj'), body: adf(c.text), created: c.at, updated: c.at })),
  };
  // Like Jira's search, only the first 2 comments are inlined; the rest need /issue/<id>/comment.
  i.fields.comment = { comments: i.allComments.slice(0, 2), total: i.allComments.length };
  if (parent) parent.fields.subtasks.push({ id: i.id, key: i.key });
  state.issues.push(i);
  return i;
}

/** "Blocks" link from `a` to `b`, visible on both issues as Jira shows it. */
export function blocks(a, b) {
  const type = { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' };
  a.fields.issuelinks.push({ id: `l${a.id}${b.id}`, type, outwardIssue: { id: b.id, key: b.key } });
  b.fields.issuelinks.push({ id: `l${a.id}${b.id}`, type, inwardIssue: { id: a.id, key: a.key } });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** Parses the JQL clauses the connector writes. */
function matches(state, i, jql) {
  const key = jql.match(/project = "([^"]+)"/)?.[1];
  if (key && i.fields.project.key !== key) return false;
  if (/statusCategory != Done/.test(jql) && i.fields.status.statusCategory.key === 'done') return false;
  const since = jql.match(/updated >= "([^"]+)"/)?.[1];
  if (since && new Date(i.fields.updated) < new Date(`${since.replace(' ', 'T')}:00Z`)) return false;
  return true;
}

export async function startFakeJira({ port = 0 } = {}) {
  let state = createFakeJiraState();
  const issueToken = () => {
    state.counter += 1;
    const access = `jira_at_${state.counter}_${Math.random().toString(36).slice(2)}`;
    const refresh = `jira_rt_${state.counter}_${Math.random().toString(36).slice(2)}`;
    state.access.set(access, { expiresAt: Date.now() + state.accessTtlS * 1000 });
    state.refresh.set(refresh, true);
    return { access_token: access, refresh_token: state.issueRefresh ? refresh : undefined, expires_in: state.accessTtlS, scope: 'read:jira-work read:jira-user offline_access', token_type: 'Bearer' };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const sig = `${req.method} ${url.pathname}`;
    state.calls.push({ sig, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization ?? null });
    const fail = state.failNext.findIndex((f) => f.match.test(sig));
    if (fail >= 0) {
      const f = state.failNext.splice(fail, 1)[0];
      return json(res, f.status, f.body ?? { errorMessages: ['failure'] }, f.headers);
    }
    try {
      // Consent screen stand-in for manual (browser) checks: approves at once and redirects back.
      if (sig === 'GET /authorize') {
        const code = `code-${Math.random().toString(36).slice(2)}`;
        state.codes.set(code, true);
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (sig === 'POST /oauth/token') {
        const body = await readBody(req);
        if (body.client_id !== 'jira-client-id-123' || body.client_secret !== 'jira-client-secret-456') return json(res, 401, { error: 'access_denied' });
        if (body.grant_type === 'authorization_code') {
          if (!state.codes.has(body.code)) return json(res, 403, { error: 'invalid_grant' });
          state.codes.delete(body.code);
          return json(res, 200, issueToken());
        }
        if (body.grant_type === 'refresh_token') {
          if (!state.refresh.get(body.refresh_token)) return json(res, 403, { error: 'unauthorized_client', error_description: 'refresh_token is invalid' });
          state.refresh.delete(body.refresh_token); // rotation: single use
          return json(res, 200, issueToken());
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const grant = state.access.get(token);
      if (!grant || grant.expiresAt < Date.now()) return json(res, 401, { code: 401, message: 'Unauthorized' });

      if (sig === 'GET /oauth/token/accessible-resources') return json(res, 200, state.sites);
      const m = url.pathname.match(/^\/ex\/jira\/([^/]+)\/rest\/api\/3(\/.*)$/);
      if (!m || !state.sites.some((s) => s.id === m[1])) return json(res, 404, { errorMessages: ['site not found'] });
      const path = m[2];
      if (path === '/myself') return json(res, 200, { accountId: 'acc-admin', displayName: 'Admin', timeZone: state.timeZone });
      if (path === '/project/search') {
        const startAt = Number(url.searchParams.get('startAt') ?? 0);
        const max = Number(url.searchParams.get('maxResults') ?? 50);
        const values = state.projects.slice(startAt, startAt + max);
        return json(res, 200, { values, startAt, total: state.projects.length, isLast: startAt + max >= state.projects.length });
      }
      if (path === '/search/jql') {
        const jql = url.searchParams.get('jql') ?? '';
        const max = Number(url.searchParams.get('maxResults') ?? 50);
        const offset = url.searchParams.get('nextPageToken') ? Number(Buffer.from(url.searchParams.get('nextPageToken'), 'base64url').toString()) : 0;
        const all = state.issues.filter((i) => matches(state, i, jql)).sort((a, b) => a.fields.updated.localeCompare(b.fields.updated));
        const page = all.slice(offset, offset + max).map(({ allComments, ...i }) => i);
        const last = offset + max >= all.length;
        return json(res, 200, { issues: page, isLast: last, ...(last ? {} : { nextPageToken: Buffer.from(String(offset + max)).toString('base64url') }) });
      }
      const cm = path.match(/^\/issue\/([^/]+)\/comment$/);
      if (cm) {
        const i = state.issues.find((x) => x.id === cm[1]);
        if (!i) return json(res, 404, { errorMessages: ['Issue does not exist'] });
        const startAt = Number(url.searchParams.get('startAt') ?? 0);
        const max = Number(url.searchParams.get('maxResults') ?? 50);
        return json(res, 200, { comments: i.allComments.slice(startAt, startAt + max), startAt, total: i.allComments.length });
      }
      return json(res, 404, { errorMessages: ['not found'] });
    } catch (err) {
      return json(res, 500, { errorMessages: [err.message] });
    }
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const { port: bound } = server.address();
  return {
    url: `http://127.0.0.1:${bound}`,
    get state() {
      return state;
    },
    reset() {
      state = createFakeJiraState();
    },
    /** A one-time authorization code, as Atlassian would put on the redirect. */
    grantCode() {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.set(code, true);
      return code;
    },
    revokeAll() {
      state.access.clear();
      state.refresh.clear();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
