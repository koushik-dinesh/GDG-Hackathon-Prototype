import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { config } from '../src/config/index.js';
import {
  CredentialsKeyMissingError,
  CredentialsUnreadableError,
  createKeyring,
  keyId,
  keyring,
} from '../src/services/integrations/crypto.js';

const AAD = 'workagent:cred:v1:7:installation_token';
const SECRET = 'ghs_example-installation-token-0123456789';

describe('credential encryption', () => {
  it('round-trips with AES-256-GCM and never stores the plaintext', () => {
    const ring = createKeyring({ current: randomBytes(32) });
    const sealed = ring.encrypt(SECRET, AAD);
    assert.equal(sealed.iv.length, 12);
    assert.equal(sealed.authTag.length, 16);
    assert.equal(sealed.keyId, ring.currentKeyId);
    assert.ok(!sealed.ciphertext.toString('latin1').includes(SECRET));
    assert.equal(ring.decrypt(sealed, AAD), SECRET);
  });

  it('uses a fresh IV for every encryption', () => {
    const ring = createKeyring({ current: randomBytes(32) });
    const a = ring.encrypt(SECRET, AAD);
    const b = ring.encrypt(SECRET, AAD);
    assert.notDeepEqual(a.iv, b.iv);
    assert.notDeepEqual(a.ciphertext, b.ciphertext);
  });

  it('refuses a ciphertext moved to another row (AAD binding)', () => {
    const ring = createKeyring({ current: randomBytes(32) });
    const sealed = ring.encrypt(SECRET, AAD);
    assert.throws(() => ring.decrypt(sealed, 'workagent:cred:v1:8:installation_token'), CredentialsUnreadableError);
  });

  it('detects tampering with the ciphertext or tag', () => {
    const ring = createKeyring({ current: randomBytes(32) });
    const sealed = ring.encrypt(SECRET, AAD);
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] ^= 1;
    assert.throws(() => ring.decrypt({ ...sealed, ciphertext: flipped }, AAD), CredentialsUnreadableError);
    const tag = Buffer.from(sealed.authTag);
    tag[0] ^= 1;
    assert.throws(() => ring.decrypt({ ...sealed, authTag: tag }, AAD), CredentialsUnreadableError);
    assert.throws(() => ring.decrypt({ ...sealed, iv: sealed.iv.subarray(0, 8) }, AAD), CredentialsUnreadableError);
  });

  it('decrypts with the previous key during rotation and reports what needs re-encrypting', () => {
    const oldKey = randomBytes(32);
    const newKey = randomBytes(32);
    const before = createKeyring({ current: oldKey });
    const sealed = before.encrypt(SECRET, AAD);

    const during = createKeyring({ current: newKey, previous: oldKey });
    assert.equal(during.decrypt(sealed, AAD), SECRET);
    assert.equal(during.needsReencrypt(sealed.keyId), true);
    const resealed = during.encrypt(during.decrypt(sealed, AAD), AAD);
    assert.equal(during.needsReencrypt(resealed.keyId), false);

    const after = createKeyring({ current: newKey });
    assert.throws(() => after.decrypt(sealed, AAD), (err) => err instanceof CredentialsUnreadableError && /unknown key/.test(err.message));
    assert.equal(after.decrypt(resealed, AAD), SECRET);
  });

  it('identifies keys stably without revealing them', () => {
    const key = randomBytes(32);
    assert.match(keyId(key), /^[0-9a-f]{16}$/);
    assert.equal(keyId(key), keyId(Buffer.from(key)));
    assert.notEqual(keyId(key), keyId(randomBytes(32)));
    assert.ok(!key.toString('hex').includes(keyId(key)));
  });

  it('cannot encrypt without a current key, and rejects bad input', () => {
    const ring = createKeyring({});
    assert.equal(ring.isConfigured(), false);
    assert.throws(() => ring.encrypt(SECRET, AAD), CredentialsKeyMissingError);
    assert.throws(() => createKeyring({ current: randomBytes(16) }), /32 bytes/);
    const ok = createKeyring({ current: randomBytes(32) });
    assert.throws(() => ok.encrypt(SECRET, ''), /AAD/);
    assert.throws(() => ok.encrypt(42, AAD), /string/);
  });

  it('errors never contain the secret', () => {
    const ring = createKeyring({ current: randomBytes(32) });
    const sealed = ring.encrypt(SECRET, AAD);
    try {
      ring.decrypt(sealed, 'wrong');
      assert.fail('expected an error');
    } catch (err) {
      assert.ok(!String(err.message).includes(SECRET));
      assert.ok(!String(err.stack).includes(SECRET));
    }
  });

  it('gives the test suite a throwaway key, never the deployment key', () => {
    assert.equal(keyring.isConfigured(), true);
    assert.equal(config.integrations.encryptionKeys.previous, null);
    const fromEnv = process.env.CREDENTIALS_ENCRYPTION_KEY;
    if (fromEnv) assert.notEqual(keyring.currentKeyId, keyId(Buffer.from(fromEnv, 'base64')));
  });
});

