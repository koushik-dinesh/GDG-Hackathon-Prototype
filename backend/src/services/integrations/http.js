// HTTP client for connectors (Phase 3A, docs/PHASE_3A_PLAN.md §5.1): the generalized form of
// services/vexa/client.js. Connectors get one per job through ctx.http.
//
// - Requests only go to the connector's own origin (pagination links included), so credentials
//   added by authorize() can never be sent to another host.
// - Rate-limit headers are recorded on every response (x-ratelimit-remaining/reset, retry-after).
// - Failures become ProviderError; the connector may override classification with classify().
// - Nothing is logged here, and error messages carry method, path and status only: never
//   headers, query strings or bodies.
import { ProviderError } from './errors.js';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Reads rate-limit headers. resetAt is a Date (x-ratelimit-reset is epoch seconds). */
export function parseRateLimit(headers, now = Date.now()) {
  const num = (name) => {
    const v = headers.get(name);
    return v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  const remaining = num('x-ratelimit-remaining');
  const limit = num('x-ratelimit-limit');
  const reset = num('x-ratelimit-reset');
  let retryAfterMs = null;
  const ra = headers.get('retry-after');
  if (ra !== null) {
    if (Number.isFinite(Number(ra))) retryAfterMs = Number(ra) * 1000;
    else if (!Number.isNaN(Date.parse(ra))) retryAfterMs = Math.max(0, Date.parse(ra) - now);
  }
  return { remaining, limit, resetAt: reset === null ? null : new Date(reset * 1000), retryAfterMs };
}

/** Parses an RFC 8288 Link header into { rel: url }. */
export function parseLinks(header) {
  const links = {};
  if (!header) return links;
  for (const part of header.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (m) links[m[2]] = m[1];
  }
  return links;
}

/** Default status classification; connectors can refine it (e.g. secondary rate limits). */
export function defaultClassify({ status, rateLimit, method, path }) {
  const where = `${method} ${path} -> ${status}`;
  if (status === 429 || (status === 403 && (rateLimit.remaining === 0 || rateLimit.retryAfterMs !== null))) {
    return new ProviderError('rate_limited', `Rate limited: ${where}`, {
      status,
      resetAt: rateLimit.retryAfterMs !== null ? new Date(Date.now() + rateLimit.retryAfterMs) : rateLimit.resetAt ?? undefined,
    });
  }
  if (status === 401) return new ProviderError('auth', `Unauthorized: ${where}`, { status });
  if (status === 403) return new ProviderError('forbidden', `Forbidden: ${where}`, { status });
  if (status === 404 || status === 410) return new ProviderError('not_found', `Not found: ${where}`, { status });
  if (status === 408 || status >= 500) return new ProviderError('transient', `Provider error: ${where}`, { status });
  if (status >= 400) return new ProviderError('invalid_request', `Request rejected: ${where}`, { status });
  return null;
}

/**
 * @param {{ baseUrl: string, authorize?: (headers: Headers) => Promise<void>|void,
 *           classify?: (info) => ProviderError|null|undefined, timeoutMs?: number,
 *           fetch?: typeof fetch, signal?: AbortSignal, defaultHeaders?: Record<string,string> }} options
 */
export function createHttpClient({ baseUrl, authorize, classify, timeoutMs = DEFAULT_TIMEOUT_MS, fetch: fetchImpl = globalThis.fetch, signal, defaultHeaders = {} }) {
  const base = new URL(baseUrl);
  let requests = 0;
  let lastRateLimit = null;

  function resolve(pathOrUrl, query) {
    const url = new URL(pathOrUrl, base);
    if (url.origin !== base.origin) {
      throw new ProviderError('invalid_response', `Refusing to call another origin (${url.origin})`);
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url;
  }

  /**
   * Returns { status, headers, body, links, rateLimit }. body is parsed JSON (or null for 204/304,
   * or text when the response isn't JSON). Throws ProviderError for failures.
   */
  async function request(method, pathOrUrl, { query, body, form, headers: extra, okStatuses = [] } = {}) {
    const url = resolve(pathOrUrl, query);
    const path = url.pathname;
    const headers = new Headers({ Accept: 'application/json', ...defaultHeaders, ...extra });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    // `form`: an application/x-www-form-urlencoded body (OAuth token endpoints).
    if (form !== undefined) headers.set('Content-Type', 'application/x-www-form-urlencoded');
    if (authorize) await authorize(headers);

    requests++;
    let res;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      res = await fetchImpl(url, {
        method,
        headers,
        body: form !== undefined ? new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined && v !== null)).toString() : body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'manual',
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new ProviderError('transient', `${method} ${path} ${timedOut ? 'timed out' : 'failed'}`, { cause: err });
    }

    const rateLimit = parseRateLimit(res.headers);
    lastRateLimit = rateLimit;
    const text = res.status === 204 || res.status === 304 ? '' : await res.text().catch(() => '');
    let parsed = null;
    if (text) {
      const isJson = (res.headers.get('content-type') ?? '').includes('json');
      try {
        parsed = isJson ? JSON.parse(text) : text;
      } catch {
        throw new ProviderError('invalid_response', `${method} ${path} returned invalid JSON`, { status: res.status });
      }
    }

    const ok = (res.status >= 200 && res.status < 300) || res.status === 304 || okStatuses.includes(res.status);
    const info = { status: res.status, headers: res.headers, body: parsed, rateLimit, method, path };
    if (!ok) {
      const err = classify?.(info) ?? defaultClassify(info);
      if (err) throw err;
      throw new ProviderError('invalid_response', `${method} ${path} -> ${res.status}`, { status: res.status });
    }
    return { status: res.status, headers: res.headers, body: parsed, links: parseLinks(res.headers.get('link')), rateLimit };
  }

  return {
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body }),
    postForm: (path, form, opts) => request('POST', path, { ...opts, form }),
    /** { requests, rateLimit } for the sync engine and connection health. */
    stats: () => ({ requests, rateLimit: lastRateLimit }),
  };
}
