// GitHub API access (Phase 3B): App-level calls authenticated with a short-lived App JWT, and
// installation-level calls with an installation access token from the credential vault.
//
// - App JWT: RS256, signed with the App private key, iat 60 s in the past (clock skew), valid
//   9 minutes (GitHub's limit is 10), cached per process until a minute before expiry.
// - Installation tokens (1 h) are minted with the JWT and stored encrypted by the framework
//   (refreshCredentials); a 401 from GitHub triggers one forced refresh and retry.
// - Neither the key, the JWT nor tokens are ever logged or put in error messages.
import jwt from 'jsonwebtoken';
import { ProviderError } from '../../errors.js';
import { settings } from './settings.js';

const API_VERSION = '2022-11-28';
const JWT_TTL_S = 9 * 60;
let cachedJwt = null; // { token, appId, refreshAt }

export function appJwt(now = Date.now()) {
  if (cachedJwt && cachedJwt.appId === settings.appId && cachedJwt.key === settings.privateKey && now < cachedJwt.refreshAt) return cachedJwt.token;
  const iat = Math.floor(now / 1000) - 60;
  const token = jwt.sign({ iat, exp: iat + JWT_TTL_S, iss: String(settings.appId) }, settings.privateKey, { algorithm: 'RS256' });
  cachedJwt = { token, appId: settings.appId, key: settings.privateKey, refreshAt: (iat + JWT_TTL_S - 60) * 1000 };
  return token;
}

/** Tests: forget the cached JWT. */
export const clearJwtCache = () => {
  cachedJwt = null;
};

/** GitHub-specific status classification on top of the framework default. */
export function classify({ status, body, rateLimit }) {
  const message = typeof body?.message === 'string' ? body.message.toLowerCase() : '';
  if ((status === 403 || status === 429) && /secondary rate limit|abuse/.test(message)) {
    return new ProviderError('rate_limited', 'GitHub secondary rate limit', {
      status,
      retryAfterMs: rateLimit.retryAfterMs ?? 60_000,
    });
  }
  if (status === 403 && /suspended/.test(message)) {
    return new ProviderError('suspended', 'GitHub installation is suspended', { status });
  }
  if (status === 301 || status === 302 || status === 307) {
    return new ProviderError('invalid_request', `GitHub resource moved (${status})`, {
      status,
      publicMessage: 'The repository was renamed or moved on GitHub; refresh the repository list',
    });
  }
  return null;
}

const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'WorkAgent' };

/** Client for /app/* endpoints (App JWT). */
export function appClient(ctx) {
  return ctx.http({
    baseUrl: settings.apiUrl,
    fetch: settings.fetch,
    defaultHeaders: headers,
    classify,
    authorize: (h) => h.set('Authorization', `Bearer ${appJwt()}`),
  });
}

/**
 * Mints an installation access token. Returns [{ kind, value, expiresAt }] (the vault stores it).
 * A deleted or inaccessible installation is an `auth` error: the connection needs reconnecting.
 */
export async function mintInstallationToken(ctx, installationId) {
  if (!/^\d+$/.test(String(installationId))) throw new ProviderError('invalid_request', 'Invalid installation id');
  try {
    const res = await appClient(ctx).post(`/app/installations/${installationId}/access_tokens`, {});
    if (typeof res.body?.token !== 'string' || !res.body.expires_at) throw new ProviderError('invalid_response', 'GitHub returned no installation token');
    return [{ kind: 'installation_token', value: res.body.token, expiresAt: new Date(res.body.expires_at) }];
  } catch (err) {
    if (err instanceof ProviderError && ['not_found', 'forbidden'].includes(err.kind)) {
      throw new ProviderError('auth', `GitHub installation ${installationId} is not accessible (${err.kind})`, {
        status: err.status,
        publicMessage: 'The GitHub App installation was removed or can no longer be used; connect GitHub again',
      });
    }
    throw err;
  }
}

export async function getInstallation(ctx, installationId) {
  if (!/^\d+$/.test(String(installationId))) throw new ProviderError('invalid_request', 'Invalid installation id');
  return (await appClient(ctx).get(`/app/installations/${installationId}`)).body;
}

/**
 * Client for installation-scoped endpoints. `get` retries once with a fresh token after a 401
 * (tokens can be revoked before they expire).
 */
export function installationClient(ctx) {
  let token = null;
  const client = ctx.http({
    baseUrl: settings.apiUrl,
    fetch: settings.fetch,
    defaultHeaders: headers,
    classify,
    authorize: async (h) => {
      token ??= await ctx.credentials.get('installation_token');
      if (!token) throw new ProviderError('auth', 'No GitHub installation token stored', { publicMessage: 'Connect GitHub again' });
      h.set('Authorization', `Bearer ${token}`);
    },
  });

  async function request(method, path, opts) {
    try {
      return await client.request(method, path, opts);
    } catch (err) {
      if (!(err instanceof ProviderError) || err.kind !== 'auth') throw err;
      token = await ctx.credentials.refresh('installation_token');
      if (!token) throw err;
      return client.request(method, path, opts);
    }
  }
  return { get: (path, opts) => request('GET', path, opts), request };
}
