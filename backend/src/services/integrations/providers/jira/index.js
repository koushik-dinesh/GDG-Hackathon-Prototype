// Jira Cloud connector, implementing the Phase 3A contract with an OAuth 2.0 (3LO) app.
//
// Connect: the admin consents on Atlassian (scopes read:jira-work read:jira-user offline_access);
// the setup page posts the code back; completeConnect exchanges it and checks that the grant covers
// the configured site (JIRA_SITE_URL). One site per deployment: the connection's account id is the
// site host and its cloud id is kept in settings.
// Tokens: access tokens last 1 h; refresh tokens rotate on every refresh (stored with the new
// access token). Atlassian has no revocation endpoint for 3LO grants: disconnecting deletes the
// stored tokens, and an admin removes the app from their Atlassian account settings.
// Sync: one stream per project, JQL ordered by `updated`, resumable by page token. Webhooks: an
// admin-registered Jira webhook signed with JIRA_WEBHOOK_SECRET (X-Hub-Signature: sha256=...).
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../../errors.js';
import { authorizeUrl, bearerClient, codeFrom, refreshTokens, requestTokens } from '../oauth2.js';
import { commentEnvelopes, issueEnvelopes, resourceOf, userRef } from './mappers.js';
import { jiraConfigProblem, settings, sourceInstanceOf } from './settings.js';

export const SCOPES = 'read:jira-work read:jira-user offline_access';
export const STREAMS = ['issues'];
const PAGE_SIZE = 50;
const COMMENTS_PER_CHUNK = 5;
const OVERLAP_MS = 5 * 60 * 1000;
const ISSUE_FIELDS = 'summary,status,assignee,reporter,creator,priority,issuetype,created,updated,duedate,labels,description,parent,subtasks,issuelinks,resolution,resolutiondate,comment,project';

const source = () => sourceInstanceOf(settings.siteUrl);
const tokenOptions = () => ({ tokenUrl: `${settings.authUrl}/oauth/token`, fetch: settings.fetch, format: 'json', clientId: settings.clientId, clientSecret: settings.clientSecret, providerName: 'Jira' });
const cloudIdOf = (ctx) => {
  const id = ctx.connection.settings?.cloudId;
  if (!id || !/^[0-9a-f-]{8,64}$/i.test(id)) throw new ProviderError('auth', 'Jira connection has no cloud id', { publicMessage: 'Connect Jira again' });
  return id;
};

/** Jira REST v3 for the connected site, through api.atlassian.com. */
function jiraApi(ctx) {
  const client = bearerClient(ctx, { baseUrl: settings.apiUrl, fetch: settings.fetch, providerName: 'Jira' });
  const base = `/ex/jira/${cloudIdOf(ctx)}/rest/api/3`;
  return { get: (path, opts) => client.get(`${base}${path}`, opts) };
}

/** "yyyy-MM-dd HH:mm" in the API user's time zone, which is how JQL reads dates. */
export function jqlTime(date, timeZone = 'UTC') {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(date))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

const quoteJql = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
const maxIso = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

