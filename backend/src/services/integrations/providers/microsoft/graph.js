// Microsoft Graph access shared by the Teams and Outlook connectors: one single-tenant Entra app
// (MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID), delegated OAuth 2.0 with offline access.
// Each connection is one Microsoft account of the tenant; the authorize and token endpoints are
// the tenant's own, so accounts from other tenants cannot connect.
//
// Sync uses Graph delta queries: a run follows @odata.nextLink pages and ends with an
// @odata.deltaLink, which the next run starts from; deletions arrive as "@removed" items.
// Change notifications (Graph subscriptions) are not used yet: they need a validation handshake
// and renewals every few days; scheduled delta sync covers changes instead (runbook §12).
//
// SSRF: requests only go to MS_LOGIN_URL (tokens) and MS_GRAPH_URL; delta and next links are
// absolute Graph URLs and the HTTP client refuses any other origin.
import { config } from '../../../../config/index.js';
import { ProviderError } from '../../errors.js';
import { authorizeUrl, bearerClient, codeFrom, refreshTokens, requestTokens } from '../oauth2.js';

const fromConfig = () => ({
  clientId: config.microsoft.clientId,
  clientSecret: config.microsoft.clientSecret,
  tenantId: config.microsoft.tenantId,
  loginUrl: config.microsoft.loginUrl,
  graphUrl: config.microsoft.graphUrl,
  appPublicUrl: config.email.appPublicUrl,
  fetch: undefined,
});

export const msSettings = fromConfig();

export function configureMicrosoft(overrides) {
  Object.assign(msSettings, overrides);
}

export function resetMicrosoftSettings() {
  for (const key of Object.keys(msSettings)) delete msSettings[key];
  Object.assign(msSettings, fromConfig());
}

export function microsoftConfigProblem() {
  if (!msSettings.clientId) return 'MS_CLIENT_ID is not set';
  if (!msSettings.clientSecret) return 'MS_CLIENT_SECRET is not set';
  if (!msSettings.tenantId) return 'MS_TENANT_ID is not set';
  if (!msSettings.appPublicUrl) return 'APP_PUBLIC_URL is not set (needed for the OAuth redirect)';
  return null;
}

/** source_instance: the tenant (records and people are unique within it). */
export const tenantInstance = () => (msSettings.tenantId ? `microsoft:${msSettings.tenantId}` : 'microsoft.unconfigured');
export const redirectUriFor = (providerId) => `${msSettings.appPublicUrl}/integrations/${providerId}/setup`;

const tokenOptions = () => ({
  tokenUrl: `${msSettings.loginUrl}/${msSettings.tenantId}/oauth2/v2.0/token`,
  fetch: msSettings.fetch,
  format: 'form',
  clientId: msSettings.clientId,
  clientSecret: msSettings.clientSecret,
  providerName: 'Microsoft 365',
});

export function beginMicrosoftConnect(providerId, scopes, state) {
  return {
    redirectUrl: authorizeUrl(`${msSettings.loginUrl}/${msSettings.tenantId}/oauth2/v2.0/authorize`, {
      clientId: msSettings.clientId,
      redirectUri: redirectUriFor(providerId),
      scope: scopes.join(' '),
      state,
      extra: { response_mode: 'query', prompt: 'select_account' },
    }),
  };
}

