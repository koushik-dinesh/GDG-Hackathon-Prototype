// GitHub App settings (Phase 3B). Values come from config (backend/.env). The test suite points
// them at a fake GitHub with configureGithub(); real values are never used in tests.
//
// SSRF: the only hosts this connector ever calls are apiUrl (from the deployment's configuration)
// and nothing else; the HTTP client refuses other origins, including in pagination links.
import { config } from '../../../../config/index.js';

const fromConfig = () => ({
  appId: config.github.appId,
  slug: config.github.slug,
  privateKey: config.github.privateKey,
  webhookSecrets: [...config.github.webhookSecrets],
  apiUrl: config.github.apiUrl,
  webUrl: config.github.webUrl,
  fetch: undefined, // undefined = global fetch
});

export const settings = fromConfig();

/** Tests only: overrides settings (e.g. a local fake GitHub and a generated key). */
export function configureGithub(overrides) {
  Object.assign(settings, overrides);
}

export function resetGithubSettings() {
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, fromConfig());
}

/** Why GitHub can't be used, or null. Never includes values. */
export function githubConfigProblem() {
  if (!settings.appId) return 'GITHUB_APP_ID is not set';
  if (!settings.slug) return 'GITHUB_APP_SLUG is not set';
  if (!settings.privateKey) return 'GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is not set';
  if (!settings.webhookSecrets?.length) return 'GITHUB_WEBHOOK_SECRET is not set';
  return null;
}

/** The host name used as source_instance (github.com, or the GHES host). */
export const sourceInstanceOf = (webUrl) => new URL(webUrl).host;
