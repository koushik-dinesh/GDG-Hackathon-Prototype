// Shared setup for GitHub tests: a generated App key pair, a fake GitHub on 127.0.0.1 and the
// connector configured to use them. No real GitHub, keys or secrets are involved.
import { generateKeyPairSync } from 'node:crypto';
import { clearJwtCache } from '../../src/services/integrations/providers/github/api.js';
import { configureGithub, resetGithubSettings } from '../../src/services/integrations/providers/github/settings.js';
import { signatureFor } from '../../src/services/integrations/providers/github/webhooks.js';
import { startFakeGithub } from './fakeGithub.js';

export const APP_ID = '424242';
export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';
export const OLD_WEBHOOK_SECRET = 'test-webhook-secret-previous-9876543210';

export async function setupGithub() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const gh = await startFakeGithub({ appId: APP_ID, publicKey });
  configureGithub({ appId: APP_ID, slug: 'workagent-test', privateKey, webhookSecrets: [WEBHOOK_SECRET, OLD_WEBHOOK_SECRET], apiUrl: gh.url, webUrl: 'https://github.com' });
  clearJwtCache();
  return {
    gh,
    privateKey,
    publicKey,
    async teardown() {
      resetGithubSettings();
      clearJwtCache();
      await gh.close();
    },
  };
}

/** Headers + body of a GitHub webhook signed with `secret`. */
export function githubDelivery(event, body, { deliveryId = `d-${Math.random().toString(36).slice(2)}`, secret = WEBHOOK_SECRET, appId = APP_ID } = {}) {
  const raw = JSON.stringify(body);
  return {
    raw,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-github-hook-installation-target-type': 'integration',
      'x-github-hook-installation-target-id': appId,
      'x-hub-signature-256': signatureFor(secret, Buffer.from(raw)),
    },
  };
}
