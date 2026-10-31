// Figma connector, OAuth 2.0 (Figma REST API v1, webhooks v2).
//
// One Figma team per deployment (FIGMA_TEAM_ID): the connection's account id is that team, and
// the person who connects must be able to read it. Resources: the team's projects.
// Records per project: design_file (name, last modified, thumbnail, link), its comments and its
// named/autosaved versions (children of the file). Files are revisited only when their
// last_modified moved past the stored watermark. Comments mentioning PAY-42 or acme/api#12 feed
// relationship suggestions.
// Webhooks (optional): registered for the team with FIGMA_WEBHOOK_PASSCODE; Figma puts the
// passcode in every payload (there is no signature header), compared in constant time. Because
// the payload itself is not signed, a webhook is only a nudge: WorkAgent takes the file key from
// it and re-reads the file, its comments and versions (or confirms its deletion) from the API.
// Deleted files are also detected by sync (files that disappear from a project and are gone).
// Tokens: access tokens expire (~90 days) and are refreshed with the refresh token, which Figma
// does not rotate. Figma has no token revocation endpoint (runbook §14).
import { timingSafeEqual } from 'node:crypto';
import { config } from '../../../../config/index.js';
import { ProviderError } from '../../errors.js';
import { authorizeUrl, bearerClient, codeFrom, refreshTokens, requestTokens } from '../oauth2.js';

export const FIGMA_SCOPES = ['current_user:read', 'file_content:read', 'file_metadata:read', 'file_comments:read', 'file_versions:read', 'projects:read'];
const FILES_PER_CHUNK = 5;
const SOURCE = 'figma.com';
// fileKey -> { projectId, at }: process-local, filled by sync and webhook lookups (10 minutes).
const projectOfFile = new Map();

const fromConfig = () => ({ ...config.figma, appPublicUrl: config.email.appPublicUrl, fetch: undefined });
export const figmaSettings = fromConfig();
export const configureFigma = (o) => Object.assign(figmaSettings, o);
export function resetFigmaSettings() {
  for (const k of Object.keys(figmaSettings)) delete figmaSettings[k];
  Object.assign(figmaSettings, fromConfig());
}

function configProblem() {
  if (!figmaSettings.clientId) return 'FIGMA_CLIENT_ID is not set';
  if (!figmaSettings.clientSecret) return 'FIGMA_CLIENT_SECRET is not set';
  if (!figmaSettings.teamId) return 'FIGMA_TEAM_ID is not set';
  if (!figmaSettings.appPublicUrl) return 'APP_PUBLIC_URL is not set (needed for the OAuth redirect)';
  return null;
}

const redirectUri = () => `${figmaSettings.appPublicUrl}/integrations/figma/setup`;
// Figma's token endpoint takes the client credentials as HTTP Basic auth.
const tokenOptions = (path) => ({ tokenUrl: `${figmaSettings.apiUrl}${path}`, fetch: figmaSettings.fetch, format: 'form', clientId: figmaSettings.clientId, clientSecret: figmaSettings.clientSecret, basicAuth: true, providerName: 'Figma' });

function classify({ status, body, rateLimit }) {
  if (status === 429) return new ProviderError('rate_limited', 'Figma rate limit', { status, retryAfterMs: rateLimit.retryAfterMs ?? 60_000 });
  // Figma answers an invalid or expired token with 403 "Invalid token": refresh and retry once.
  if (status === 403 && /token/i.test(String(body?.err ?? body?.message ?? ''))) return new ProviderError('auth', 'Figma token rejected', { status });
  return null;
}
const api = (ctx) => bearerClient(ctx, { baseUrl: figmaSettings.apiUrl, fetch: figmaSettings.fetch, classify, providerName: 'Figma' });

// ---- mapping --------------------------------------------------------------------------------------

const personOf = (u) => (u?.id ? [{ type: 'identity', externalUserId: String(u.id), login: u.handle ?? null, displayName: u.handle ?? null, email: u.email || null, isBot: false }] : []);
const personRef = (u) => (u?.id ? { externalUserId: String(u.id) } : null);
const fileUrl = (key) => `https://www.figma.com/design/${encodeURIComponent(key)}`;

