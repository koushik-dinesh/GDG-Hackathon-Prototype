// Phase 3B: GitHub end to end against the real database and the fake GitHub server: connect through
// the API, repository discovery and mapping, full and incremental sync, worker restarts, rate
// limits, token refresh, failures, project mapping, identities and secrets.
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import * as queue from '../src/jobs/queue.js';
import * as connections from '../src/repositories/integrationConnectionsRepository.js';
import * as cursors from '../src/repositories/syncCursorsRepository.js';
import { createSyncEngine, syncEngine } from '../src/services/integrations/sync.js';
import { vault } from '../src/services/integrations/vault.js';
import { setLogLevelForTests } from '../src/utils/logger.js';
import { addInstallation, addRepo, at, commit, issue, issueComment, pull, review, reviewComment, user } from './integrations/fakeGithub.js';
import { WEBHOOK_SECRET, setupGithub } from './integrations/githubFixture.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ids = {};
const cookies = {};
let env;
let repo;
let connectionId;
let resourceId;

const as = (who) => ({
  get: (url) => request(app).get(url).set('Cookie', cookies[who]),
  post: (url, body) => request(app).post(url).set('Cookie', cookies[who]).send(body),
  patch: (url, body) => request(app).patch(url).set('Cookie', cookies[who]).send(body),
});
const count = async (sql, params = []) => (await pool.query(sql, params))[0][0].n;
const recordsByType = async () =>
  Object.fromEntries((await pool.query('SELECT record_type, COUNT(*) AS n FROM external_records GROUP BY record_type'))[0].map((r) => [r.record_type, r.n]));
const record = async (recordType, externalId) => (await pool.query('SELECT * FROM external_records WHERE record_type = ? AND external_id = ?', [recordType, externalId]))[0][0];

// Runs a resource sync to the end across budget reschedules (as the worker would); other outcomes are thrown.
async function syncAll(engine = syncEngine) {
  for (let i = 0; i < 40; i++) {
    try {
      return await engine.syncResource(resourceId);
    } catch (err) {
      if (!(err instanceof queue.RescheduleJob) || err.delayMs !== 0) throw err;
    }
  }
  throw new Error('sync did not finish');
}

function seedRepo() {
  addInstallation(env.gh.state, { id: 7001, login: 'acme' });
  repo = addRepo(env.gh.state, 7001, { id: 501, fullName: 'acme/payments', isPrivate: true });
  addRepo(env.gh.state, 7001, { id: 502, fullName: 'acme/web' });
  // Older than the 90-day backfill window but still open: the "open" pass must pick it up.
  issue(repo, 1, { updated: '2025-01-10T00:00:00Z', title: 'Ancient open bug', assignees: [user(3, 'mia')] });
  issue(repo, 2, { state: 'closed', updated: at(2), closedAt: at(2), reason: 'completed' });
  pull(repo, 3, { updated: at(3), reviewers: [user(1, 'ana')] });
  pull(repo, 4, { state: 'closed', updated: at(4), mergedAt: at(4) });
  review(repo, 3, { submitted: at(3, 12) });
  issueComment(repo, 2, { updated: at(2, 10) });
  issueComment(repo, 3, { onPull: true, updated: at(3, 11) });
  reviewComment(repo, 3, { updated: at(3, 13) });
  commit(repo, 'aaa111', { date: at(5) });
  commit(repo, 'bbb222', { date: at(6) });
}

async function connectGithub(who = 'admin', installationId = '7001') {
  const start = await as(who).post('/api/v1/integrations/github/connect');
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const redirect = new URL(start.body.redirectUrl);
  assert.equal(redirect.origin + redirect.pathname, 'https://github.com/apps/workagent-test/installations/new');
  return as(who).post('/api/v1/integrations/github/callback', { state: redirect.searchParams.get('state'), params: { installationId, setupAction: 'install' } });
}

