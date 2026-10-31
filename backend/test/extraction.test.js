// End-to-end extraction pipeline: API -> jobs table -> worker -> (mocked) Claude -> validation -> MySQL.
// Claude is always mocked here; config.ai.apiKey is forced off under NODE_ENV=test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { aiExtract } from '../src/jobs/handlers/aiExtract.js';
import { handlersFor } from '../src/jobs/handlers/index.js';
import * as queue from '../src/jobs/queue.js';
import { processNext, recover } from '../src/jobs/runner.js';
import { claude, classifyError } from '../src/services/ai/claudeClient.js';
import { closeDatabase, createUser, loginCookie, resetDatabase } from './helpers.js';

const app = createApp();
const ENGLISH = readFileSync(new URL('./fixtures/english-standup.txt', import.meta.url), 'utf8');
const MULTILINGUAL = readFileSync(new URL('./fixtures/multilingual-planning.json', import.meta.url), 'utf8');
const original = { ...claude };

let admins; // two admin cookies, so the per-admin extract rate limit (10/min) isn't hit
let employee;
let users;
let calls; // prompts sent to the fake Claude

// ---------- fake Claude ----------

const ev = (ref, quote) => ({ segment_ref: ref, speaker: null, timestamp: null, quote });
const item = (o) => ({
  description: '',
  assignee_confidence: 0.9,
  due_date_resolved: null,
  due_date_is_ambiguous: false,
  priority: 'medium',
  ai_confidence: 0.9,
  needs_review_reason: null,
  ...o,
});

// What a well-behaved model would return for english-standup.txt (meeting on Wed 2026-11-04).
const ENGLISH_RESPONSE = {
  action_items: [
    item({ title: 'Send final pricing deck to sales', assignee_name_raw: 'Raj Patel', due_date_raw: 'by Friday', due_date_resolved: '2026-11-06', evidence: [ev('S2', "I'll send the final pricing deck to the sales team by Friday")] }),
    item({ title: 'Send the final pricing deck to the sales team', assignee_name_raw: 'Raj Patel', due_date_raw: 'by Friday', due_date_resolved: '2026-11-06', evidence: [ev('S2', 'final pricing deck')] }),
    item({ title: 'Book the launch venue', assignee_name_raw: 'Sam Lee', due_date_raw: 'by the end of the month', due_date_resolved: '2026-11-30', evidence: [ev('S3', 'Sam, can you book the venue'), ev('S4', "I'll book the venue by the end of the month")] }),
    item({ title: 'Update the onboarding docs', assignee_name_raw: 'Priya', due_date_raw: 'next Friday', due_date_is_ambiguous: true, evidence: [ev('S8', "I'll update the onboarding docs next Friday")] }),
    item({ title: 'Check the contract with legal', assignee_name_raw: null, assignee_confidence: 0, due_date_raw: 'soon', due_date_is_ambiguous: true, ai_confidence: 0.6, needs_review_reason: 'No owner', evidence: [ev('S9', 'someone needs to check the contract with legal soon')] }),
    item({ title: 'Approve marketing budget', assignee_name_raw: 'Jane Liu', due_date_raw: null, evidence: [ev('S1', 'We approved the marketing budget')] }),
  ],
};

const ok = (body) => async (prompt) => {
  calls.push(prompt);
  return { text: typeof body === 'string' ? body : JSON.stringify(body), stopReason: 'end_turn', model: 'claude-test-model', usage: { inputTokens: 1234, outputTokens: 567 } };
};
const fails = (err) => async (prompt) => {
  calls.push(prompt);
  throw err;
};
const apiError = (Cls, status, message) => classifyError(new Cls(status, { type: 'error', error: { type: 'x', message } }, message, new Headers()));

// ---------- helpers ----------

const as = (cookie) => ({
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
});
let turn = 0;
const admin = () => as(admins[turn++ % admins.length]);

async function meetingWithTranscript({ content = ENGLISH, filename, scheduledAt = '2026-11-04T10:00:00Z' } = {}) {
  const m = await admin().post('/api/v1/meetings', {
    title: 'Launch sync',
    meetingUrl: 'https://meet.google.com/abc-defg-hij',
    scheduledAt,
    participantIds: [users.raj, users.sam],
  });
  assert.equal(m.status, 201);
  if (content) {
    const up = await admin().post(`/api/v1/meetings/${m.body.meeting.id}/transcript/upload`, { content, ...(filename && { filename }) });
    assert.equal(up.status, 201);
  }
  return m.body.meeting.id;
}

