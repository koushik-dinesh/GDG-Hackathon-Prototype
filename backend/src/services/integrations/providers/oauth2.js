// OAuth 2.0 authorization-code helpers shared by the OAuth connectors (Jira, Microsoft, Google,
// Figma). The framework's vault stores the two credentials this produces:
//   access_token   short-lived, with expiresAt; refreshed by the connector's refreshCredentials()
//   refresh_token  long-lived; providers that rotate it (Atlassian, Figma) return a new one each
//                  refresh, and the vault stores it in the same write as the access token
// Tokens and client secrets are never logged and never appear in error messages.
import { ProviderError } from '../errors.js';

/** The provider's consent URL with the standard parameters plus `extra`. */
export function authorizeUrl(endpoint, { clientId, redirectUri, scope, state, extra = {} }) {
  const url = new URL(endpoint);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  if (scope) url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  return url.toString();
}

/** Reads the code the provider sent back to the setup page; a denied consent is a clear error. */
export function codeFrom(params, providerName) {
  if (params?.error) {
    throw new ProviderError('invalid_request', `${providerName} consent was not granted`, {
      publicMessage: `${providerName} did not grant access${params.error === 'access_denied' ? ' (consent was declined)' : ''}. Start again from Integrations.`,
    });
  }
  const code = String(params?.code ?? '');
  if (!code || code.length > 4096) throw new ProviderError('invalid_request', `Missing ${providerName} authorization code`, { publicMessage: `${providerName} did not send an authorization code. Start again from Integrations.` });
  return code;
}

/**
 * Calls a token endpoint. `format` 'form' (RFC 6749) or 'json' (Atlassian). With `basicAuth`, the
 * client credentials go in an Authorization header instead of the body (Figma).
 * Returns [{ kind: 'access_token', ... }, { kind: 'refresh_token', ... }] plus the raw extras.
 */
export async function requestTokens(ctx, { tokenUrl, fetch, format = 'form', clientId, clientSecret, basicAuth = false, params, previousRefreshToken = null, providerName }) {
  const url = new URL(tokenUrl);
  const client = ctx.http({
    baseUrl: url.origin,
    fetch,
    authorize: basicAuth ? (h) => h.set('Authorization', `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`) : undefined,
  });
  const body = basicAuth ? params : { client_id: clientId, client_secret: clientSecret, ...params };
  let res;
  try {
    res = format === 'json' ? await client.post(url.pathname, body) : await client.postForm(url.pathname, body);
  } catch (err) {
    // invalid_grant & co. come back as 400/401: the grant was revoked or the refresh token expired.
    if (err instanceof ProviderError && ['invalid_request', 'auth', 'forbidden'].includes(err.kind)) {
      throw new ProviderError('auth', `${providerName} token request rejected (${err.status ?? err.kind})`, {
        status: err.status,
        publicMessage: `${providerName} no longer accepts WorkAgent’s authorization; connect ${providerName} again`,
      });
    }
    throw err;
  }
  const t = res.body ?? {};
  if (typeof t.access_token !== 'string' || !t.access_token) throw new ProviderError('invalid_response', `${providerName} returned no access token`);
  const expiresIn = Number(t.expires_in);
  const credentials = [{ kind: 'access_token', value: t.access_token, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null }];
  const refresh = typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : previousRefreshToken;
  if (refresh) credentials.push({ kind: 'refresh_token', value: refresh, expiresAt: null });
  return { credentials, scope: typeof t.scope === 'string' ? t.scope : null, extra: t };
}

/** refreshCredentials() body for a standard refresh_token grant. */
export async function refreshTokens(ctx, options) {
  // peek: never refresh while reading the refresh token itself (that would recurse).
  const refreshToken = await ctx.credentials.peek('refresh_token');
  if (!refreshToken) {
    throw new ProviderError('auth', `No ${options.providerName} refresh token stored`, { publicMessage: `Connect ${options.providerName} again` });
  }
  const { credentials } = await requestTokens(ctx, { ...options, params: { grant_type: 'refresh_token', refresh_token: refreshToken, ...(options.params ?? {}) }, previousRefreshToken: refreshToken });
  return credentials;
}

/**
 * An API client that sends the stored access token and, after a 401, forces one refresh and
 * retries (tokens can be revoked before they expire).
 */
export function bearerClient(ctx, { baseUrl, fetch, defaultHeaders, classify, providerName }) {
  let token = null;
  const client = ctx.http({
    baseUrl,
    fetch,
    defaultHeaders,
    classify,
    authorize: async (h) => {
      token ??= await ctx.credentials.get('access_token');
      if (!token) throw new ProviderError('auth', `No ${providerName} access token stored`, { publicMessage: `Connect ${providerName} again` });
      h.set('Authorization', `Bearer ${token}`);
    },
  });
  async function request(method, path, opts) {
    try {
      return await client.request(method, path, opts);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== 'auth') throw err;
      token = await ctx.credentials.refresh('access_token');
      if (!token) throw err;
      return client.request(method, path, opts);
    }
  }
  return { request, get: (path, opts) => request('GET', path, opts), post: (path, body, opts) => request('POST', path, { ...opts, body }) };
}