before(async () => {
  await resetDatabase();
  env = await setupGithub();
  for (const [key, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['member', 'employee'],
    ['outsider', 'employee'],
  ]) {
    ids[key] = await createUser({ email: `${key}@gh.test`, role, fullName: `GH ${key}` });
    cookies[key] = await loginCookie(app, `${key}@gh.test`);
  }
  const [p] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Payments', ?, 'active')", [ids.manager]);
  ids.P = p.insertId;
  const [q] = await pool.execute("INSERT INTO projects (name, owner_user_id, status) VALUES ('Web', ?, 'active')", [ids.admin]);
  ids.Q = q.insertId;
  await pool.execute('INSERT INTO project_members (project_id, user_id) VALUES (?, ?)', [ids.P, ids.member]);
});
after(async () => {
  await env.teardown();
  await closeDatabase();
});
beforeEach(async () => {
  env.gh.reset();
  seedRepo();
  for (const t of ['jobs', 'record_links', 'activities', 'external_records', 'external_identities', 'webhook_deliveries', 'integration_resources', 'integration_connections']) await pool.query(`DELETE FROM ${t}`);
  const res = await connectGithub();
  assert.equal(res.status, 201, JSON.stringify(res.body));
  connectionId = res.body.connection.id;
  resourceId = res.body.resources.find((r) => r.name === 'acme/payments').id;
});

describe('connecting GitHub', () => {
  it('stores the installation and an encrypted installation token, and discovers repositories', async () => {
    const c = await connections.findById(connectionId);
    assert.deepEqual([c.provider, c.sourceInstance, c.externalAccountId, c.accountLogin, c.status], ['github', 'github.com', '7001', 'acme', 'active']);
    assert.equal(c.settings.repositorySelection, 'selected');
    const token = await vault.get(connectionId, 'installation_token');
    assert.match(token.value, /^ghs_fake_/);
    assert.ok(token.expiresAt > new Date(Date.now() + 50 * 60_000));
    const [[row]] = await pool.query('SELECT ciphertext FROM integration_credentials WHERE connection_id = ?', [connectionId]);
    assert.ok(!row.ciphertext.toString('latin1').includes(token.value), 'stored encrypted');

    const detail = await as('admin').get(`/api/v1/integrations/${connectionId}`);
    assert.deepEqual(detail.body.resources.map((r) => [r.name, r.isEnabled, r.metadata.visibility]), [
      ['acme/payments', false, 'private'],
      ['acme/web', false, 'public'],
    ]);
  });

  it('is admin-only and needs a valid installation', async () => {
    assert.equal((await as('manager').post('/api/v1/integrations/github/connect')).status, 403);
    const pending = await as('admin').post('/api/v1/integrations/github/connect');
    const state = new URL(pending.body.redirectUrl).searchParams.get('state');
    const res = await as('admin').post('/api/v1/integrations/github/callback', { state, params: { setupAction: 'request' } });
    assert.deepEqual([res.status, res.body.error.code], [400, 'PROVIDER_ERROR']);
    assert.match(res.body.error.message, /owner must approve/);
    assert.equal((await connectGithub('admin', '9999')).status, 404);
  });

  it('reconnecting the same installation keeps the connection and admin choices', async () => {
    await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { isEnabled: true, projectId: ids.P });
    await as('admin').post(`/api/v1/integrations/${connectionId}/disconnect`, {});
    const again = await connectGithub();
    assert.deepEqual([again.status, again.body.connection.id], [200, connectionId]);
    const r = again.body.resources.find((x) => x.id === resourceId);
    assert.deepEqual([r.isEnabled, r.projectId], [true, ids.P]);
  });

  it('refreshing keeps project mappings and enabled flags while repository details change', async () => {
    await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { isEnabled: true, projectId: ids.P });
    repo.meta.full_name = 'acme/payments-api';
    env.gh.state.repos['acme/payments-api'] = repo;
    delete env.gh.state.repos['acme/payments'];
    delete env.gh.state.repos['acme/web'];
    const res = await as('admin').post(`/api/v1/integrations/${connectionId}/resources/refresh`);
    assert.deepEqual(res.body.resources.map((x) => [x.name, x.accessStatus, x.isEnabled, x.projectId]), [
      ['acme/payments-api', 'accessible', true, ids.P],
      ['acme/web', 'removed', false, null],
    ]);
  });
});