const extract = (id) => admin().post(`/api/v1/meetings/${id}/extract`);
// These tests exercise the extraction worker; other job types (e.g. correlation) are not its concern.
const handlers = handlersFor(['ai.extract']);
const work = () => processNext('test-worker', handlers);
const meetingRow = async (id) => (await pool.query('SELECT status, last_error FROM meetings WHERE id = ?', [id]))[0][0];
const runsFor = async (id) => (await pool.query('SELECT * FROM extraction_runs WHERE meeting_id = ? ORDER BY id', [id]))[0];
const jobsFor = async (id) => (await pool.query("SELECT * FROM jobs WHERE JSON_EXTRACT(payload, '$.meetingId') = ? ORDER BY id", [id]))[0];
const itemCount = async (id) => (await pool.query('SELECT COUNT(*) AS n FROM action_items WHERE meeting_id = ?', [id]))[0][0].n;
const makeDue = (jobId) => pool.query('UPDATE jobs SET run_at = NOW() WHERE id = ?', [jobId]);

before(async () => {
  await resetDatabase();
  await createUser({ email: 'admin1@example.test', role: 'admin', fullName: 'Admin One' });
  await createUser({ email: 'admin2@example.test', role: 'admin', fullName: 'Admin Two' });
  await createUser({ email: 'emp@example.test', fullName: 'Eve Employee' });
  users = {
    jane: await createUser({ email: 'jane@example.test', fullName: 'Jane Liu' }),
    raj: await createUser({ email: 'raj@example.test', fullName: 'Raj Patel' }),
    sam: await createUser({ email: 'sam.lee@example.test', fullName: 'Sam Lee' }),
    samC: await createUser({ email: 'sam.carter@example.test', fullName: 'Sam Carter' }),
    priya: await createUser({ email: 'priya@example.test', fullName: 'Priya Shah' }),
    ana: await createUser({ email: 'ana@example.test', fullName: 'Ana Garcia' }),
    jonas: await createUser({ email: 'jonas@example.test', fullName: 'Jonas Weber', isActive: false }),
  };
  admins = [await loginCookie(app, 'admin1@example.test'), await loginCookie(app, 'admin2@example.test')];
  employee = await loginCookie(app, 'emp@example.test');
});
beforeEach(() => {
  calls = [];
  claude.isConfigured = () => true;
  claude.model = () => 'claude-test-model';
  claude.extract = ok(ENGLISH_RESPONSE);
});
afterEach(() => Object.assign(claude, original));
after(closeDatabase);

// ---------- tests ----------

describe('authorization and preconditions', () => {
  it('forbids employees and unauthenticated users', async () => {
    const id = await meetingWithTranscript();
    assert.equal((await request(app).post(`/api/v1/meetings/${id}/extract`)).status, 401);
    assert.equal((await as(employee).post(`/api/v1/meetings/${id}/extract`)).status, 403);
    assert.equal((await as(employee).get(`/api/v1/meetings/${id}/action-items`)).status, 403);
    assert.equal((await jobsFor(id)).length, 0);
  });

  it('returns 503 when the Claude API is not configured', async () => {
    claude.isConfigured = () => false;
    const id = await meetingWithTranscript();
    const res = await extract(id);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'AI_NOT_CONFIGURED');
    assert.equal((await meetingRow(id)).status, 'transcript_ready');
  });

  it('requires a transcript', async () => {
    const id = await meetingWithTranscript({ content: null });
    const res = await extract(id);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'TRANSCRIPT_REQUIRED');
    assert.equal((await runsFor(id)).length, 0);
  });

  it('404s for unknown meetings and validates the id', async () => {
    assert.equal((await extract(999999)).status, 404);
    assert.equal((await extract('abc')).status, 400);
  });
});

