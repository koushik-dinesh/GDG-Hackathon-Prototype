// A small fake of Google OAuth, Calendar v3 and Meet v2 for tests, on 127.0.0.1: form token
// requests (non-rotating refresh tokens), granted scopes, calendarList, events with timeMin /
// pageToken / syncToken (410 for unknown tokens) and cancelled events, conference records with
// spaces, participants and transcripts, and /revoke.
import { createServer } from 'node:http';

export const CLIENT_ID = 'google-client-id.apps.googleusercontent.com';
export const CLIENT_SECRET = 'google-client-secret-value';
export const DOMAIN = 'acme.test';
const ALL_SCOPES = 'openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/meetings.space.readonly';

export function createFakeGoogleState() {
  return { codes: new Map(), access: new Set(), refresh: new Set(), revoked: [], account: `ada@${DOMAIN}`, calendars: [], conferences: [], syncTokens: new Map(), changes: 0, calls: [], failNext: [] };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

export function calendar(state, { id, summary, primary = false }) {
  const c = { id, summary, primary, events: [] };
  state.calendars.push(c);
  return c;
}

export function meetEvent(state, cal, { id, summary, start, end, code = null, organizer = `mia@${DOMAIN}` }) {
  state.changes += 1;
  const ev = {
    id,
    status: 'confirmed',
    summary,
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    created: start,
    updated: start,
    organizer: { email: organizer, displayName: organizer.split('@')[0] },
    attendees: [{ email: `ada@${DOMAIN}` }, { email: `raj@${DOMAIN}` }],
    start: { dateTime: start },
    end: { dateTime: end },
    ...(code ? { hangoutLink: `https://meet.google.com/${code}`, conferenceData: { conferenceId: code, conferenceSolution: { key: { type: 'hangoutsMeet' } }, entryPoints: [{ entryPointType: 'video', uri: `https://meet.google.com/${code}` }] } } : {}),
    _change: state.changes,
  };
  cal.events.push(ev);
  return ev;
}

export function change(state, ev, fields) {
  state.changes += 1;
  Object.assign(ev, fields, { updated: new Date().toISOString(), _change: state.changes });
}

export function conference(state, { id, code, start, end = null, participants = 3, transcript = false }) {
  state.conferences.push({ name: `conferenceRecords/${id}`, space: `spaces/space-${code}`, startTime: start, endTime: end, code, participants, transcript });
}

export async function startFakeGoogle({ port = 0 } = {}) {
  let state = createFakeGoogleState();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const sig = `${req.method} ${url.pathname}`;
    state.calls.push({ sig, query: Object.fromEntries(url.searchParams) });
    const fail = state.failNext.findIndex((f) => f.match.test(sig));
    if (fail >= 0) {
      const f = state.failNext.splice(fail, 1)[0];
      return json(res, f.status, f.body ?? { error: { code: f.status } }, f.headers);
    }
    if (sig === 'GET /o/oauth2/v2/auth') {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.set(code, ALL_SCOPES);
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && (url.pathname === '/token' || url.pathname === '/revoke')) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      if (url.pathname === '/revoke') {
        state.revoked.push(form.token);
        state.refresh.delete(form.token);
        return json(res, 200, {});
      }
      if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET) return json(res, 401, { error: 'invalid_client' });
      const access = `ya29.fake_${Math.random().toString(36).slice(2)}`;
      state.access.add(access);
      if (form.grant_type === 'authorization_code') {
        const scope = state.codes.get(form.code);
        if (!scope) return json(res, 400, { error: 'invalid_grant' });
        state.codes.delete(form.code);
        const refresh = `1//fake_${Math.random().toString(36).slice(2)}`;
        state.refresh.add(refresh);
        return json(res, 200, { access_token: access, expires_in: 3599, refresh_token: refresh, scope, token_type: 'Bearer' });
      }
      if (form.grant_type === 'refresh_token') {
        if (!state.refresh.has(form.refresh_token)) return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
        return json(res, 200, { access_token: access, expires_in: 3599, scope: ALL_SCOPES, token_type: 'Bearer' }); // no new refresh token
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (!state.access.has(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))) return json(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } });

    const p = url.pathname;
    if (p === '/calendar/v3/calendars/primary') return json(res, 200, { id: state.account, summary: state.account, timeZone: 'Europe/Berlin' });
    if (p === '/calendar/v3/users/me/calendarList') return json(res, 200, { items: state.calendars.map(({ id, summary, primary }) => ({ id, summary, primary, accessRole: 'owner', timeZone: 'Europe/Berlin' })) });
    let m = p.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
    if (m) {
      const cal = state.calendars.find((c) => c.id === decodeURIComponent(m[1]));
      if (!cal) return json(res, 404, { error: { code: 404 } });
      const syncToken = url.searchParams.get('syncToken');
      let items;
      if (syncToken) {
        if (!state.syncTokens.has(syncToken)) return json(res, 410, { error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } });
        const mark = state.syncTokens.get(syncToken);
        items = cal.events.filter((e) => e._change > mark);
      } else {
        const timeMin = url.searchParams.get('timeMin');
        items = cal.events.filter((e) => e.status !== 'cancelled' && (!timeMin || e.end.dateTime >= timeMin));
      }
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const page = items.slice(offset, offset + 2).map(({ _change, ...e }) => (e.status === 'cancelled' ? { id: e.id, status: 'cancelled' } : e));
      if (offset + 2 < items.length) return json(res, 200, { items: page, nextPageToken: String(offset + 2) });
      const token = `sync_${state.changes}_${Math.random().toString(36).slice(2, 7)}`;
      state.syncTokens.set(token, state.changes);
      return json(res, 200, { items: page, nextSyncToken: token });
    }
    if (p === '/v2/conferenceRecords') {
      const since = url.searchParams.get('filter')?.match(/start_time>="([^"]+)"/)?.[1];
      const all = state.conferences.filter((c) => !since || c.startTime >= since);
      const offset = Number(url.searchParams.get('pageToken') ?? 0);
      const page = all.slice(offset, offset + 2).map(({ name, space, startTime, endTime }) => ({ name, space, startTime, ...(endTime ? { endTime } : {}) }));
      return json(res, 200, { conferenceRecords: page, ...(offset + 2 < all.length ? { nextPageToken: String(offset + 2) } : {}) });
    }
    m = p.match(/^\/v2\/spaces\/space-(.+)$/);
    if (m) return json(res, 200, { name: `spaces/space-${m[1]}`, meetingCode: m[1], meetingUri: `https://meet.google.com/${m[1]}` });
    m = p.match(/^\/v2\/conferenceRecords\/([^/]+)\/(participants|transcripts)$/);
    if (m) {
      const conf = state.conferences.find((c) => c.name === `conferenceRecords/${decodeURIComponent(m[1])}`);
      if (!conf) return json(res, 404, { error: { code: 404 } });
      if (m[2] === 'participants') return json(res, 200, { participants: [], totalSize: conf.participants });
      return json(res, 200, { transcripts: conf.transcript ? [{ name: `${conf.name}/transcripts/t1`, state: 'FILE_GENERATED', docsDestination: { exportUri: 'https://docs.google.com/document/d/t1' } }] : [] });
    }
    return json(res, 404, { error: { code: 404 } });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    get state() {
      return state;
    },
    reset() {
      state = createFakeGoogleState();
    },
    grantCode(scope = ALL_SCOPES) {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.set(code, scope);
      return code;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
