// Phase 3B: GitHub connector without a database: App JWT, installation tokens, mappers, webhook
// verification and handling, and the reusable connector contract suite (fake GitHub over HTTP).
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import { ProviderError } from '../src/services/integrations/errors.js';
import { createHttpClient } from '../src/services/integrations/http.js';
import { appJwt, clearJwtCache } from '../src/services/integrations/providers/github/api.js';
import github from '../src/services/integrations/providers/github/index.js';
import { commitEnvelopes, issueEnvelopes, pullEnvelopes, reviewEnvelopes } from '../src/services/integrations/providers/github/mappers.js';
import { configureGithub, githubConfigProblem, settings } from '../src/services/integrations/providers/github/settings.js';
import { handleWebhook, parseWebhook, verifyWebhook } from '../src/services/integrations/providers/github/webhooks.js';
import { describeConnector } from './integrations/contract.js';
import { addInstallation, addRepo, at, commit, issue, issueComment, pull, review, reviewComment, user } from './integrations/fakeGithub.js';
import { APP_ID, OLD_WEBHOOK_SECRET, WEBHOOK_SECRET, githubDelivery, setupGithub } from './integrations/githubFixture.js';

let env;
let repo;

/** A ctx like the framework's, with in-memory credentials (no database). */
function makeCtx(connection, resource) {
  const store = new Map();
  const ctx = {
    connection,
    resource,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    http: (options) => createHttpClient(options),
    httpStats: () => ({ requests: 0, rateLimit: null }),
    credentials: {
      async get(kind) {
        if (!store.has(kind)) for (const c of await github.refreshCredentials(ctx)) store.set(c.kind, c.value);
        return store.get(kind) ?? null;
      },
      async refresh(kind) {
        for (const c of await github.refreshCredentials(ctx)) store.set(c.kind, c.value);
        return store.get(kind) ?? null;
      },
    },
  };
  return ctx;
}

function seed() {
  addInstallation(env.gh.state, { id: 7001, login: 'acme' });
  repo = addRepo(env.gh.state, 7001, { id: 501, fullName: 'acme/payments', isPrivate: true });
  addRepo(env.gh.state, 7001, { id: 502, fullName: 'acme/web' });
  issue(repo, 1, { updated: at(1), assignees: [user(3, 'mia')], labels: ['bug'] });
  issue(repo, 2, { state: 'closed', updated: at(2), closedAt: at(2), reason: 'completed' });
  pull(repo, 3, { updated: at(3), reviewers: [user(1, 'ana')] });
  pull(repo, 4, { state: 'closed', updated: at(4), mergedAt: at(4) });
  review(repo, 3, { submitted: at(3, 12) });
  issueComment(repo, 1, { updated: at(2, 10) });
  issueComment(repo, 3, { onPull: true, updated: at(3, 11) });
  reviewComment(repo, 3, { updated: at(3, 13) });
  commit(repo, 'aaa111', { date: at(5) });
  commit(repo, 'bbb222', { date: at(6), author: null });
}

before(async () => {
  env = await setupGithub();
  seed();
});
after(() => env.teardown());

describeConnector(github, {
  connectParams: { installationId: '7001', setupAction: 'install' },
  makeCtx: (connection, resource) => makeCtx({ ...connection, externalAccountId: '7001' }, resource),
  validWebhook: () => {
    const d = githubDelivery('issues', { action: 'opened', installation: { id: 7001 }, repository: repo.meta, issue: repo.issues[0], sender: user(1, 'ana') });
    return { headers: d.headers, rawBody: Buffer.from(d.raw) };
  },
  maxChunks: 30,
  failingCall: (c, ctx) => {
    env.gh.state.failNext.push({ match: /GET \/installation\/repositories/, status: 502 });
    return c.listResources(ctx);
  },
});