describe('successful extraction', () => {
  let id;
  let prompt; // what the worker sent to (fake) Claude

  it('queues a job and returns 202 without calling Claude', async () => {
    id = await meetingWithTranscript();
    const res = await extract(id);
    assert.equal(res.status, 202);
    assert.equal(res.body.extraction.status, 'queued');
    assert.equal(res.body.extraction.job.status, 'pending');
    assert.equal(calls.length, 0);
    assert.equal((await meetingRow(id)).status, 'extracting');
  });

  it('rejects a duplicate request while one is queued', async () => {
    const res = await extract(id);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'EXTRACTION_IN_PROGRESS');
    assert.equal((await jobsFor(id)).length, 1);
    assert.equal((await runsFor(id)).length, 1);
  });

  it('blocks transcript replacement while extracting', async () => {
    const res = await admin().post(`/api/v1/meetings/${id}/transcript/upload`, { content: 'Jane: replaced' });
    assert.equal(res.status, 409);
  });

  it('the worker processes the job and saves validated items with evidence', async () => {
    assert.equal(await work(), true);
    assert.equal(calls.length, 1);
    [prompt] = calls;

    const meeting = await meetingRow(id);
    assert.equal(meeting.status, 'review_pending');
    assert.equal(meeting.last_error, null);

    const [run] = await runsFor(id);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.attempts, 1);
    assert.equal(run.model, 'claude-test-model');
    assert.equal(run.input_tokens, 1234);
    assert.equal(run.output_tokens, 567);
    assert.equal(run.summary.returned, 6);
    assert.equal(run.summary.saved, 4);
    assert.equal(run.summary.merged, 1);
    assert.equal(run.summary.rejected, 1);
    assert.match(run.summary.rejectedItems[0].reasons[0], /could be found/);

    const [job] = await jobsFor(id);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.dedupe_key, null);
  });

  it('exposes items, evidence, flags and extraction status through the API', async () => {
    const res = await admin().get(`/api/v1/meetings/${id}/action-items`);
    assert.equal(res.status, 200);
    const byTitle = Object.fromEntries(res.body.actionItems.map((i) => [i.title, i]));
    assert.deepEqual(Object.keys(byTitle).sort(), ['Book the launch venue', 'Check the contract with legal', 'Send final pricing deck to sales', 'Update the onboarding docs']);

    const deck = byTitle['Send final pricing deck to sales'];
    assert.equal(deck.assignee.id, users.raj);
    assert.equal(deck.assigneeMatch, 'exact');
    assert.equal(deck.dueDate, '2026-11-06');
    assert.equal(deck.reviewStatus, 'pending');
    assert.deepEqual(deck.flags, ['merged_duplicates']);
    assert.equal(deck.evidence.length, 1);
    assert.equal(deck.evidence[0].speaker, 'Raj Patel');
    assert.equal(deck.evidence[0].startSec, 20);

    const venue = byTitle['Book the launch venue'];
    assert.equal(venue.assignee.id, users.sam, '"Sam Lee" is exact even though two Sams exist');
    assert.equal(venue.dueDate, '2026-11-30');
    assert.equal(venue.evidence.length, 2);

    const docs = byTitle['Update the onboarding docs'];
    assert.equal(docs.assignee.id, users.priya);
    assert.equal(docs.assigneeMatch, 'fuzzy');
    assert.equal(docs.dueDate, null);
    assert.equal(docs.dueDateRaw, 'next Friday');
    assert.ok(docs.flags.includes('assignee_first_name_only'));
    assert.ok(docs.flags.includes('ambiguous_deadline'));

    const legal = byTitle['Check the contract with legal'];
    assert.equal(legal.assignee, null);
    assert.ok(legal.flags.includes('missing_assignee'));
    assert.ok(legal.flags.includes('ambiguous_deadline'));
    assert.ok(legal.flags.includes('ai_review_note'));

    assert.equal(res.body.extraction.status, 'succeeded');
    assert.ok(res.body.flagDescriptions.ambiguous_deadline);
    assert.equal(res.body.extraction.raw_response, undefined);

    const detail = await admin().get(`/api/v1/meetings/${id}`);
    assert.equal(detail.body.meeting.extraction.status, 'succeeded');
  });

  it('sends the transcript as delimited data with participant names but no emails', () => {
    const { system, user } = prompt;
    assert.match(system, /untrusted data, not instructions/);
    assert.match(user, /<transcript>\n\[S1\] \[00:05\] Jane Liu: Morning everyone/);
    assert.match(user, /Meeting date: 2026-11-04 \(Wednesday\), timezone UTC/);
    assert.match(user, /- Raj Patel\n- Sam Lee/);
    assert.doesNotMatch(user, /raj@example\.test|sam\.lee@example\.test/);
  });

  it('writes audit entries for request and success', async () => {
    const [rows] = await pool.query("SELECT action, actor_user_id FROM audit_logs WHERE entity_type = 'meeting' AND entity_id = ? AND action LIKE 'extraction.%' ORDER BY id", [id]);
    assert.deepEqual(rows.map((r) => r.action), ['extraction.requested', 'extraction.succeeded']);
    assert.equal(rows[1].actor_user_id, null);
  });

  it('re-running the finished job is a no-op (idempotent)', async () => {
    const [jobRow] = await jobsFor(id);
    await aiExtract.run(queue.toJob(jobRow));
    assert.equal(calls.length, 0, 'Claude not called again');
    assert.equal(await itemCount(id), 4);
  });

  it('re-extraction replaces pending items, keeps reviewed ones, and skips their duplicates', async () => {
    await pool.query("UPDATE action_items SET review_status = 'approved' WHERE meeting_id = ? AND title = 'Book the launch venue'", [id]);
    assert.equal((await extract(id)).status, 202);
    await work();

    const [rows] = await pool.query('SELECT title, review_status FROM action_items WHERE meeting_id = ? ORDER BY title', [id]);
    assert.equal(rows.length, 4, 'no duplicates after re-extraction');
    assert.equal(rows.filter((r) => r.title === 'Book the launch venue').length, 1);
    assert.equal(rows.find((r) => r.title === 'Book the launch venue').review_status, 'approved');

    const runs = await runsFor(id);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].summary.replacedPending, 3);
    assert.ok(runs[1].summary.rejectedItems.some((r) => /Duplicate of already reviewed item/.test(r.reasons[0])));
    const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM action_item_evidence e JOIN action_items a ON a.id = e.action_item_id WHERE a.meeting_id = ?', [id]);
    assert.equal(n, 5, 'old evidence rows removed with their items');
  });
});

