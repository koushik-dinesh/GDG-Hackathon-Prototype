// Jira Cloud settings. Values come from config (backend/.env); the test suite points them at a
// fake Jira with configureJira(); real values are never used in tests.
//
// SSRF: the connector only calls authUrl (token endpoint) and apiUrl (api.atlassian.com, which
// proxies the configured site by its cloud id); the HTTP client refuses any other origin.
import { config } from '../../../../config/index.js';

const fromConfig = () => ({
  clientId: config.jira.clientId,
  clientSecret: config.jira.clientSecret,
  siteUrl: config.jira.siteUrl,
  webhookSecret: config.jira.webhookSecret,
  authUrl: config.jira.authUrl,
  apiUrl: config.jira.apiUrl,
  redirectUri: config.email.appPublicUrl ? `${config.email.appPublicUrl}/integrations/jira/setup` : undefined,
  fetch: undefined,
});

export const settings = fromConfig();

export function configureJira(overrides) {
  Object.assign(settings, overrides);
}

export function resetJiraSettings() {
  for (const key of Object.keys(settings)) delete settings[key];
  Object.assign(settings, fromConfig());
}

/** Why Jira can't be used, or null. Never includes values. */
export function jiraConfigProblem() {
  if (!settings.clientId) return 'JIRA_CLIENT_ID is not set';
  if (!settings.clientSecret) return 'JIRA_CLIENT_SECRET is not set';
  if (!settings.siteUrl) return 'JIRA_SITE_URL is not set';
  if (!settings.redirectUri) return 'APP_PUBLIC_URL is not set (needed for the OAuth redirect)';
  return null;
}

/** source_instance for records and identities: the site host (acme.atlassian.net). */
export const sourceInstanceOf = (siteUrl) => (siteUrl ? new URL(siteUrl).host : 'jira.unconfigured');