async function syncIssues(ctx, { resource, cursor, phase, since }) {
  const api = jiraApi(ctx);
  let c = cursor ?? { pass: phase === 'backfill' ? 'open' : 'recent', pageToken: null, pendingComments: [] };
  c = { pendingComments: [], ...c };
  const site = settings.siteUrl;

  // Issues with more comments than the search returned: fetch the rest, a few per chunk.
  if (c.pendingComments.length) {
    const batch = c.pendingComments.slice(0, COMMENTS_PER_CHUNK);
    const envelopes = [];
    for (const { id, key } of batch) {
      try {
        let startAt = 0;
        for (let page = 0; page < 20; page++) {
          const res = await api.get(`/issue/${encodeURIComponent(id)}/comment`, { query: { startAt, maxResults: 100 } });
          for (const cm of res.body?.comments ?? []) envelopes.push(...commentEnvelopes(source(), site, { id, key }, cm));
          startAt += res.body?.comments?.length ?? 0;
          if (!res.body?.comments?.length || startAt >= (res.body?.total ?? 0)) break;
        }
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err; // deleted meanwhile
      }
    }
    const pendingComments = c.pendingComments.slice(batch.length);
    if (!pendingComments.length && c.listed) return { envelopes, ...finish(c) };
    return { envelopes, cursor: { ...c, pendingComments }, phase, done: false };
  }

  if (!c.timeZone) c = { ...c, timeZone: (await api.get('/myself')).body?.timeZone || 'UTC' };
  if (c.pass === 'recent' && !c.pageToken && !c.runSince) {
    const start = c.watermark ? new Date(Date.parse(c.watermark) - OVERLAP_MS) : since ? new Date(since) : null;
    c = { ...c, runSince: start ? start.toISOString() : null };
  }
  const project = `project = ${quoteJql(resource.metadata?.key ?? resource.name)}`;
  const jql =
    c.pass === 'open'
      ? `${project} AND statusCategory != Done ORDER BY updated ASC`
      : `${project}${c.runSince ? ` AND updated >= ${quoteJql(jqlTime(c.runSince, c.timeZone))}` : ''} ORDER BY updated ASC`;
  const res = await api.get('/search/jql', { query: { jql, fields: ISSUE_FIELDS, maxResults: PAGE_SIZE, nextPageToken: c.pageToken ?? undefined } });
  const issues = res.body?.issues ?? [];
  const envelopes = issues.flatMap((i) => issueEnvelopes(source(), site, i));
  const more = issues.filter((i) => (i.fields?.comment?.total ?? 0) > (i.fields?.comment?.comments?.length ?? 0)).map((i) => ({ id: String(i.id), key: i.key }));
  const pendingComments = [...c.pendingComments, ...more.filter((m) => !c.pendingComments.some((p) => p.id === m.id))];
  const nextWatermark = issues.reduce((w, i) => maxIso(w, i.fields?.updated ? new Date(i.fields.updated).toISOString() : null), c.nextWatermark ?? null);

  if (res.body?.nextPageToken && !res.body?.isLast) return { envelopes, cursor: { ...c, pageToken: res.body.nextPageToken, pendingComments, nextWatermark }, phase, done: false };
  if (c.pass === 'open') {
    const start = since ? new Date(since).toISOString() : null;
    return { envelopes, cursor: { ...c, pass: 'recent', pageToken: null, runSince: start, pendingComments, nextWatermark }, phase, done: false };
  }
  if (pendingComments.length) return { envelopes, cursor: { ...c, pageToken: null, pendingComments, nextWatermark, listed: true }, phase, done: false };
  return { envelopes, ...finish({ ...c, nextWatermark }) };
}

function finish(c) {
  return {
    cursor: { pass: 'recent', pageToken: null, runSince: null, pendingComments: [], timeZone: c.timeZone, watermark: maxIso(c.watermark, c.nextWatermark) ?? null, nextWatermark: null },
    phase: 'incremental',
    done: true,
  };
}

// ---- webhooks ---------------------------------------------------------------------------------

export const SUPPORTED_EVENTS = ['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted', 'comment_created', 'comment_updated', 'comment_deleted'];

const header = (headers, name) => {
  if (typeof headers?.get === 'function') return headers.get(name);
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name);
  const v = key ? headers[key] : null;
  return Array.isArray(v) ? v[0] : v;
};