describe('encryption key configuration', () => {
  const run = promisify(execFile);
  const backendDir = fileURLToPath(new URL('..', import.meta.url));
  const baseEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'development',
    DB_USER: 'u',
    DB_PASSWORD: 'p',
    DB_NAME: 'd',
    JWT_SECRET: 'x'.repeat(40),
    CREDENTIALS_ENCRYPTION_KEY: '',
    CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: '',
  };
  // Loads the config in a child process (it exits the process on invalid configuration).
  const loadConfig = (env) =>
    run(process.execPath, ['--input-type=module', '-e', "const { config } = await import('./src/config/index.js'); console.log(JSON.stringify({ current: Boolean(config.integrations.encryptionKeys.current), previous: Boolean(config.integrations.encryptionKeys.previous) }))"], {
      cwd: backendDir,
      env: { ...baseEnv, ...env },
    }).then(
      ({ stdout }) => ({ ok: true, out: JSON.parse(stdout) }),
      (err) => ({ ok: false, out: err.stderr }),
    );
  const key = () => randomBytes(32).toString('base64');

  it('accepts no key, or a 32-byte base64 key (standard or URL-safe)', async () => {
    assert.deepEqual(await loadConfig({}), { ok: true, out: { current: false, previous: false } });
    assert.deepEqual(await loadConfig({ CREDENTIALS_ENCRYPTION_KEY: key() }), { ok: true, out: { current: true, previous: false } });
    const urlSafe = randomBytes(32).toString('base64url');
    assert.equal((await loadConfig({ CREDENTIALS_ENCRYPTION_KEY: urlSafe })).ok, true);
    assert.deepEqual(await loadConfig({ CREDENTIALS_ENCRYPTION_KEY: key(), CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: key() }), {
      ok: true,
      out: { current: true, previous: true },
    });
  });

  it('refuses short, non-base64, orphaned previous, or duplicate keys', async () => {
    const short = await loadConfig({ CREDENTIALS_ENCRYPTION_KEY: randomBytes(16).toString('base64') });
    assert.equal(short.ok, false);
    assert.match(short.out, /CREDENTIALS_ENCRYPTION_KEY: Must decode to exactly 32 bytes/);

    const notBase64 = await loadConfig({ CREDENTIALS_ENCRYPTION_KEY: 'not a key!' });
    assert.match(notBase64.out, /Must be base64/);

    const orphan = await loadConfig({ CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: key() });
    assert.match(orphan.out, /PREVIOUS is set without CREDENTIALS_ENCRYPTION_KEY/);

    const same = key();
    const dup = await loadConfig({ CREDENTIALS_ENCRYPTION_KEY: same, CREDENTIALS_ENCRYPTION_KEY_PREVIOUS: same });
    assert.match(dup.out, /must differ/);
  });

  it('never prints the key in configuration errors', async () => {
    const bad = randomBytes(31).toString('base64');
    const res = await loadConfig({ CREDENTIALS_ENCRYPTION_KEY: bad });
    assert.equal(res.ok, false);
    assert.ok(!res.out.includes(bad));
  });
});