describe('sync', () => {
  beforeEach(async () => {
    await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { isEnabled: true, projectId: ids.P });
  });

  it('backfills every stream into the mapped project, with parents and identities', async () => {
    const result = await syncAll();
    assert.equal(result.status, 'done');
    assert.deepEqual(await recordsByType(), { repository: 1, issue: 2, pull_request: 2, review: 1, comment: 2, review_comment: 1, commit: 2 });

    const ancient = await record('issue', '501#1');
    assert.equal(ancient.title, 'Ancient open bug', 'open items older than the backfill window are included');
    assert.equal(ancient.project_id, ids.P);
    assert.equal(ancient.external_key, 'acme/payments#1');
    const meta = typeof ancient.metadata === 'string' ? JSON.parse(ancient.metadata) : ancient.metadata;
    assert.deepEqual(meta.assignees, [{ id: 3, login: 'mia' }]);

    const merged = await record('pull_request', '501#4');
    assert.deepEqual([merged.state, merged.status_category], ['merged', 'done']);
    const pr3 = await record('pull_request', '501#3');
    assert.equal((await record('review', String(repo.reviews[3][0].id))).parent_record_id, pr3.id);
    assert.equal((await record('comment', String(repo.issueComments[1].id))).parent_record_id, pr3.id, 'PR conversation comment');
    assert.equal((await record('comment', String(repo.issueComments[0].id))).parent_record_id, (await record('issue', '501#2')).id);
    assert.equal((await record('review_comment', String(repo.reviewComments[0].id))).parent_record_id, pr3.id);

    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records WHERE project_id <=> ?', [ids.P]), 11, 'everything follows the repository');
    assert.equal(await count("SELECT COUNT(*) AS n FROM activities WHERE activity_type = 'merged'"), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM activities WHERE project_id <> ? OR project_id IS NULL', [ids.P]), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM external_identities WHERE provider = 'github' AND user_id IS NOT NULL"), 0, 'no name-based matching');
    const cs = await cursors.listForResource(resourceId);
    assert.deepEqual(cs.map((c) => [c.stream, c.phase]), ['commits', 'issue_comments', 'issues', 'pulls', 'repository', 'review_comments'].map((s) => [s, 'incremental']));
    assert.ok(env.gh.state.calls.every((c) => !/contents|\/git\/|tarball|zipball/.test(c.line)), 'no repository contents downloaded');
  });

  it('is idempotent and incremental: only changes are fetched and written', async () => {
    await syncAll();
    const before = await count('SELECT COUNT(*) AS n FROM activities');
    env.gh.state.calls.length = 0;
    await syncAll();
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records'), 11, 'no duplicates');
    assert.equal(await count('SELECT COUNT(*) AS n FROM activities'), before);
    const issueCalls = env.gh.state.calls.filter((c) => c.line === 'GET /repos/acme/payments/issues');
    assert.ok(issueCalls.every((c) => c.query.since && c.query.state === 'all'), 'incremental runs use since');

    issue(repo, 5, { updated: '2026-10-20T00:00:00Z', title: 'New issue' });
    repo.issues[1].title = 'Renamed closed issue';
    repo.issues[1].updated_at = '2026-10-21T00:00:00Z';
    commit(repo, 'ccc333', { date: '2026-10-22T00:00:00Z' });
    const r = await syncAll();
    assert.equal(r.status, 'done');
    assert.equal((await record('issue', '501#5')).title, 'New issue');
    assert.equal((await record('issue', '501#2')).title, 'Renamed closed issue');
    assert.ok(await record('commit', '501:ccc333'));
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records'), 13);
  });

  it('survives a worker restart mid-backfill without losing or duplicating progress', async () => {
    for (let n = 10; n < 260; n++) issue(repo, n, { state: 'closed', updated: `2026-10-0${1 + (n % 8)}T${String(n % 24).padStart(2, '0')}:00:00Z`, closedAt: '2026-10-09T00:00:00Z' });
    const workerA = createSyncEngine({ budget: { ms: 60_000, requests: 100, chunks: 3 } });
    await assert.rejects(workerA.syncResource(resourceId), queue.RescheduleJob);
    const mid = await count("SELECT COUNT(*) AS n FROM external_records WHERE record_type = 'issue'");
    assert.ok(mid > 0 && mid < 252, `partial progress committed (${mid})`);
    // "Restart": a new engine instance (as a new worker process) continues from the saved cursors.
    const workerB = createSyncEngine({ budget: { ms: 60_000, requests: 100, chunks: 50 } });
    let status;
    for (let i = 0; i < 10 && status !== 'done'; i++) {
      try {
        status = (await workerB.syncResource(resourceId)).status;
      } catch (err) {
        if (!(err instanceof queue.RescheduleJob)) throw err;
      }
    }
    assert.equal(status, 'done');
    assert.equal(await count("SELECT COUNT(*) AS n FROM external_records WHERE record_type = 'issue'"), 252);
    assert.equal(await count("SELECT COUNT(*) AS n FROM activities WHERE activity_type = 'closed'"), 251, 'one activity per closed issue');
  });

  it('pauses the connection on rate limits (primary and secondary) without using job attempts', async () => {
    env.gh.state.failNext.push({ match: /GET \/repos\/acme\/payments\/issues/, status: 403, remaining: 0, body: { message: 'API rate limit exceeded' } });
    await assert.rejects(syncAll(), (e) => e instanceof queue.RescheduleJob);
    assert.ok((await connections.findById(connectionId)).pausedUntil > new Date());

    await connections.update(pool, connectionId, { pausedUntil: null });
    env.gh.state.rateLimitRemaining = 5000;
    env.gh.state.failNext.push({ match: /GET \/repos\/acme\/payments\/pulls/, status: 403, body: { message: 'You have exceeded a secondary rate limit' }, headers: { 'retry-after': '30' } });
    await assert.rejects(syncAll(), (e) => e instanceof queue.RescheduleJob && e.delayMs > 25_000 && e.delayMs <= 31_000);

    await connections.update(pool, connectionId, { pausedUntil: null });
    env.gh.state.rateLimitRemaining = 100; // below the 200 reserve: stop before running out
    await assert.rejects(syncAll(), (e) => e instanceof queue.RescheduleJob);
    assert.equal((await connections.findById(connectionId)).rateLimitRemaining < 200, true);
  });

  it('refreshes a revoked or expired token and carries on', async () => {
    for (const t of env.gh.state.tokens.values()) t.revoked = true;
    assert.equal((await syncAll()).status, 'done');
    await pool.execute("UPDATE integration_credentials SET expires_at = DATE_ADD(NOW(), INTERVAL 1 MINUTE) WHERE kind = 'installation_token'");
    const minted = env.gh.state.tokenCounter;
    await syncAll();
    assert.equal(env.gh.state.tokenCounter, minted + 1, 'expiring soon: renewed before use');
  });

  it('recovers from transient errors and flags a removed installation for reconnect', async () => {
    env.gh.state.failNext.push({ match: /GET \/repos\/acme\/payments\/commits/, status: 502 });
    await assert.rejects(syncAll(), (e) => e.kind === 'transient' && e.retryable);
    assert.equal((await connections.findById(connectionId)).health, 'degraded');
    assert.equal((await syncAll()).status, 'done', 'resumes from its cursors');
    assert.equal((await connections.findById(connectionId)).health, 'healthy');

    delete env.gh.state.installations['7001'];
    for (const t of env.gh.state.tokens.values()) t.revoked = true;
    await assert.rejects(syncAll(), queue.PermanentJobError);
    const c = await connections.findById(connectionId);
    assert.deepEqual([c.status, c.health], ['error', 'failing']);
    assert.match(c.lastErrorMessage, /connect GitHub again/);
  });

  it('skips disabled repositories and handles empty ones', async () => {
    repo.commits.length = 0;
    assert.equal((await syncAll()).status, 'done', 'empty commit history (409) is fine');
    await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { isEnabled: false });
    assert.equal((await syncAll()).status, 'skipped');
  });
});