describe('GitHub App authentication', () => {
  beforeEach(clearJwtCache);

  it('signs a short-lived RS256 App JWT with the App id as issuer, and caches it', () => {
    const now = Date.parse('2026-10-30T10:00:00Z');
    const token = appJwt(now);
    const claims = jwt.verify(token, env.publicKey, { algorithms: ['RS256'], clockTimestamp: now / 1000 });
    assert.equal(claims.iss, APP_ID);
    assert.equal(claims.iat, now / 1000 - 60, 'backdated for clock skew');
    assert.equal(claims.exp - claims.iat, 540, 'under GitHub’s 10-minute limit');
    assert.equal(appJwt(now + 60_000), token, 'cached');
    assert.notEqual(appJwt(now + 9 * 60_000), token, 'renewed before expiry');
    assert.equal(jwt.decode(token, { complete: true }).header.alg, 'RS256');
  });

  it('mints installation tokens and verifies the installation through the App', async () => {
    const ctx = makeCtx({ id: null, externalAccountId: null });
    const result = await github.completeConnect(ctx, { params: { installationId: '7001', setupAction: 'install' } });
    assert.equal(result.account.externalAccountId, '7001');
    assert.equal(result.account.login, 'acme');
    assert.equal(result.account.type, 'Organization');
    assert.equal(result.settings.repositorySelection, 'selected');
    assert.equal(result.settings.manageUrl, 'https://github.com/organizations/acme/settings/installations/7001');
    const [token] = result.credentials;
    assert.equal(token.kind, 'installation_token');
    assert.match(token.value, /^ghs_fake_/);
    assert.ok(token.expiresAt > new Date());
    const tokenCall = env.gh.state.calls.find((c) => c.line === 'POST /app/installations/7001/access_tokens');
    assert.match(tokenCall.auth, /^Bearer eyJ/, 'App JWT, not a personal token');
  });

  it('refuses unapproved, unknown, suspended and foreign installations with clear messages', async () => {
    const ctx = makeCtx({ id: null });
    await assert.rejects(github.completeConnect(ctx, { params: { setupAction: 'request' } }), (e) => e.kind === 'invalid_request' && /owner must approve/.test(e.publicMessage));
    await assert.rejects(github.completeConnect(ctx, { params: { installationId: 'abc' } }), (e) => e.kind === 'invalid_request');
    await assert.rejects(github.completeConnect(ctx, { params: { installationId: '9999' } }), (e) => e.kind === 'not_found');
    env.gh.state.installations['7001'].suspended_at = '2026-10-01T00:00:00Z';
    await assert.rejects(github.completeConnect(ctx, { params: { installationId: '7001' } }), (e) => e.kind === 'suspended');
    env.gh.state.installations['7001'].suspended_at = null;
    env.gh.state.installations['7001'].app_id = 1;
    await assert.rejects(github.completeConnect(ctx, { params: { installationId: '7001' } }), /another GitHub App/);
    env.gh.state.installations['7001'].app_id = Number(APP_ID);
  });

  it('a removed installation is an auth error (reconnect needed)', async () => {
    const ctx = makeCtx({ id: 1, externalAccountId: '8888' });
    await assert.rejects(github.refreshCredentials(ctx), (e) => e.kind === 'auth' && /connect GitHub again/.test(e.publicMessage));
  });

  it('retries once with a fresh token when GitHub rejects the current one', async () => {
    const ctx = makeCtx({ id: 1, externalAccountId: '7001' });
    await github.listResources(ctx);
    for (const t of env.gh.state.tokens.values()) t.revoked = true;
    const before = env.gh.state.tokenCounter;
    const resources = await github.listResources(ctx);
    assert.equal(resources.length, 2);
    assert.equal(env.gh.state.tokenCounter, before + 1, 'one new token');
  });

  it('reports what configuration is missing, without values', () => {
    const saved = { ...settings };
    configureGithub({ appId: undefined });
    assert.equal(githubConfigProblem(), 'GITHUB_APP_ID is not set');
    configureGithub({ appId: APP_ID, privateKey: undefined });
    assert.match(githubConfigProblem(), /PRIVATE_KEY/);
    configureGithub(saved);
    assert.equal(githubConfigProblem(), null);
  });
});