export function fileEnvelopes(file, projectId) {
  const ref = { recordType: 'design_file', externalId: file.key };
  return [
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: fileUrl(file.key),
      title: file.name || 'Untitled',
      body: null,
      state: null,
      statusCategory: 'unknown',
      sourceUpdatedAt: file.last_modified ?? null,
      metadata: { projectId: projectId ? String(projectId) : null, thumbnail: file.thumbnail_url ?? null, lastModified: file.last_modified ?? null },
    },
  ];
}

export function commentEnvelopes(fileKey, c) {
  const ref = { recordType: 'comment', externalId: String(c.id) };
  return [
    ...personOf(c.user),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: `${fileUrl(fileKey)}?comment-id=${encodeURIComponent(c.id)}`,
      title: `Comment on a Figma file`,
      body: c.message ?? null,
      state: c.resolved_at ? 'resolved' : 'open',
      statusCategory: c.resolved_at ? 'done' : 'todo',
      authorRef: personRef(c.user),
      parentRef: { recordType: 'design_file', externalId: fileKey },
      sourceCreatedAt: c.created_at ?? null,
      sourceUpdatedAt: c.resolved_at ?? c.created_at ?? null,
      metadata: { replyTo: c.parent_id || null, resolvedAt: c.resolved_at ?? null },
    },
    { type: 'activity', dedupeKey: `figma:${SOURCE}:comment:${c.id}:created`, activityType: 'commented', recordRef: ref, actorRef: personRef(c.user), occurredAt: c.created_at ?? new Date().toISOString(), summary: `${c.user?.handle ?? 'someone'} commented in Figma` },
  ];
}

export function versionEnvelopes(fileKey, v) {
  const ref = { recordType: 'version', externalId: `${fileKey}/${v.id}` };
  const label = v.label || 'Autosave';
  return [
    ...personOf(v.user),
    {
      type: 'record',
      ...ref,
      externalKey: null,
      url: `${fileUrl(fileKey)}?version-id=${encodeURIComponent(v.id)}`,
      title: label,
      body: v.description || null,
      state: v.label ? 'named' : 'autosave',
      statusCategory: 'unknown',
      authorRef: personRef(v.user),
      parentRef: { recordType: 'design_file', externalId: fileKey },
      sourceCreatedAt: v.created_at ?? null,
      sourceUpdatedAt: v.created_at ?? null,
      metadata: { versionId: String(v.id) },
    },
    // Only named versions are worth a timeline entry; autosaves happen every few minutes.
    ...(v.label ? [{ type: 'activity', dedupeKey: `figma:${SOURCE}:version:${fileKey}/${v.id}`, activityType: 'updated', recordRef: ref, actorRef: personRef(v.user), occurredAt: v.created_at ?? new Date().toISOString(), summary: `${v.user?.handle ?? 'someone'} saved version “${label}” in Figma` }] : []),
  ];
}

async function fileDetails(client, fileKey) {
  const envelopes = [];
  const comments = (await client.get(`/v1/files/${encodeURIComponent(fileKey)}/comments`)).body?.comments ?? [];
  for (const c of comments) envelopes.push(...commentEnvelopes(fileKey, c));
  const versions = (await client.get(`/v1/files/${encodeURIComponent(fileKey)}/versions`, { query: { page_size: 50 } })).body?.versions ?? [];
  for (const v of versions) envelopes.push(...versionEnvelopes(fileKey, v));
  return envelopes;
}

/** Whether a file is gone at Figma (its versions endpoint answers 404). */
async function isGone(client, key) {
  try {
    await client.get(`/v1/files/${encodeURIComponent(key)}/versions`, { query: { page_size: 1 } });
    return false;
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'not_found') return true;
    throw err;
  }
}

const tombstone = (key) => ({ type: 'record', recordType: 'design_file', externalId: key, title: null, body: null, deleted: true });

