// GitHub connector (Phase 3B), implementing the Phase 3A connector contract with a GitHub App.
//
// Connect: the admin installs the App on GitHub (choosing all or selected repositories); GitHub
// sends the browser back with installation_id. completeConnect verifies that installation through
// the App's own JWT (the query parameter alone is never trusted) and mints an installation token.
// Permissions used (all read-only): Metadata, Issues, Pull requests, Contents (commit history).
import { ProviderError } from '../../errors.js';
import { appClient, getInstallation, installationClient, mintInstallationToken } from './api.js';
import { resourceOf } from './mappers.js';
import { githubConfigProblem, settings, sourceInstanceOf } from './settings.js';
import { STREAMS, syncStream } from './streams.js';
import { handleWebhook, parseWebhook, verifyWebhook } from './webhooks.js';

const MAX_REPOSITORY_PAGES = 50; // 5,000 repositories per installation

/** Where an admin manages this installation's repository access on GitHub. */
function manageUrl(installation) {
  const id = installation.id;
  return installation.account?.type === 'Organization'
    ? `${settings.webUrl}/organizations/${installation.account.login}/settings/installations/${id}`
    : `${settings.webUrl}/settings/installations/${id}`;
}

const installationSettings = (installation) => ({
  repositorySelection: installation.repository_selection ?? null,
  permissions: installation.permissions ?? {},
  events: installation.events ?? [],
  manageUrl: manageUrl(installation),
  appSlug: installation.app_slug ?? settings.slug,
});

export const github = {
  id: 'github',
  displayName: 'GitHub',
  get sourceInstance() {
    return sourceInstanceOf(settings.webUrl);
  },
  capabilities: { install: 'github_app', webhooks: true, polling: true, credentials: true },

  configProblem: githubConfigProblem,

  beginConnect({ state }) {
    const url = new URL(`${settings.webUrl}/apps/${encodeURIComponent(settings.slug)}/installations/new`);
    url.searchParams.set('state', state);
    return { redirectUrl: url.toString() };
  },

  async completeConnect(ctx, { params }) {
    if (params?.setupAction === 'request') {
      throw new ProviderError('invalid_request', 'GitHub App installation is waiting for approval', {
        publicMessage: 'An organization owner must approve the GitHub App installation. Connect again once it is approved.',
      });
    }
    const installationId = String(params?.installationId ?? '');
    if (!/^\d{1,20}$/.test(installationId)) {
      throw new ProviderError('invalid_request', 'Missing installation_id', { publicMessage: 'GitHub did not send an installation id. Start again from Integrations.' });
    }
    const installation = await getInstallation(ctx, installationId);
    if (String(installation?.app_id ?? settings.appId) !== String(settings.appId)) {
      throw new ProviderError('invalid_request', 'Installation belongs to another GitHub App');
    }
    if (installation.suspended_at) {
      throw new ProviderError('suspended', 'GitHub installation is suspended', { publicMessage: 'This GitHub App installation is suspended. Unsuspend it on GitHub, then connect again.' });
    }
    const credentials = await mintInstallationToken(ctx, installationId);
    return {
      account: {
        externalAccountId: installationId,
        login: installation.account?.login ?? null,
        type: installation.account?.type ?? null,
        displayName: installation.account?.login ? `GitHub · ${installation.account.login}` : `GitHub installation ${installationId}`,
      },
      settings: installationSettings(installation),
      credentials,
    };
  },

  refreshCredentials(ctx) {
    return mintInstallationToken(ctx, ctx.connection.externalAccountId);
  },

  async disconnect(ctx, { uninstall = false } = {}) {
    // Uninstalling removes the App from the GitHub account; only on explicit request.
    if (uninstall) await appClient(ctx).request('DELETE', `/app/installations/${ctx.connection.externalAccountId}`);
  },

  async listResources(ctx) {
    const api = installationClient(ctx);
    const repos = [];
    let next = '/installation/repositories';
    let query = { per_page: 100 };
    for (let page = 0; next && page < MAX_REPOSITORY_PAGES; page++) {
      const res = await api.get(next, { query });
      repos.push(...(res.body?.repositories ?? []));
      next = res.links.next ?? null;
      query = undefined; // the next link already carries the query
    }
    return repos.map(resourceOf);
  },

  async health(ctx) {
    const installation = await getInstallation(ctx, ctx.connection.externalAccountId);
    return installation.suspended_at ? { status: 'failing', detail: 'suspended' } : { status: 'healthy' };
  },

  streams: () => STREAMS,

  syncStream(ctx, args) {
    return syncStream({ api: installationClient(ctx), source: sourceInstanceOf(settings.webUrl) }, args);
  },

  verifyWebhook,
  parseWebhook,

  async handleWebhook(ctx, delivery) {
    return handleWebhook(sourceInstanceOf(settings.webUrl), delivery);
  },
};

export default github;