/** Exchanges the code, reads the signed-in account, and checks the granted scopes. */
export async function completeMicrosoftConnect(ctx, { providerId, params, scopes, label }) {
  const code = codeFrom(params, 'Microsoft 365');
  const { credentials, scope } = await requestTokens(ctx, {
    ...tokenOptions(),
    params: { grant_type: 'authorization_code', code, redirect_uri: redirectUriFor(providerId), scope: scopes.join(' ') },
  });
  const granted = (scope ?? '').split(/\s+/).map((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '')).filter(Boolean);
  const missing = scopes.filter((s) => s !== 'offline_access' && !granted.some((g) => g.toLowerCase() === s.toLowerCase()));
  if (missing.length) {
    throw new ProviderError('forbidden', `Microsoft grant lacks ${missing.join(', ')}`, {
      publicMessage: `Microsoft 365 did not grant ${missing.join(', ')}. An administrator may need to grant admin consent for the app in Entra.`,
    });
  }
  if (!credentials.some((c) => c.kind === 'refresh_token')) {
    throw new ProviderError('invalid_response', 'Microsoft returned no refresh token', { publicMessage: 'Microsoft 365 did not grant offline access; connect again.' });
  }
  const access = credentials.find((c) => c.kind === 'access_token').value;
  const me = (await ctx.http({ baseUrl: msSettings.graphUrl, fetch: msSettings.fetch, authorize: (h) => h.set('Authorization', `Bearer ${access}`) }).get('/v1.0/me', { query: { $select: 'id,displayName,userPrincipalName,mail' } })).body;
  if (!me?.id) throw new ProviderError('invalid_response', 'Microsoft Graph returned no account');
  return {
    account: { externalAccountId: me.id, login: me.userPrincipalName ?? me.mail ?? null, type: 'user', displayName: `${label} · ${me.displayName ?? me.userPrincipalName ?? me.id}` },
    settings: { tenantId: msSettings.tenantId, userPrincipalName: me.userPrincipalName ?? null, scopes: granted, webhooks: false },
    credentials,
  };
}

export const refreshMicrosoftTokens = (ctx, scopes) => refreshTokens(ctx, { ...tokenOptions(), params: { scope: scopes.join(' ') } });

/** Graph classification: 429/503 carry Retry-After; 403 on a resource is a missing permission. */
function classify({ status, rateLimit }) {
  if (status === 429 || (status === 503 && rateLimit.retryAfterMs !== null)) {
    return new ProviderError('rate_limited', `Microsoft Graph throttled (${status})`, { status, retryAfterMs: rateLimit.retryAfterMs ?? 30_000 });
  }
  return null;
}

export function graphClient(ctx) {
  return bearerClient(ctx, { baseUrl: msSettings.graphUrl, fetch: msSettings.fetch, classify, providerName: 'Microsoft 365', defaultHeaders: { Prefer: 'odata.maxpagesize=50' } });
}

/** Follows @odata.nextLink pages of a plain (non-delta) list. */
export async function listAll(api, path, query, maxPages = 50) {
  const out = [];
  let next = path;
  let q = query;
  for (let page = 0; next && page < maxPages; page++) {
    const res = await api.get(next, { query: q });
    out.push(...(res.body?.value ?? []));
    next = res.body?.['@odata.nextLink'] ?? null;
    q = undefined;
  }
  return out;
}

/**
 * One page of a delta query. cursor { next } continues a run, { delta } starts the next run from
 * the last deltaLink; otherwise `start(query)` gives the first request. Returns the items and the
 * cursor to store, with done=true when the run reached its deltaLink.
 */
export async function deltaPage(api, cursor, start) {
  const target = cursor?.next ?? cursor?.delta ?? null;
  let res;
  try {
    res = target ? await api.get(target) : await api.get(start.path, { query: start.query });
  } catch (err) {
    // An expired delta token (410 Gone / syncStateNotFound): start a fresh run from the window.
    if (err instanceof ProviderError && err.kind === 'not_found' && target && !cursor?.next) {
      res = await api.get(start.path, { query: start.query });
    } else throw err;
  }
  const items = res.body?.value ?? [];
  const next = res.body?.['@odata.nextLink'] ?? null;
  const delta = res.body?.['@odata.deltaLink'] ?? null;
  if (next) return { items, cursor: { next, delta: cursor?.delta ?? null }, done: false };
  return { items, cursor: { next: null, delta: delta ?? cursor?.delta ?? null }, done: true };
}

/** Plain text from Graph HTML bodies (Teams messages). */
export function htmlToText(html) {
  if (!html) return null;
  const text = String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text || null;
}