describe('failures and retries', () => {
  it('retries a transient provider error, then succeeds', async () => {
    const id = await meetingWithTranscript();
    claude.extract = fails(apiError(Anthropic.InternalServerError, 529, 'Overloaded'));
    await extract(id);
    await work();

    let [job] = await jobsFor(id);
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 1);
    assert.match(job.last_error, /529/);
    let [run] = await runsFor(id);
    assert.equal(run.status, 'queued');
    assert.match(run.error, /Overloaded/);
    assert.equal((await meetingRow(id)).status, 'extracting');
    assert.equal(await itemCount(id), 0);

    assert.equal(await work(), false, 'backoff: not due yet');
    claude.extract = ok(ENGLISH_RESPONSE);
    await makeDue(job.id);
    await work();
    [job] = await jobsFor(id);
    [run] = await runsFor(id);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.attempts, 2);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.attempts, 2);
    assert.equal(await itemCount(id), 4);
  });

  it('fails permanently on a non-retryable provider error and keeps earlier items', async () => {
    const id = await meetingWithTranscript();
    await extract(id);
    await work();
    assert.equal(await itemCount(id), 4);

    claude.extract = fails(apiError(Anthropic.AuthenticationError, 401, 'invalid x-api-key'));
    await extract(id);
    await work();

    const jobs = await jobsFor(id);
    assert.equal(jobs[1].status, 'failed');
    assert.equal(jobs[1].attempts, 1);
    const runs = await runsFor(id);
    assert.equal(runs[1].status, 'failed');
    const meeting = await meetingRow(id);
    assert.equal(meeting.status, 'failed');
    assert.equal(meeting.last_error, 'The AI provider rejected the API key');
    assert.equal(await itemCount(id), 4, 'previous results untouched');

    // An admin can retry from "failed".
    claude.extract = ok(ENGLISH_RESPONSE);
    assert.equal((await extract(id)).status, 202);
    await work();
    assert.equal((await meetingRow(id)).status, 'review_pending');
    assert.equal(await itemCount(id), 4);
  });

  it('retries invalid structured output, then gives up without saving anything', async () => {
    const id = await meetingWithTranscript();
    claude.extract = ok('this is not JSON');
    await extract(id);
    const [job] = await jobsFor(id);
    for (let i = 0; i < job.max_attempts; i++) {
      await makeDue(job.id);
      await work();
    }
    const [final] = await jobsFor(id);
    assert.equal(final.status, 'dead');
    assert.equal(final.attempts, final.max_attempts);
    assert.equal(calls.length, final.max_attempts);
    const [run] = await runsFor(id);
    assert.equal(run.status, 'failed');
    assert.match(run.error, /not valid JSON/);
    const meeting = await meetingRow(id);
    assert.equal(meeting.status, 'failed');
    assert.equal(meeting.last_error, 'The AI returned an invalid response');
    assert.equal(await itemCount(id), 0);
  });

  it('fails the job if the worker has no API key', async () => {
    const id = await meetingWithTranscript();
    await extract(id);
    claude.isConfigured = () => false;
    await work();
    const [job] = await jobsFor(id);
    assert.equal(job.status, 'failed');
    assert.equal(calls.length, 0);
    assert.equal((await meetingRow(id)).last_error, 'AI extraction is not configured');
  });

  it('saves nothing if the meeting changes while Claude is working', async () => {
    const id = await meetingWithTranscript();
    claude.extract = async (prompt) => {
      calls.push(prompt);
      await pool.query("UPDATE meetings SET status = 'transcript_ready' WHERE id = ?", [id]);
      return ok(ENGLISH_RESPONSE)(prompt);
    };
    await extract(id);
    await work();
    assert.equal(await itemCount(id), 0);
    assert.equal((await runsFor(id))[0].status, 'failed');
    assert.equal((await meetingRow(id)).status, 'transcript_ready', 'failure hook leaves a meeting it no longer owns alone');
  });
});