async function syncFiles(ctx, { resource, cursor, phase, since }) {
  const client = api(ctx);
  const c = { pending: [], known: [], ...(cursor ?? {}) };
  if (c.pending.length) {
    const batch = c.pending.slice(0, FILES_PER_CHUNK);
    const envelopes = [];
    for (const key of batch) {
      try {
        envelopes.push(...(await fileDetails(client, key)));
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== 'not_found') throw err; // deleted meanwhile
      }
    }
    const pending = c.pending.slice(batch.length);
    if (!pending.length) return { envelopes, cursor: { pending: [], known: c.known, watermark: c.nextWatermark ?? c.watermark ?? null }, phase: 'incremental', done: true };
    return { envelopes, cursor: { ...c, pending }, phase, done: false };
  }
  const files = (await client.get(`/v1/projects/${encodeURIComponent(resource.externalId)}/files`)).body?.files ?? [];
  const listed = new Set(files.map((f) => f.key));
  for (const key of listed) projectOfFile.set(key, { projectId: String(resource.externalId), at: Date.now() });
  // Files that left the project: deleted ones become tombstones; moved ones are left alone.
  const envelopes = [];
  for (const key of c.known.filter((k) => !listed.has(k)).slice(0, 20)) if (await isGone(client, key)) envelopes.push(tombstone(key));
  const from = c.watermark ?? (since ? new Date(since).toISOString() : null);
  const changed = files.filter((f) => !from || (f.last_modified && f.last_modified > from));
  envelopes.push(...changed.flatMap((f) => fileEnvelopes(f, resource.externalId)));
  const nextWatermark = changed.reduce((w, f) => (!w || f.last_modified > w ? f.last_modified : w), c.watermark ?? null);
  const pending = changed.map((f) => f.key);
  const known = [...listed].slice(0, 2000);
  if (!pending.length) return { envelopes, cursor: { pending: [], known, watermark: nextWatermark }, phase: 'incremental', done: true };
  return { envelopes, cursor: { pending, known, watermark: c.watermark ?? null, nextWatermark }, phase, done: false };
}

// ---- webhooks -----------------------------------------------------------------------------------

export const FIGMA_EVENTS = ['FILE_UPDATE', 'FILE_VERSION_UPDATE', 'FILE_COMMENT', 'FILE_DELETE', 'PING'];

/** The file's project and its current listing entry, read from the API (cached 10 minutes). */
async function findFile(client, fileKey) {
  const hit = projectOfFile.get(fileKey);
  const lookIn = async (projectId) => ((await client.get(`/v1/projects/${encodeURIComponent(projectId)}/files`)).body?.files ?? []).find((f) => f.key === fileKey);
  if (hit && Date.now() - hit.at < 600_000) {
    const f = await lookIn(hit.projectId);
    if (f) return { projectId: hit.projectId, file: f };
  }
  const projects = (await client.get(`/v1/teams/${encodeURIComponent(figmaSettings.teamId)}/projects`)).body?.projects ?? [];
  for (const p of projects) {
    const files = (await client.get(`/v1/projects/${encodeURIComponent(p.id)}/files`)).body?.files ?? [];
    for (const f of files) projectOfFile.set(f.key, { projectId: String(p.id), at: Date.now() });
    const f = files.find((x) => x.key === fileKey);
    if (f) return { projectId: String(p.id), file: f };
  }
  return { projectId: hit?.projectId ?? null, file: null };
}