describe('projects and visibility', () => {
  beforeEach(async () => {
    await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { isEnabled: true, projectId: ids.P });
    await syncAll();
  });

  it('shows GitHub work only to people who can see the mapped project', async () => {
    const forMember = await as('member').get(`/api/v1/external-records?projectId=${ids.P}&recordType=pull_request`);
    assert.deepEqual(forMember.body.records.map((r) => r.externalKey).sort(), ['acme/payments#3', 'acme/payments#4']);
    assert.equal((await as('outsider').get(`/api/v1/external-records?projectId=${ids.P}`)).status, 404);
    const timeline = await as('member').get(`/api/v1/activities?projectId=${ids.P}&limit=100`);
    assert.ok(timeline.body.activities.some((a) => a.activityType === 'review_submitted'));
    assert.equal((await as('manager').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { projectId: ids.Q })).status, 403, 'only admins map repositories');
  });

  it('re-mapping the repository moves its records and activities; hand-moved records stay', async () => {
    const pr3 = await record('pull_request', '501#3');
    await request(app).put(`/api/v1/external-records/${pr3.id}/project`).set('Cookie', cookies.admin).send({ projectId: ids.P });
    await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { projectId: ids.Q });
    assert.equal(await count('SELECT COUNT(*) AS n FROM external_records WHERE project_id = ?', [ids.Q]), 10);
    assert.equal((await record('pull_request', '501#3')).project_id, ids.P, 'manually assigned project protected');
    assert.equal(await count('SELECT COUNT(*) AS n FROM activities a JOIN external_records r ON r.id = a.external_record_id WHERE a.project_id <> r.project_id'), 0);
    // A later sync keeps both.
    repo.pulls[0].updated_at = '2026-10-25T00:00:00Z';
    await syncAll();
    assert.equal((await record('pull_request', '501#3')).project_id, ids.P);
  });

  it('identities are kept as GitHub accounts; manual mappings survive later syncs', async () => {
    const people = await as('admin').get('/api/v1/integrations/identities?provider=github&unmatched=true');
    const ana = people.body.identities.find((i) => i.login === 'ana');
    assert.ok(ana, 'unregistered GitHub people are kept, unmatched');
    assert.equal(ana.externalUserId, '1');
    await as('admin').patch(`/api/v1/integrations/identities/${ana.id}`, { userId: ids.member });
    // GitHub returns the current login on every object; rename the user everywhere in the fixture.
    JSON.stringify(repo, (k, v) => {
      if (v && typeof v === 'object' && v.id === 1 && v.login === 'ana') v.login = 'ana-renamed';
      return v;
    });
    review(repo, 4, { submitted: '2026-10-26T00:00:00Z', reviewer: { id: 1, login: 'ana-renamed', type: 'User' } });
    repo.pulls[1].updated_at = '2026-10-26T00:00:00Z';
    await syncAll();
    const [[row]] = await pool.query("SELECT login, user_id, match_method FROM external_identities WHERE provider = 'github' AND external_user_id = '1'");
    assert.deepEqual([row.login, row.user_id, row.match_method], ['ana-renamed', ids.member, 'manual']);
  });
});

