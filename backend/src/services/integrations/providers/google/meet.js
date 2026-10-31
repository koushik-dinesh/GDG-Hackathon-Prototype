// Google Meet connector (Google Workspace), delegated OAuth 2.0 with offline access.
//
// Connect: the user signs in with an account of GOOGLE_WORKSPACE_DOMAIN and grants read-only
// Calendar and Meet access; WorkAgent refuses other domains and partial (granular) consent.
// Resources: the account's calendars. Streams per calendar:
//   events       Calendar events that have a Google Meet conference (others are skipped); first run
//                from the backfill window, then Google's sync token (deletions as cancelled events;
//                an expired token (410) restarts from the window)
//   conferences  Meet conference records that started in the window (only on the primary
//                calendar): start/end, participant count, whether a transcript exists
// Google push (Workspace Events API) needs Cloud Pub/Sub and is not implemented: changes arrive
// with the scheduled sync (runbook §13). Google refresh tokens do not rotate.
//
// SSRF: requests go only to the configured token, Calendar and Meet origins.
import { config } from '../../../../config/index.js';
import { ProviderError } from '../../errors.js';
import { authorizeUrl, bearerClient, codeFrom, refreshTokens, requestTokens } from '../oauth2.js';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const MEET_SCOPE = 'https://www.googleapis.com/auth/meetings.space.readonly';
export const GOOGLE_SCOPES = ['openid', 'email', CALENDAR_SCOPE, MEET_SCOPE];
const PAGE = 100;
const CONFERENCE_DETAILS_PER_CHUNK = 5;

const fromConfig = () => ({ ...config.google, appPublicUrl: config.email.appPublicUrl, fetch: undefined });
export const googleSettings = fromConfig();
export const configureGoogle = (o) => Object.assign(googleSettings, o);
export function resetGoogleSettings() {
  for (const k of Object.keys(googleSettings)) delete googleSettings[k];
  Object.assign(googleSettings, fromConfig());
}

function configProblem() {
  if (!googleSettings.clientId) return 'GOOGLE_CLIENT_ID is not set';
  if (!googleSettings.clientSecret) return 'GOOGLE_CLIENT_SECRET is not set';
  if (!googleSettings.domain) return 'GOOGLE_WORKSPACE_DOMAIN is not set';
  if (!googleSettings.appPublicUrl) return 'APP_PUBLIC_URL is not set (needed for the OAuth redirect)';
  return null;
}

const source = () => (googleSettings.domain ? `google:${googleSettings.domain}` : 'google.unconfigured');
const redirectUri = () => `${googleSettings.appPublicUrl}/integrations/google_meet/setup`;
const tokenOptions = () => ({ tokenUrl: googleSettings.tokenUrl, fetch: googleSettings.fetch, format: 'form', clientId: googleSettings.clientId, clientSecret: googleSettings.clientSecret, providerName: 'Google' });

function classify({ status, body, rateLimit }) {
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.status ?? '';
  if (status === 429 || (status === 403 && /rateLimitExceeded|userRateLimitExceeded|RESOURCE_EXHAUSTED/.test(reason))) {
    return new ProviderError('rate_limited', `Google rate limit (${status})`, { status, retryAfterMs: rateLimit.retryAfterMs ?? 60_000 });
  }
  return null;
}

const calendarApi = (ctx) => bearerClient(ctx, { baseUrl: googleSettings.calendarUrl, fetch: googleSettings.fetch, classify, providerName: 'Google' });
const meetApi = (ctx) => bearerClient(ctx, { baseUrl: googleSettings.meetUrl, fetch: googleSettings.fetch, classify, providerName: 'Google' });

// ---- mapping --------------------------------------------------------------------------------------

const meetOf = (ev) => {
  const c = ev.conferenceData;
  if (c?.conferenceSolution?.key?.type !== 'hangoutsMeet') return null;
  return { code: c.conferenceId ?? null, joinUrl: ev.hangoutLink ?? c.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ?? null };
};
const personOf = (p) => (p?.email ? [{ type: 'identity', externalUserId: p.email.toLowerCase(), login: p.email.toLowerCase(), displayName: p.displayName ?? null, email: p.email.toLowerCase(), isBot: false }] : []);
const personRef = (p) => (p?.email ? { externalUserId: p.email.toLowerCase() } : null);
const timeOf = (t) => (t?.dateTime ? new Date(t.dateTime).toISOString() : t?.date ? new Date(`${t.date}T00:00:00Z`).toISOString() : null);