describe('GitHub repositories and streams', () => {
  it('discovers repositories across pages with their metadata', async () => {
    for (let i = 0; i < 120; i++) addRepo(env.gh.state, 7001, { id: 600 + i, fullName: `acme/repo-${i}` });
    const resources = await github.listResources(makeCtx({ id: 1, externalAccountId: '7001' }));
    assert.equal(resources.length, 122);
    const payments = resources.find((r) => r.name === 'acme/payments');
    assert.deepEqual(
      [payments.resourceType, payments.externalId, payments.metadata.private, payments.metadata.visibility, payments.metadata.defaultBranch, payments.metadata.owner],
      ['repository', '501', true, 'private', 'main', 'acme'],
    );
    for (let i = 0; i < 120; i++) delete env.gh.state.repos[`acme/repo-${i}`];
  });

  it('never calls hosts other than the configured API (pagination links included)', async () => {
    const ctx = makeCtx({ id: 1, externalAccountId: '7001' });
    const http = ctx.http;
    ctx.http = (o) => http(o);
    const api = (await import('../src/services/integrations/providers/github/api.js')).installationClient(ctx);
    await assert.rejects(api.get('https://evil.example.test/steal'), (e) => e instanceof ProviderError && /another origin/.test(e.message));
  });

  it('maps GitHub states to normalized status categories', () => {
    const r = { id: 1, full_name: 'o/r' };
    const status = (envs) => envs.find((e) => e.type === 'record').statusCategory;
    assert.equal(status(issueEnvelopes('github.com', r, { number: 1, state: 'open', created_at: at(1), updated_at: at(1) })), 'todo');
    assert.equal(status(issueEnvelopes('github.com', r, { number: 1, state: 'closed', state_reason: 'not_planned', created_at: at(1), updated_at: at(1), closed_at: at(1) })), 'cancelled');
    assert.equal(status(pullEnvelopes('github.com', r, { number: 2, state: 'open', created_at: at(1), updated_at: at(1) })), 'in_progress');
    assert.equal(status(pullEnvelopes('github.com', r, { number: 2, state: 'closed', merged_at: at(2), created_at: at(1), updated_at: at(2) })), 'done');
    assert.equal(status(pullEnvelopes('github.com', r, { number: 2, state: 'closed', closed_at: at(2), created_at: at(1), updated_at: at(2) })), 'cancelled');
    assert.deepEqual(reviewEnvelopes('github.com', r, 2, { id: 5, state: 'PENDING', submitted_at: null }), [], 'pending reviews are private');
  });

  it('never passes commit emails on as identities', () => {
    const envs = commitEnvelopes('github.com', { id: 1, full_name: 'o/r' }, { sha: 'abcdef1', message: 'Fix', authorUser: user(2, 'raj'), committedAt: at(1) });
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.]+/.test(JSON.stringify(envs)), 'no email anywhere');
    assert.deepEqual(envs.filter((e) => e.type === 'identity').map((e) => [e.externalUserId, e.login]), [['2', 'raj']]);
  });
});