export const signatureFor = (secret, rawBody) => `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;

function verifyWebhook({ headers, rawBody }) {
  if (!settings.webhookSecret || !Buffer.isBuffer(rawBody)) return false; // polling only without a secret
  const given = header(headers, 'x-hub-signature');
  if (typeof given !== 'string' || !given.startsWith('sha256=')) return false;
  const expected = Buffer.from(signatureFor(settings.webhookSecret, rawBody));
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function parseWebhook({ headers, body }) {
  const deliveryId = header(headers, 'x-atlassian-webhook-identifier');
  const eventType = body?.webhookEvent;
  if (!deliveryId || typeof eventType !== 'string') throw new ProviderError('invalid_request', 'Jira webhook without identifier or event');
  // Jira webhooks come from the configured site; the connection's account id is that site's host.
  return { deliveryId: String(deliveryId), eventType, action: body.issue_event_type_name ?? null, externalAccountId: source() };
}

function handleWebhook(delivery) {
  const body = delivery.payload ?? {};
  const issue = body.issue;
  if (!SUPPORTED_EVENTS.includes(delivery.eventType) || !issue?.id) return { envelopes: [] };
  const projectId = issue.fields?.project?.id;
  const resourceRef = projectId ? { resourceType: 'project', externalId: String(projectId) } : undefined;
  const site = settings.siteUrl;
  const src = source();
  let envelopes;
  switch (delivery.eventType) {
    case 'jira:issue_created':
    case 'jira:issue_updated': {
      envelopes = issueEnvelopes(src, site, issue, { withComments: false });
      // Assignment changes carry their own event (status changes are derived by ingest).
      for (const item of body.changelog?.items ?? []) {
        if (item.field === 'assignee' && body.changelog.id) {
          envelopes.push({
            type: 'activity',
            dedupeKey: `jira:${src}:changelog:${body.changelog.id}:assignee`,
            activityType: item.to ? 'assigned' : 'unassigned',
            recordRef: { recordType: 'issue', externalId: String(issue.id) },
            actorRef: userRef(body.user),
            occurredAt: new Date(body.timestamp ?? Date.now()).toISOString(),
            summary: item.to ? `${body.user?.displayName ?? 'someone'} assigned ${issue.key} to ${item.toString ?? 'someone'}` : `${body.user?.displayName ?? 'someone'} unassigned ${issue.key}`,
          });
        }
      }
      break;
    }
    case 'jira:issue_deleted':
      envelopes = issueEnvelopes(src, site, issue, { withComments: false }).map((e) => (e.type === 'record' ? { ...e, deleted: true } : e));
      break;
    case 'comment_created':
    case 'comment_updated':
    case 'comment_deleted':
      if (!body.comment?.id) return { envelopes: [] };
      envelopes = commentEnvelopes(src, site, issue, body.comment).map((e) => (e.type === 'record' && delivery.eventType === 'comment_deleted' ? { ...e, deleted: true } : e));
      break;
    default:
      envelopes = [];
  }
  return { envelopes, resourceRef };
}

// ---- connector --------------------------------------------------------------------------------

export const jira = {
  id: 'jira',
  displayName: 'Jira',
  get sourceInstance() {
    return source();
  },
  capabilities: { install: 'oauth2', webhooks: true, polling: true, credentials: true },

  configProblem: jiraConfigProblem,

  beginConnect({ state }) {
    return {
      redirectUrl: authorizeUrl(`${settings.authUrl}/authorize`, {
        clientId: settings.clientId,
        redirectUri: settings.redirectUri,
        scope: SCOPES,
        state,
        extra: { audience: 'api.atlassian.com', prompt: 'consent' },
      }),
    };
  },

  async completeConnect(ctx, { params }) {
    const code = codeFrom(params, 'Jira');
    const { credentials } = await requestTokens(ctx, { ...tokenOptions(), params: { grant_type: 'authorization_code', code, redirect_uri: settings.redirectUri } });
    const access = credentials.find((c) => c.kind === 'access_token').value;
    const res = await ctx
      .http({ baseUrl: settings.apiUrl, fetch: settings.fetch, authorize: (h) => h.set('Authorization', `Bearer ${access}`) })
      .get('/oauth/token/accessible-resources');
    const site = (res.body ?? []).find((r) => String(r.url ?? '').replace(/\/+$/, '') === settings.siteUrl);
    if (!site) {
      throw new ProviderError('forbidden', 'Jira grant does not include the configured site', {
        publicMessage: `Access was granted, but not to ${settings.siteUrl}. Connect again and choose that site on the Atlassian consent screen.`,
      });
    }
    if (!(site.scopes ?? []).includes('read:jira-work')) {
      throw new ProviderError('forbidden', 'Jira grant lacks read:jira-work', { publicMessage: 'WorkAgent needs permission to read Jira work items; connect again and accept all requested permissions.' });
    }
    if (!credentials.some((c) => c.kind === 'refresh_token')) {
      throw new ProviderError('invalid_response', 'Jira returned no refresh token', { publicMessage: 'Jira did not grant offline access; connect again and accept all requested permissions.' });
    }
    return {
      account: { externalAccountId: source(), login: site.name ?? null, type: 'site', displayName: `Jira · ${site.name ?? source()}` },
      settings: { cloudId: site.id, siteUrl: settings.siteUrl, siteName: site.name ?? null, scopes: site.scopes ?? [], webhooks: Boolean(settings.webhookSecret) },
      credentials,
    };
  },

  refreshCredentials(ctx) {
    return refreshTokens(ctx, tokenOptions());
  },

  async disconnect() {
    // Nothing to call: 3LO grants are revoked by the user at id.atlassian.com (runbook §11).
  },

  async listResources(ctx) {
    const api = jiraApi(ctx);
    const out = [];
    let startAt = 0;
    for (let page = 0; page < 100; page++) {
      const res = await api.get('/project/search', { query: { startAt, maxResults: 50, orderBy: 'key' } });
      const values = res.body?.values ?? [];
      out.push(...values.map((p) => resourceOf(settings.siteUrl, p)));
      startAt += values.length;
      if (res.body?.isLast !== false || !values.length) break;
    }
    return out;
  },

  async health(ctx) {
    await jiraApi(ctx).get('/myself');
    return { status: 'healthy' };
  },

  streams: () => STREAMS,

  syncStream(ctx, args) {
    if (args.stream !== 'issues') throw new ProviderError('invalid_request', `Unknown Jira stream ${args.stream}`);
    return syncIssues(ctx, args);
  },

  verifyWebhook,
  parseWebhook,

  async handleWebhook(_ctx, delivery) {
    return handleWebhook(delivery);
  },
};

export default jira;
