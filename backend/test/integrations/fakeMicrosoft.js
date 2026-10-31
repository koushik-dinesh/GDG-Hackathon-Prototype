// A small fake of Microsoft identity (v2 token endpoint) and Microsoft Graph for tests, on
// 127.0.0.1: form-encoded token requests, rotating refresh tokens, granted scopes, joined teams and
// channels, channel message delta + replies, mail folder message delta and calendarView delta
// (nextLink paging, deltaLink tokens, "@removed" deletions).
// state.failNext: [{ match: RegExp on "METHOD /path", status, body?, headers? }] consumed in order.
import { createServer } from 'node:http';

export const TENANT = '0f0e0d0c-0b0a-0908-0706-050403020100';
export const CLIENT_ID = '12345678-90ab-cdef-1234-567890abcdef';
export const CLIENT_SECRET = 'ms-client-secret-value';
export const ME = { id: 'aad-user-1', displayName: 'Ada Admin', userPrincipalName: 'ada@contoso.test', mail: 'ada@contoso.test' };

export function createFakeMicrosoftState() {
  return {
    codes: new Map(), // code -> granted scope string
    access: new Map(),
    refresh: new Map(),
    counter: 0,
    grantScopes: null, // override the granted scopes (e.g. without admin consent)
    teams: [], // { id, displayName, channels: [{ id, displayName, messages: [], replies: { postId: [] } }] }
    folders: [], // { id, displayName, messages: [] }
    calendars: [], // { id, name, events: [] }
    deltaTokens: new Map(), // token -> { kind, key, since: change counter }
    changes: 0, // increases with every mutation; delta returns items changed after a token's mark
    calls: [],
    failNext: [],
  };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

async function readForm(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}

/** Marks an item changed now (delta queries after this point include it). */
export function touch(state, item, fields = {}) {
  state.changes += 1;
  Object.assign(item, fields, { _change: state.changes });
  return item;
}

export function team(state, { id, displayName, channels }) {
  const t = { id, displayName, channels: channels.map((c) => ({ ...c, messages: [], replies: {} })) };
  state.teams.push(t);
  return t;
}

export function post(state, channel, { id, text, at, by = { id: 'aad-user-2', displayName: 'Raj' }, subject = null, replies = [] }) {
  const m = touch(state, { id, messageType: 'message', subject, body: { contentType: 'html', content: `<p>${text}</p>` }, from: { user: by }, createdDateTime: at, lastModifiedDateTime: at, webUrl: `https://teams.microsoft.com/l/message/${id}` });
  channel.messages.push(m);
  channel.replies[id] = replies.map((r) => ({ id: r.id, messageType: 'message', replyToId: id, body: { contentType: 'html', content: r.text }, from: { user: r.by ?? { id: 'aad-user-3', displayName: 'Mia' } }, createdDateTime: r.at, lastModifiedDateTime: r.at }));
  return m;
}

export function mail(state, folder, { id, subject, from, at, preview = '' }) {
  const m = touch(state, { id, subject, from: { emailAddress: { address: from, name: from.split('@')[0] } }, toRecipients: [{ emailAddress: { address: ME.mail, name: 'Ada' } }], receivedDateTime: at, lastModifiedDateTime: at, bodyPreview: preview, webLink: `https://outlook.office.com/mail/id/${id}`, conversationId: `conv-${id}`, importance: 'normal', categories: [], isDraft: false });
  folder.messages.push(m);
  return m;
}

export function event(state, calendar, { id, subject, start, end, organizer = 'mia@contoso.test', online = true }) {
  const e = touch(state, {
    id,
    subject,
    bodyPreview: `Agenda for ${subject}`,
    start: { dateTime: start.replace('Z', ''), timeZone: 'UTC' },
    end: { dateTime: end.replace('Z', ''), timeZone: 'UTC' },
    organizer: { emailAddress: { address: organizer, name: organizer.split('@')[0] } },
    attendees: [{ emailAddress: { address: ME.mail } }, { emailAddress: { address: 'raj@contoso.test' } }],
    isCancelled: false,
    isOnlineMeeting: online,
    onlineMeeting: online ? { joinUrl: `https://teams.microsoft.com/l/meetup-join/${id}` } : null,
    webLink: `https://outlook.office.com/calendar/item/${id}`,
    createdDateTime: start,
    lastModifiedDateTime: start,
    type: 'singleInstance',
  });
  calendar.events.push(e);
  return e;
}

/** Deletes an item: later delta pages report it as "@removed". */
export function remove(state, list, id) {
  const item = list.find((x) => x.id === id);
  touch(state, item, { _removed: true });
}

export async function startFakeMicrosoft({ port = 0 } = {}) {
  let state = createFakeMicrosoftState();
  let base = '';
  const issue = (scope) => {
    state.counter += 1;
    const access = `ms_at_${state.counter}_${Math.random().toString(36).slice(2)}`;
    const refresh = `ms_rt_${state.counter}_${Math.random().toString(36).slice(2)}`;
    state.access.set(access, true);
    state.refresh.set(refresh, scope);
    return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600, scope };
  };

  /** Delta over a list: items changed after the token's mark, 2 per page. */
  function delta(res, url, kind, key, list, filterFn = () => true) {
    const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
    const token = url.searchParams.get('$deltatoken');
    const mark = token ? state.deltaTokens.get(token)?.mark : 0;
    if (token && mark === undefined) return json(res, 410, { error: { code: 'syncStateNotFound' } });
    const changed = list.filter((x) => x._change > mark && (token || !x._removed) && filterFn(x));
    const page = changed.slice(skip, skip + 2).map(({ _change, _removed, ...x }) => (_removed ? { id: x.id, '@removed': { reason: 'deleted' } } : x));
    const body = { value: page };
    const path = url.pathname;
    if (skip + 2 < changed.length) {
      const next = new URL(`${base}${path}`);
      for (const [k, v] of url.searchParams) if (k !== '$skiptoken') next.searchParams.set(k, v);
      next.searchParams.set('$skiptoken', String(skip + 2));
      body['@odata.nextLink'] = next.toString();
    } else {
      const t = `dt${state.changes}_${Math.random().toString(36).slice(2, 8)}`;
      state.deltaTokens.set(t, { kind, key, mark: state.changes });
      body['@odata.deltaLink'] = `${base}${path}?$deltatoken=${t}`;
    }
    return json(res, 200, body);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const sig = `${req.method} ${url.pathname}`;
    state.calls.push({ sig, query: Object.fromEntries(url.searchParams) });
    const fail = state.failNext.findIndex((f) => f.match.test(sig));
    if (fail >= 0) {
      const f = state.failNext.splice(fail, 1)[0];
      return json(res, f.status, f.body ?? { error: { code: 'failure' } }, f.headers);
    }
    // Sign-in stand-in for manual browser checks: consents at once and redirects back.
    if (sig === `GET /${TENANT}/oauth2/v2.0/authorize`) {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.set(code, url.searchParams.get('scope'));
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (sig === `POST /${TENANT}/oauth2/v2.0/token`) {
      const form = await readForm(req);
      if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return json(res, 400, { error: 'invalid_request' });
      if (form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET) return json(res, 401, { error: 'invalid_client' });
      if (form.grant_type === 'authorization_code') {
        if (!state.codes.has(form.code)) return json(res, 400, { error: 'invalid_grant' });
        const scope = state.grantScopes ?? state.codes.get(form.code);
        state.codes.delete(form.code);
        return json(res, 200, issue(scope));
      }
      if (form.grant_type === 'refresh_token') {
        const scope = state.refresh.get(form.refresh_token);
        if (!scope) return json(res, 400, { error: 'invalid_grant', error_codes: [70000] });
        state.refresh.delete(form.refresh_token);
        return json(res, 200, issue(scope));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!state.access.has(token)) return json(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
    const p = url.pathname;
    if (p === '/v1.0/me') return json(res, 200, ME);
    if (p === '/v1.0/me/joinedTeams') return json(res, 200, { value: state.teams.map(({ id, displayName }) => ({ id, displayName })) });
    let m = p.match(/^\/v1\.0\/teams\/([^/]+)\/channels$/);
    if (m) {
      const t = state.teams.find((x) => x.id === decodeURIComponent(m[1]));
      return t ? json(res, 200, { value: t.channels.map(({ id, displayName }) => ({ id, displayName, membershipType: 'standard', webUrl: `https://teams.microsoft.com/l/channel/${id}` })) }) : json(res, 404, { error: { code: 'NotFound' } });
    }
    m = p.match(/^\/v1\.0\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/delta$/);
    if (m) {
      const ch = state.teams.find((x) => x.id === decodeURIComponent(m[1]))?.channels.find((c) => c.id === decodeURIComponent(m[2]));
      if (!ch) return json(res, 404, { error: { code: 'NotFound' } });
      const since = url.searchParams.get('$filter')?.match(/lastModifiedDateTime gt (\S+)/)?.[1];
      return delta(res, url, 'channel', ch.id, ch.messages, (x) => !since || x._removed || x.lastModifiedDateTime > since);
    }
    m = p.match(/^\/v1\.0\/teams\/([^/]+)\/channels\/([^/]+)\/messages\/([^/]+)\/replies$/);
    if (m) {
      const ch = state.teams.find((x) => x.id === decodeURIComponent(m[1]))?.channels.find((c) => c.id === decodeURIComponent(m[2]));
      const replies = ch?.replies[decodeURIComponent(m[3])];
      return replies ? json(res, 200, { value: replies }) : json(res, 404, { error: { code: 'NotFound' } });
    }
    if (p === '/v1.0/me/mailFolders') return json(res, 200, { value: state.folders.map(({ id, displayName, messages }) => ({ id, displayName, totalItemCount: messages.length })) });
    m = p.match(/^\/v1\.0\/me\/mailFolders\/([^/]+)\/messages\/delta$/);
    if (m) {
      const f = state.folders.find((x) => x.id === decodeURIComponent(m[1]));
      if (!f) return json(res, 404, { error: { code: 'ErrorItemNotFound' } });
      const since = url.searchParams.get('$filter')?.match(/receivedDateTime ge (\S+)/)?.[1];
      return delta(res, url, 'folder', f.id, f.messages, (x) => !since || x._removed || x.receivedDateTime >= since);
    }
    if (p === '/v1.0/me/calendars') return json(res, 200, { value: state.calendars.map(({ id, name }, i) => ({ id, name, isDefaultCalendar: i === 0 })) });
    m = p.match(/^\/v1\.0\/me\/calendars\/([^/]+)\/calendarView\/delta$/);
    if (m) {
      const c = state.calendars.find((x) => x.id === decodeURIComponent(m[1]));
      if (!c) return json(res, 404, { error: { code: 'ErrorItemNotFound' } });
      if (!url.searchParams.get('$deltatoken') && !url.searchParams.get('$skiptoken') && (!url.searchParams.get('startDateTime') || !url.searchParams.get('endDateTime'))) return json(res, 400, { error: { code: 'ErrorInvalidParameter' } });
      return delta(res, url, 'calendar', c.id, c.events);
    }
    return json(res, 404, { error: { code: 'NotFound' } });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    url: base,
    get state() {
      return state;
    },
    reset() {
      state = createFakeMicrosoftState();
    },
    grantCode(scope = 'offline_access User.Read Team.ReadBasic.All Channel.ReadBasic.All ChannelMessage.Read.All Mail.Read Calendars.Read') {
      const code = `code-${Math.random().toString(36).slice(2)}`;
      state.codes.set(code, scope);
      return code;
    },
    revokeAll() {
      state.access.clear();
      state.refresh.clear();
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
