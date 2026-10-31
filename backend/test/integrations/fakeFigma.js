// A small fake of Figma OAuth and REST v1 for tests, on 127.0.0.1: Basic-auth token and refresh
// endpoints (refresh tokens not rotated), /v1/me, team projects (403 for other teams), project
// files, file comments and versions.
import { createServer } from 'node:http';

export const CLIENT_ID = 'figma-client-id-1234';
export const CLIENT_SECRET = 'figma-client-secret-5678';
export const TEAM_ID = '987654321';

export function createFakeFigmaState() {
  return { codes: new Set(), access: new Set(), refresh: new Set(), projects: [], calls: [], failNext: [] };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export function project(state, { id, name }) {
  const p = { id, name, files: [] };
  state.projects.push(p);
  return p;
}

export function file(p, { key, name, modified, comments = [], versions = [] }) {
  const f = { key, name, last_modified: modified, thumbnail_url: `https://figma.test/thumb/${key}.png`, comments, versions };
  p.files.push(f);
  return f;
}

export async function startFakeFigma({ port = 0 } = {}) {
  let state = createFakeFigmaState();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const sig = `${req.method} ${url.pathname}`;
    state.calls.push({ sig });
    const fail = state.failNext.findIndex((f) => f.match.test(sig));
    if (fail >= 0) {
      const f = state.failNext.splice(fail, 1)[0];
      return json(res, f.status, f.body ?? { status: f.status, err: 'failure' }, f.headers);
    }
    if (sig === 'GET /oauth') {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.add(code);
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (sig === 'POST /v1/oauth/token' || sig === 'POST /v1/oauth/refresh') {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`) return json(res, 401, { error: true, message: 'invalid client' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      const access = `figd_${Math.random().toString(36).slice(2)}`;
      if (sig === 'POST /v1/oauth/token') {
        if (!state.codes.delete(form.code)) return json(res, 400, { error: true, message: 'invalid code' });
        state.access.add(access);
        const refresh = `figr_${Math.random().toString(36).slice(2)}`;
        state.refresh.add(refresh);
        return json(res, 200, { user_id: 'fig-user-1', access_token: access, refresh_token: refresh, expires_in: 7776000 });
      }
      if (!state.refresh.has(form.refresh_token)) return json(res, 400, { error: true, message: 'invalid refresh token' });
      state.access.add(access);
      return json(res, 200, { access_token: access, expires_in: 7776000 });
    }
    if (!state.access.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return json(res, 403, { status: 403, err: 'Invalid token' });
    const p = url.pathname;
    if (p === '/v1/me') return json(res, 200, { id: 'fig-user-1', handle: 'ada', email: 'ada@acme.test' });
    let m = p.match(/^\/v1\/teams\/([^/]+)\/projects$/);
    if (m) return m[1] === TEAM_ID ? json(res, 200, { name: 'Acme', projects: state.projects.map(({ id, name }) => ({ id, name })) }) : json(res, 403, { status: 403, err: 'Forbidden' });
    m = p.match(/^\/v1\/projects\/([^/]+)\/files$/);
    if (m) {
      const proj = state.projects.find((x) => String(x.id) === m[1]);
      return proj ? json(res, 200, { name: proj.name, files: proj.files.map(({ comments, versions, ...f }) => f) }) : json(res, 404, { status: 404, err: 'Not found' });
    }
    m = p.match(/^\/v1\/files\/([^/]+)\/(comments|versions)$/);
    if (m) {
      const f = state.projects.flatMap((x) => x.files).find((x) => x.key === decodeURIComponent(m[1]));
      if (!f) return json(res, 404, { status: 404, err: 'Not found' });
      return json(res, 200, m[2] === 'comments' ? { comments: f.comments } : { versions: f.versions });
    }
    return json(res, 404, { status: 404, err: 'Not found' });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    get state() {
      return state;
    },
    reset() {
      state = createFakeFigmaState();
    },
    grantCode() {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.add(code);
      return code;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