export function eventEnvelopes(src, calendarId, ev, now = new Date()) {
  const ref = { recordType: 'calendar_event', externalId: `${calendarId}/${ev.id}`.slice(0, 191) };
  if (ev.status === 'cancelled') return [{ type: 'record', ...ref, title: null, body: null, deleted: true }]; // tombstone
  const meet = meetOf(ev);
  if (!meet) return []; // not a Google Meet event
  const end = timeOf(ev.end);
  return [
    ...personOf(ev.organizer),
    {
      type: 'record',
      ...ref,
      externalKey: meet.code,
      url: ev.htmlLink ?? null,
      title: ev.summary || '(no title)',
      body: ev.description ? String(ev.description).replace(/<[^>]+>/g, ' ').slice(0, 2000) : null,
      state: 'scheduled',
      statusCategory: end && new Date(end) < now ? 'done' : 'todo',
      authorRef: personRef(ev.organizer),
      sourceCreatedAt: ev.created ?? null,
      sourceUpdatedAt: ev.updated ?? null,
      metadata: { calendarId, start: timeOf(ev.start), end, meetCode: meet.code, joinUrl: meet.joinUrl, organizer: ev.organizer?.email ?? null, attendees: (ev.attendees ?? []).length, recurring: Boolean(ev.recurringEventId) },
    },
    { type: 'activity', dedupeKey: `google_meet:${src}:event:${ev.id}:scheduled`.slice(0, 191), activityType: 'scheduled', recordRef: ref, actorRef: personRef(ev.organizer), occurredAt: ev.created ?? timeOf(ev.start) ?? new Date().toISOString(), summary: `${ev.organizer?.displayName ?? ev.organizer?.email ?? 'someone'} scheduled “${ev.summary || '(no title)'}” on Google Meet` },
  ];
}