function verifyWebhook({ rawBody }) {
  if (!figmaSettings.webhookPasscode || !Buffer.isBuffer(rawBody)) return false;
  let passcode;
  try {
    passcode = JSON.parse(rawBody.toString('utf8'))?.passcode;
  } catch {
    return false;
  }
  if (typeof passcode !== 'string') return false;
  const a = Buffer.from(passcode);
  const b = Buffer.from(figmaSettings.webhookPasscode);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseWebhook({ body }) {
  if (!FIGMA_EVENTS.includes(body?.event_type) || !body.webhook_id) throw new ProviderError('invalid_request', 'Not a Figma webhook');
  const distinct = body.comment_id ?? body.version_id ?? body.timestamp ?? '';
  return { deliveryId: `${body.webhook_id}:${body.event_type}:${body.file_key ?? ''}:${distinct}`, eventType: body.event_type, action: null, externalAccountId: figmaSettings.teamId ?? null };
}

async function handleWebhook(ctx, delivery) {
  const body = delivery.payload ?? {};
  const key = typeof body.file_key === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.file_key) ? body.file_key : null;
  if (body.event_type === 'PING' || !key) return { envelopes: [] };
  const client = api(ctx);
  // Only the file key comes from the (unsigned) payload; everything else is read from Figma.
  const { projectId, file } = await findFile(client, key);
  if (!file) {
    // Not listed any more: if Figma confirms it is gone and its project is known, mark it deleted;
    // otherwise sync handles it (it compares project listings).
    if (projectId && (await isGone(client, key))) return { envelopes: [tombstone(key)], resourceRef: { resourceType: 'project', externalId: projectId } };
    return { envelopes: [] };
  }
  return { envelopes: [...fileEnvelopes(file, projectId), ...(await fileDetails(client, key))], resourceRef: { resourceType: 'project', externalId: projectId } };
}

// ---- connector ------------------------------------------------------------------------------------

export const figma = {
  id: 'figma',
  displayName: 'Figma',
  sourceInstance: SOURCE,
  capabilities: { install: 'oauth2', webhooks: true, polling: true, credentials: true },
  configProblem,

  beginConnect({ state }) {
    return { redirectUrl: authorizeUrl(`${figmaSettings.authUrl}/oauth`, { clientId: figmaSettings.clientId, redirectUri: redirectUri(), scope: FIGMA_SCOPES.join(' '), state }) };
  },

  async completeConnect(ctx, { params }) {
    const code = codeFrom(params, 'Figma');
    const { credentials } = await requestTokens(ctx, { ...tokenOptions('/v1/oauth/token'), params: { grant_type: 'authorization_code', code, redirect_uri: redirectUri() } });
    if (!credentials.some((c) => c.kind === 'refresh_token')) throw new ProviderError('invalid_response', 'Figma returned no refresh token');
    const access = credentials.find((c) => c.kind === 'access_token').value;
    const client = ctx.http({ baseUrl: figmaSettings.apiUrl, fetch: figmaSettings.fetch, authorize: (h) => h.set('Authorization', `Bearer ${access}`) });
    const me = (await client.get('/v1/me')).body;
    try {
      await client.get(`/v1/teams/${encodeURIComponent(figmaSettings.teamId)}/projects`);
    } catch (err) {
      if (err instanceof ProviderError && ['forbidden', 'not_found'].includes(err.kind)) {
        throw new ProviderError('forbidden', 'Figma account cannot read the configured team', { publicMessage: `This Figma account cannot see team ${figmaSettings.teamId}. Connect with a member of that team.` });
      }
      throw err;
    }
    return {
      account: { externalAccountId: String(figmaSettings.teamId), login: me?.handle ?? null, type: 'team', displayName: `Figma · team ${figmaSettings.teamId}` },
      settings: { teamId: figmaSettings.teamId, connectedAs: me?.handle ?? null, scopes: FIGMA_SCOPES, webhooks: Boolean(figmaSettings.webhookPasscode) },
      credentials,
    };
  },

  refreshCredentials: (ctx) => refreshTokens(ctx, tokenOptions('/v1/oauth/refresh')),
  async disconnect() {},

  async listResources(ctx) {
    const projects = (await api(ctx).get(`/v1/teams/${encodeURIComponent(figmaSettings.teamId)}/projects`)).body?.projects ?? [];
    return projects.map((p) => ({ resourceType: 'project', externalId: String(p.id), name: p.name, url: `https://www.figma.com/files/project/${p.id}`, metadata: { teamId: figmaSettings.teamId } }));
  },

  async health(ctx) {
    await api(ctx).get('/v1/me');
    return { status: 'healthy' };
  },

  streams: () => ['files'],
  syncStream(ctx, args) {
    if (args.stream !== 'files') throw new ProviderError('invalid_request', `Unknown Figma stream ${args.stream}`);
    return syncFiles(ctx, args);
  },

  verifyWebhook,
  parseWebhook,
  handleWebhook,
};

export default figma;