describe('worker interruption', () => {
  it('recovers a job whose worker died mid-extraction and completes it', async () => {
    const id = await meetingWithTranscript();
    await extract(id);
    const claimed = await queue.claimNext('crashed-worker', ['ai.extract']);
    assert.equal(claimed.payload.meetingId, id);
    await pool.query('UPDATE jobs SET locked_at = DATE_SUB(NOW(), INTERVAL 10 MINUTE) WHERE id = ?', [claimed.id]);

    assert.equal(await work(), false, 'a running job is not claimed again before recovery');
    assert.deepEqual(await recover(handlers), { requeued: 1, dead: 0 });
    await work();

    const [job] = await jobsFor(id);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.attempts, 2);
    assert.equal((await meetingRow(id)).status, 'review_pending');
    assert.equal(await itemCount(id), 4);
  });
});

describe('multilingual transcript', () => {
  it('matches accented names, never assigns inactive users, and flags AI-only deadlines', async () => {
    const id = await meetingWithTranscript({ content: MULTILINGUAL, filename: 'vexa.json' });
    claude.extract = ok({
      action_items: [
        item({ title: 'Send the sales report', assignee_name_raw: 'Ana García', due_date_raw: 'el viernes', due_date_resolved: '2026-11-06', evidence: [ev('S1', 'Yo enviaré el informe de ventas el viernes')] }),
        item({ title: 'Handle the translation', assignee_name_raw: 'Jonas Weber', due_date_raw: 'bis morgen', due_date_resolved: '2026-11-05', evidence: [ev('S2', 'Ich kümmere mich bis morgen um die Übersetzung')] }),
      ],
    });
    await extract(id);
    await work();

    assert.match(calls[0].user, /\[S1\] \[00:03\] Ana García \(es\): Yo enviaré/);
    assert.doesNotMatch(calls[0].user, /draft words/, 'incomplete Vexa segments are not sent');

    const res = await admin().get(`/api/v1/meetings/${id}/action-items`);
    const [report, translation] = res.body.actionItems;
    assert.equal(report.assignee.id, users.ana);
    assert.equal(report.dueDate, '2026-11-06');
    assert.ok(report.flags.includes('deadline_needs_confirmation'));
    assert.equal(translation.assignee, null);
    assert.ok(translation.flags.includes('inactive_assignee'));
    assert.equal(translation.dueDate, '2026-11-05');
    assert.equal(translation.evidence[0].excerpt, 'Ich kümmere mich bis morgen um die Übersetzung');
  });
});