describe('GitHub webhooks', () => {
  const raw = (d) => ({ headers: d.headers, rawBody: Buffer.from(d.raw) });

  it('verifies X-Hub-Signature-256 with the current or previous secret, nothing else', () => {
    const body = { action: 'opened' };
    assert.equal(verifyWebhook(raw(githubDelivery('issues', body))), true);
    assert.equal(verifyWebhook(raw(githubDelivery('issues', body, { secret: OLD_WEBHOOK_SECRET }))), true, 'rotation');
    assert.equal(verifyWebhook(raw(githubDelivery('issues', body, { secret: 'not-the-secret-at-all-000000' }))), false);
    const d = githubDelivery('issues', body);
    assert.equal(verifyWebhook({ headers: d.headers, rawBody: Buffer.from(d.raw + ' ') }), false, 'tampered');
    assert.equal(verifyWebhook({ headers: { ...d.headers, 'x-hub-signature-256': d.headers['x-hub-signature-256'].replace('sha256=', 'sha1=') }, rawBody: Buffer.from(d.raw) }), false);
    assert.equal(verifyWebhook({ headers: {}, rawBody: Buffer.from(d.raw) }), false);
    assert.equal(WEBHOOK_SECRET.length > 20, true);
  });

  it('parses deliveries and refuses ones addressed to another App', () => {
    const d = githubDelivery('push', { installation: { id: 7001 } }, { deliveryId: 'abc-1' });
    assert.deepEqual(parseWebhook({ headers: d.headers, body: { installation: { id: 7001 } } }), { deliveryId: 'abc-1', eventType: 'push', action: null, externalAccountId: '7001' });
    const other = githubDelivery('push', {}, { appId: '1' });
    assert.throws(() => parseWebhook({ headers: other.headers, body: {} }), /another GitHub App/);
    assert.throws(() => parseWebhook({ headers: { 'x-github-event': 'push' }, body: {} }), /Missing/);
  });

  it('maps every supported event; webhook and sync agree on activity keys', () => {
    const issueObj = repo.issues[0];
    const sync = issueEnvelopes('github.com', repo.meta, issueObj);
    const hook = handleWebhook('github.com', { eventType: 'issues', action: 'opened', payload: { repository: repo.meta, issue: issueObj, sender: user(1, 'ana') } });
    const key = (envs) => envs.find((e) => e.type === 'activity' && e.activityType === 'created').dedupeKey;
    assert.equal(key(hook.envelopes), key(sync));
    assert.deepEqual(hook.resourceRef, { resourceType: 'repository', externalId: '501' });

    const pr = repo.pulls[0];
    const merged = handleWebhook('github.com', { eventType: 'pull_request', action: 'closed', payload: { repository: repo.meta, pull_request: { ...pr, state: 'closed', merged_at: at(9), closed_at: at(9), updated_at: at(9) }, sender: user(2, 'raj') } });
    assert.ok(merged.envelopes.some((e) => e.type === 'activity' && e.activityType === 'merged'));
    const requested = handleWebhook('github.com', { eventType: 'pull_request', action: 'review_requested', payload: { repository: repo.meta, pull_request: pr, requested_reviewer: user(1, 'ana'), sender: user(2, 'raj') } });
    assert.ok(requested.envelopes.some((e) => e.activityType === 'review_requested'));

    const rv = handleWebhook('github.com', { eventType: 'pull_request_review', action: 'submitted', payload: { repository: repo.meta, pull_request: pr, review: repo.reviews[3][0] } });
    assert.deepEqual(rv.envelopes.filter((e) => e.type === 'record').map((e) => e.recordType), ['pull_request', 'review']);
    const ic = handleWebhook('github.com', { eventType: 'issue_comment', action: 'created', payload: { repository: repo.meta, issue: { number: 3, pull_request: {} }, comment: repo.issueComments[1] } });
    assert.deepEqual(ic.envelopes.find((e) => e.type === 'record').parentRef, { recordType: 'pull_request', externalId: '501#3' });
    const rc = handleWebhook('github.com', { eventType: 'pull_request_review_comment', action: 'created', payload: { repository: repo.meta, pull_request: pr, comment: repo.reviewComments[0] } });
    assert.ok(!JSON.stringify(rc).includes('very long diff text'), 'diff hunks are not stored');

    const push = handleWebhook('github.com', {
      eventType: 'push',
      payload: {
        ref: 'refs/heads/feature-x',
        repository: repo.meta,
        sender: user(2, 'raj'),
        commits: [
          { id: 'ccc333', message: 'Add retries\n\nlonger text', timestamp: at(7), author: { name: 'Raj', username: 'raj' }, distinct: true },
          { id: 'ddd444', message: 'Someone else', timestamp: at(7), author: { name: 'X', username: 'other' }, distinct: true },
        ],
      },
    });
    const commits = push.envelopes.filter((e) => e.type === 'record');
    assert.deepEqual(commits.map((c) => [c.externalId, c.title, c.metadata.branch, c.authorRef?.externalUserId ?? null]), [
      ['501:ccc333', 'Add retries', 'feature-x', '2'],
      ['501:ddd444', 'Someone else', 'feature-x', null],
    ]);
    assert.deepEqual(handleWebhook('github.com', { eventType: 'push', payload: { ref: 'refs/tags/v1', repository: repo.meta } }).envelopes, []);
  });

  it('turns installation events into lifecycle changes', () => {
    const life = (eventType, action) => handleWebhook('github.com', { eventType, action, payload: {} }).lifecycle;
    assert.deepEqual(life('installation', 'deleted'), { status: 'disconnected', refreshResources: false });
    assert.deepEqual(life('installation', 'suspend'), { status: 'suspended', refreshResources: false });
    assert.deepEqual(life('installation', 'unsuspend'), { status: 'active', refreshResources: true });
    assert.deepEqual(life('installation_repositories', 'added'), { refreshResources: true });
    assert.deepEqual(handleWebhook('github.com', { eventType: 'ping', payload: {} }), { envelopes: [] });
    assert.deepEqual(handleWebhook('github.com', { eventType: 'star', payload: {} }), { envelopes: [] }, 'unsupported events are ignored');
    assert.throws(() => handleWebhook('github.com', { eventType: 'issues', action: 'opened', payload: { repository: repo.meta } }), (e) => e.kind === 'invalid_request');
  });
});