export function conferenceEnvelopes(src, record, { meetingCode = null, participants = null, transcripts = [] } = {}) {
  const id = String(record.name ?? '').replace(/^conferenceRecords\//, '');
  const ref = { recordType: 'conference', externalId: id };
  const ended = Boolean(record.endTime);
  return [
    {
      type: 'record',
      ...ref,
      externalKey: meetingCode,
      url: meetingCode ? `https://meet.google.com/${meetingCode}` : null,
      title: `Google Meet ${meetingCode ?? id}`,
      body: null,
      state: ended ? 'ended' : 'live',
      statusCategory: ended ? 'done' : 'in_progress',
      sourceCreatedAt: record.startTime ?? null,
      sourceUpdatedAt: record.endTime ?? record.startTime ?? null,
      metadata: { meetCode: meetingCode, start: record.startTime ?? null, end: record.endTime ?? null, participants, transcripts: transcripts.map((t) => ({ state: t.state ?? null, document: t.docsDestination?.exportUri ?? null })) },
    },
    { type: 'activity', dedupeKey: `google_meet:${src}:conference:${id}:conducted`.slice(0, 191), activityType: 'conducted', recordRef: ref, occurredAt: record.startTime ?? new Date().toISOString(), summary: `Google Meet ${meetingCode ?? ''} took place${participants !== null ? ` with ${participants} participant(s)` : ''}`.replace('  ', ' ') },
  ];
}

// ---- sync ---------------------------------------------------------------------------------------

async function syncEvents(ctx, { resource, cursor, phase, since }) {
  const api = calendarApi(ctx);
  const path = `/calendar/v3/calendars/${encodeURIComponent(resource.externalId)}/events`;
  const c = cursor ?? {};
  const base = { maxResults: PAGE, showDeleted: true, singleEvents: true };
  const firstQuery = () => ({ ...base, timeMin: (since ? new Date(since) : new Date(Date.now() - 30 * 86_400_000)).toISOString() });
  let query = c.pageToken ? { ...(c.syncToken ? { ...base, syncToken: c.syncToken } : firstQuery()), pageToken: c.pageToken } : c.syncToken ? { ...base, syncToken: c.syncToken } : firstQuery();
  let res;
  try {
    res = await api.get(path, { query });
  } catch (err) {
    // 410: the sync token expired; start again from the window.
    if (err instanceof ProviderError && err.status === 410) {
      query = firstQuery();
      res = await api.get(path, { query });
    } else throw err;
  }
  const items = res.body?.items ?? [];
  const envelopes = items.flatMap((ev) => eventEnvelopes(source(), resource.externalId, ev));
  if (res.body?.nextPageToken) return { envelopes, cursor: { syncToken: query.syncToken ?? null, pageToken: res.body.nextPageToken }, phase, done: false };
  return { envelopes, cursor: { syncToken: res.body?.nextSyncToken ?? c.syncToken ?? null, pageToken: null }, phase: 'incremental', done: true };
}

async function syncConferences(ctx, { resource, cursor, phase, since }) {
  if (!resource.metadata?.primary) return { envelopes: [], cursor: null, phase: 'incremental', done: true };
  const api = meetApi(ctx);
  const c = { pending: [], ...(cursor ?? {}) };
  if (c.pending.length) {
    const batch = c.pending.slice(0, CONFERENCE_DETAILS_PER_CHUNK);
    const envelopes = [];
    for (const rec of batch) {
      const id = String(rec.name).replace(/^conferenceRecords\//, '');
      let meetingCode = null;
      let participants = null;
      let transcripts = [];
      try {
        if (rec.space) meetingCode = (await api.get(`/v2/${rec.space}`)).body?.meetingCode ?? null;
        participants = (await api.get(`/v2/conferenceRecords/${encodeURIComponent(id)}/participants`, { query: { pageSize: 1 } })).body?.totalSize ?? null;
        transcripts = (await api.get(`/v2/conferenceRecords/${encodeURIComponent(id)}/transcripts`)).body?.transcripts ?? [];
      } catch (err) {
        if (!(err instanceof ProviderError) || !['not_found', 'forbidden'].includes(err.kind)) throw err;
      }
      envelopes.push(...conferenceEnvelopes(source(), rec, { meetingCode, participants: participants === null ? null : Number(participants), transcripts }));
    }
    const pending = c.pending.slice(batch.length);
    if (!pending.length && c.listed) return { envelopes, cursor: { pending: [], watermark: c.nextWatermark ?? c.watermark ?? null }, phase: 'incremental', done: true };
    return { envelopes, cursor: { ...c, pending }, phase, done: false };
  }
  const from = c.watermark ? new Date(Date.parse(c.watermark) - 10 * 60_000) : since ? new Date(since) : new Date(Date.now() - 30 * 86_400_000);
  const res = await api.get('/v2/conferenceRecords', { query: { pageSize: 25, filter: `start_time>="${from.toISOString()}"`, pageToken: c.pageToken ?? undefined } });
  const records = res.body?.conferenceRecords ?? [];
  // Live conferences are revisited next run (their end time changes); finished ones once.
  const pending = [...c.pending, ...records.map((r) => ({ name: r.name, space: r.space, startTime: r.startTime, endTime: r.endTime ?? null }))];
  // Next run starts at the earliest still-live conference (it must be seen again when it ends),
  // otherwise at the latest start seen.
  const maxStart = records.reduce((w, r) => (!w || r.startTime > w ? r.startTime : w), c.maxStart ?? null);
  const liveMin = records.filter((r) => !r.endTime).reduce((w, r) => (!w || r.startTime < w ? r.startTime : w), c.liveMin ?? null);
  const nextWatermark = liveMin ?? maxStart;
  if (res.body?.nextPageToken) return { envelopes: [], cursor: { ...c, pageToken: res.body.nextPageToken, pending, nextWatermark, maxStart, liveMin }, phase, done: false };
  if (pending.length) return { envelopes: [], cursor: { ...c, pageToken: null, pending, nextWatermark, maxStart, liveMin, listed: true }, phase, done: false };
  return { envelopes: [], cursor: { pending: [], watermark: nextWatermark ?? c.watermark ?? null }, phase: 'incremental', done: true };
}

// ---- connector ------------------------------------------------------------------------------------

export const googleMeet = {
  id: 'google_meet',
  displayName: 'Google Meet',
  get sourceInstance() {
    return source();
  },
  capabilities: { install: 'oauth2', webhooks: false, polling: true, credentials: true },
  configProblem,

  beginConnect({ state }) {
    return {
      redirectUrl: authorizeUrl(`${googleSettings.authUrl}/o/oauth2/v2/auth`, {
        clientId: googleSettings.clientId,
        redirectUri: redirectUri(),
        scope: GOOGLE_SCOPES.join(' '),
        state,
        extra: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', hd: googleSettings.domain },
      }),
    };
  },

  async completeConnect(ctx, { params }) {
    const code = codeFrom(params, 'Google');
    const { credentials, scope } = await requestTokens(ctx, { ...tokenOptions(), params: { grant_type: 'authorization_code', code, redirect_uri: redirectUri() } });
    const granted = (scope ?? '').split(/\s+/).filter(Boolean);
    const missing = [CALENDAR_SCOPE, MEET_SCOPE].filter((s) => !granted.includes(s));
    if (missing.length) {
      throw new ProviderError('forbidden', 'Google grant is missing scopes', { publicMessage: 'Google access was only partly granted. Connect again and allow read access to Calendar and Google Meet.' });
    }
    if (!credentials.some((c) => c.kind === 'refresh_token')) {
      throw new ProviderError('invalid_response', 'Google returned no refresh token', { publicMessage: 'Google did not grant offline access; connect again.' });
    }
    const access = credentials.find((c) => c.kind === 'access_token').value;
    const primary = (await ctx.http({ baseUrl: googleSettings.calendarUrl, fetch: googleSettings.fetch, authorize: (h) => h.set('Authorization', `Bearer ${access}`) }).get('/calendar/v3/calendars/primary')).body;
    const email = String(primary?.id ?? '').toLowerCase();
    if (!email.endsWith(`@${googleSettings.domain}`)) {
      throw new ProviderError('forbidden', 'Google account outside the Workspace domain', { publicMessage: `Only accounts of ${googleSettings.domain} can be connected.` });
    }
    return {
      account: { externalAccountId: email, login: email, type: 'user', displayName: `Google Meet · ${email}` },
      settings: { domain: googleSettings.domain, scopes: granted, timeZone: primary.timeZone ?? null, webhooks: false },
      credentials,
    };
  },

  refreshCredentials: (ctx) => refreshTokens(ctx, tokenOptions()),

  async disconnect(ctx) {
    // Google supports revoking the grant: best effort, the stored tokens are deleted regardless.
    const token = await ctx.credentials.peek('refresh_token');
    if (!token) return;
    const url = new URL(googleSettings.tokenUrl);
    await ctx.http({ baseUrl: url.origin, fetch: googleSettings.fetch }).postForm('/revoke', { token }).catch(() => {});
  },

  async listResources(ctx) {
    const api = calendarApi(ctx);
    const out = [];
    let pageToken;
    for (let i = 0; i < 20; i++) {
      const res = await api.get('/calendar/v3/users/me/calendarList', { query: { maxResults: 250, pageToken } });
      for (const cal of res.body?.items ?? []) {
        out.push({ resourceType: 'calendar', externalId: cal.id, name: `Calendar: ${cal.summaryOverride ?? cal.summary ?? cal.id}`.slice(0, 255), metadata: { primary: Boolean(cal.primary), accessRole: cal.accessRole ?? null, timeZone: cal.timeZone ?? null } });
      }
      pageToken = res.body?.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },

  async health(ctx) {
    await calendarApi(ctx).get('/calendar/v3/calendars/primary');
    return { status: 'healthy' };
  },

  streams: () => ['events', 'conferences'],
  syncStream(ctx, args) {
    if (args.stream === 'events') return syncEvents(ctx, args);
    if (args.stream === 'conferences') return syncConferences(ctx, args);
    throw new ProviderError('invalid_request', `Unknown Google Meet stream ${args.stream}`);
  },
};

export default googleMeet;
