import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ProviderError } from '../src/services/integrations/errors.js';
import { createHttpClient, parseLinks, parseRateLimit } from '../src/services/integrations/http.js';

const SECRET = 'Bearer ghs_http-test-secret';

/** fetch stub: replies with the queued responses and records requests. */
function stubFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    const { status = 200, body, headers = {} } = r ?? {};
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 || status === 304 ? null : text, {
      status,
      headers: { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers },
    });
  };
  fn.calls = calls;
  return fn;
}

const client = (fetch, extra = {}) =>
  createHttpClient({ baseUrl: 'https://api.example.test', fetch, authorize: (h) => h.set('Authorization', SECRET), ...extra });

describe('provider HTTP client', () => {
  it('sends authorized JSON requests and returns parsed bodies, links and rate limits', async () => {
    const fetch = stubFetch({
      body: [{ id: 1 }],
      headers: {
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-reset': '1793400000',
        link: '<https://api.example.test/items?page=2>; rel="next", <https://api.example.test/items?page=9>; rel="last"',
      },
    });
    const http = client(fetch);
    const res = await http.get('/items', { query: { per_page: 100, since: undefined } });
    assert.deepEqual(res.body, [{ id: 1 }]);
    assert.equal(res.links.next, 'https://api.example.test/items?page=2');
    assert.equal(res.rateLimit.remaining, 4999);
    assert.equal(res.rateLimit.resetAt.toISOString(), new Date(1793400000 * 1000).toISOString());
    assert.equal(fetch.calls[0].url, 'https://api.example.test/items?per_page=100');
    assert.equal(fetch.calls[0].init.headers.get('authorization'), SECRET);
    assert.equal(fetch.calls[0].init.redirect, 'manual');
    assert.deepEqual(http.stats(), { requests: 1, rateLimit: res.rateLimit });
  });

  it('never sends credentials to another origin', async () => {
    const fetch = stubFetch();
    const http = client(fetch);
    await assert.rejects(http.get('https://evil.example.test/steal'), (err) => err instanceof ProviderError && err.kind === 'invalid_response');
    await assert.rejects(http.get('//evil.example.test/steal'), ProviderError);
    assert.equal(fetch.calls.length, 0);
  });

  it('classifies failures into the error taxonomy', async () => {
    const cases = [
      [{ status: 401 }, 'auth'],
      [{ status: 403 }, 'forbidden'],
      [{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) } }, 'rate_limited'],
      [{ status: 403, headers: { 'retry-after': '20' } }, 'rate_limited'],
      [{ status: 429 }, 'rate_limited'],
      [{ status: 404 }, 'not_found'],
      [{ status: 422, body: { message: 'Validation Failed' } }, 'invalid_request'],
      [{ status: 502 }, 'transient'],
      [{ status: 200, body: '{not json', headers: { 'content-type': 'application/json' } }, 'invalid_response'],
      [new TypeError('fetch failed'), 'transient'],
    ];
    for (const [response, kind] of cases) {
      const http = client(stubFetch(response));
      await assert.rejects(http.get('/x'), (err) => {
        assert.ok(err instanceof ProviderError, `${kind}: ${err}`);
        assert.equal(err.kind, kind, JSON.stringify(response.status ?? response.message));
        return true;
      });
    }
    const limited = client(stubFetch({ status: 403, headers: { 'retry-after': '20' } }));
    await assert.rejects(limited.get('/x'), (err) => err.waitMs() > 15_000 && err.waitMs() <= 20_000);
  });

  it('keeps headers, query strings and bodies out of error messages', async () => {
    const http = client(stubFetch({ status: 500, body: { detail: 'internal secret detail' } }));
    await assert.rejects(http.get('/repos/x', { query: { token: 'q-secret' } }), (err) => {
      for (const s of [SECRET, 'q-secret', 'internal secret detail']) assert.ok(!err.message.includes(s));
      assert.equal(err.message, 'Provider error: GET /repos/x -> 500');
      return true;
    });
  });

  it('lets connectors override classification, and times out', async () => {
    const custom = client(stubFetch({ status: 403, body: { message: 'secondary rate limit' } }), {
      classify: ({ status, body }) => (status === 403 && /secondary/.test(body?.message) ? new ProviderError('rate_limited', 'secondary', { retryAfterMs: 60_000 }) : null),
    });
    await assert.rejects(custom.get('/x'), (err) => err.kind === 'rate_limited' && err.waitMs() === 60_000);

    const slow = createHttpClient({
      baseUrl: 'https://api.example.test',
      timeoutMs: 20,
      fetch: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    });
    // AbortSignal.timeout() doesn't keep the process alive by itself; a server always has other handles.
    const keepAlive = setTimeout(() => {}, 2000);
    try {
      await assert.rejects(slow.get('/slow'), (err) => err.kind === 'transient' && /timed out/.test(err.message));
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it('handles 204/304 and plain-text bodies', async () => {
    const http = client(stubFetch({ status: 204 }, { status: 304 }, { body: 'pong' }));
    assert.equal((await http.post('/x', { a: 1 })).body, null);
    assert.equal((await http.get('/x')).status, 304);
    assert.equal((await http.get('/ping')).body, 'pong');
  });
});

describe('header parsing', () => {
  it('reads rate limits and retry-after in both forms', () => {
    const now = Date.parse('2026-10-30T10:00:00Z');
    const h = new Headers({ 'retry-after': 'Fri, 30 Oct 2026 10:00:30 GMT' });
    assert.equal(parseRateLimit(h, now).retryAfterMs, 30_000);
    assert.deepEqual(parseRateLimit(new Headers(), now), { remaining: null, limit: null, resetAt: null, retryAfterMs: null });
  });

  it('parses Link headers', () => {
    assert.deepEqual(parseLinks('<https://a.test/x?page=2>; rel="next", <https://a.test/x?page=1>; rel=prev'), {
      next: 'https://a.test/x?page=2',
      prev: 'https://a.test/x?page=1',
    });
    assert.deepEqual(parseLinks(null), {});
  });
});
