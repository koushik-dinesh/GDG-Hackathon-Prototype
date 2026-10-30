import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REDACTED, redact, redactUrl } from '../src/utils/logger.js';

describe('log redaction', () => {
  it('masks sensitive fields at any depth and keeps the rest', () => {
    const out = redact({
      jobId: 4,
      error: 'boom',
      accessToken: 'ghs_abc',
      headers: { Authorization: 'Bearer x', 'X-Hub-Signature-256': 'sha256=y', accept: 'json' },
      nested: [{ client_secret: 's', privateKey: 'pem', webhookSecret: 'w', name: 'ok' }],
      password: 'p',
      state: 'csrf',
      apiKey: 'k',
      cookie: 'c',
      ciphertext: Buffer.from('x'),
    });
    assert.deepEqual(out, {
      jobId: 4,
      error: 'boom',
      accessToken: REDACTED,
      headers: { Authorization: REDACTED, 'X-Hub-Signature-256': REDACTED, accept: 'json' },
      nested: [{ client_secret: REDACTED, privateKey: REDACTED, webhookSecret: REDACTED, name: 'ok' }],
      password: REDACTED,
      state: REDACTED,
      apiKey: REDACTED,
      cookie: REDACTED,
      ciphertext: REDACTED,
    });
  });

  it('leaves the field names existing log calls use untouched', () => {
    const fields = { jobId: 1, type: 'ai.extract', attempt: 2, status: 'pending', error: 'x', code: 'E', email: 'a@b.test', path: '/x', ip: '::1', provider: 'smtp', model: 'm', meetingId: 3 };
    assert.deepEqual(redact(fields), fields);
  });

  it('turns Errors into name/message, masks Buffers and bounds depth', () => {
    assert.deepEqual(redact({ err: new TypeError('bad') }), { err: { name: 'TypeError', message: 'bad' } });
    assert.equal(redact({ data: Buffer.from('secret') }).data, REDACTED);
    let deep = { leaf: 1 };
    for (let i = 0; i < 10; i++) deep = { deep };
    assert.ok(JSON.stringify(redact(deep)).includes('[…]'));
  });

  it('masks sensitive query parameters in logged URLs', () => {
    assert.equal(redactUrl('/api/v1/health'), '/api/v1/health');
    const url = redactUrl('/api/v1/x?installation_id=5&state=abc&code=def&token=ghi&page=2');
    const params = new URLSearchParams(url.split('?')[1]);
    assert.equal(params.get('installation_id'), '5');
    assert.equal(params.get('page'), '2');
    for (const k of ['state', 'code', 'token']) assert.equal(params.get(k), REDACTED);
    assert.ok(!url.includes('abc') && !url.includes('def') && !url.includes('ghi'));
  });
});