describe('secrets', () => {
  it('private key, installation tokens and webhook secret never leak', async () => {
    const lines = [];
    const write = process.stdout.write.bind(process.stdout);
    const ewrite = process.stderr.write.bind(process.stderr);
    setLogLevelForTests('debug');
    process.stdout.write = (c, ...r) => (String(c).startsWith('{"time"') ? lines.push(String(c)) : write(c, ...r));
    process.stderr.write = (c, ...r) => (String(c).startsWith('{"time"') ? lines.push(String(c)) : ewrite(c, ...r));
    const bodies = [];
    try {
      await as('admin').patch(`/api/v1/integrations/${connectionId}/resources/${resourceId}`, { isEnabled: true, projectId: ids.P });
      await syncAll();
      for (const t of env.gh.state.tokens.values()) t.revoked = true;
      await syncAll();
      for (const url of ['/api/v1/integrations', `/api/v1/integrations/${connectionId}`, '/api/v1/integrations/providers', '/api/v1/integrations/identities']) {
        bodies.push(JSON.stringify((await as('admin').get(url)).body));
      }
      env.gh.state.failNext.push({ match: /POST \/app\/installations/, status: 500 });
      await as('admin').post(`/api/v1/integrations/${connectionId}/disconnect`, {});
    } finally {
      process.stdout.write = write;
      process.stderr.write = ewrite;
      setLogLevelForTests('error');
    }
    const [jobs] = await pool.query('SELECT payload, last_error FROM jobs');
    const [audit] = await pool.query('SELECT before_json, after_json FROM audit_logs');
    const [conns] = await pool.query('SELECT * FROM integration_connections');
    const haystack = [...bodies, ...lines, JSON.stringify(jobs), JSON.stringify(audit), JSON.stringify(conns)].join('\n');
    const keyBody = env.privateKey.split('\n')[1];
    for (const secret of [keyBody, WEBHOOK_SECRET, ...env.gh.state.tokens.keys()]) {
      assert.ok(!haystack.includes(secret), `leaked: ${secret.slice(0, 10)}…`);
    }
    assert.ok(!/eyJhbGciOiJSUzI1Ni/.test(haystack), 'no App JWT anywhere');
    assert.ok(lines.length > 5);
  });
});
