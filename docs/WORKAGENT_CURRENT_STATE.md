# WorkAgent — Current State (assessment of 2026-10-30)

> **Update: Phase 8 operations center complete (2026-10-31).** Implemented, tested and browser-verified (admin, test database).
> - `GET /api/v1/ops/summary|jobs|audit|audit/actions|emails|ai-runs`, `POST /api/v1/ops/jobs/:id/retry|cancel` (admin-only; `services/ops.js`).
> - Dead-letter handling: failed/dead jobs can be retried (fresh attempts, dedupe key restored, duplicates refused) and waiting jobs cancelled — only for job types whose re-run is safe (integration sync/maintenance, correlation). E-mail, extraction, webhook and bot jobs name their own retry action, which also resets their domain state. Every action is audited (`job.retried`, `job.cancelled`).
> - Audit log viewer (filters by action or action prefix, actor, entity, dates; keyset paging; before/after on demand), e-mail delivery history with retry (no bodies), AI extraction runs with tokens, duration and errors (no model output). AI cost is shown only when `AI_PRICE_INPUT_USD_PER_MTOK`/`AI_PRICE_OUTPUT_USD_PER_MTOK` are set — prices are never assumed.
> - UI: `/admin/operations` (Overview, Jobs, Audit log, E-mail, AI usage). The app header now wraps its navigation on narrow screens.
> - Migration `009_operations_center.sql` (indexes only). Dev DB migrated after backup `backups/meeting_action-pre-009-20261031-071203.sql` (145,773 bytes, verified complete); rollback `docs/runbooks/rollback-009.sql`.
> - Tests: backend 580/580 (7 new), frontend 110/110 (4 new), build OK.

> **Update: Microsoft Teams, Outlook, Google Meet and Figma connectors implemented (2026-10-31). None live-verified** (no provider credentials available).
> - Teams/Outlook (Microsoft Graph, one Entra app, delegated OAuth, delta sync, deletions as tombstones; no change notifications), Google Meet (Workspace OAuth, Meet events by sync token, conference records; no push), Figma (OAuth, files/comments/versions, deleted-file detection, passcode webhooks treated as nudges).
> - Tests against local fakes: Teams+Outlook 25, Google Meet 14, Figma 15 (each with the shared contract suite and an API → sync engine end-to-end test). Backend 573/573.
> - Browser-verified against dev instances of the fakes: Connect → provider consent stand-in → setup page → connected (tenant/scopes shown) for all four; resources enabled and synced by the worker; their items appear in Activity with the right badges and summaries. The check found and fixed a too-strict GUID validation for `MS_CLIENT_ID`/`MS_TENANT_ID`.
> - Setup and live-verification steps: `docs/runbooks/integrations.md` §12–14.

> **Update: Jira Cloud connector implemented (2026-10-31). Not live-verified** (no Atlassian credentials available).
> - OAuth 2.0 (3LO) connect with site check and offline access, rotating refresh tokens in the vault, JQL sync (open issues of any age + `updated` incremental in the API user's time zone, page tokens, extra comments), issue links (blocks/duplicates/related/sub-tasks), people, signed webhooks (`X-Hub-Signature`, deduplicated by `X-Atlassian-Webhook-Identifier`), deletions kept as deleted, revoked grants → needs reconnect.
> - Shared OAuth helper (`providers/oauth2.js`), `form` bodies in the HTTP client, `ctx.credentials.peek()`; integration callback accepts parameters up to 4,096 characters.
> - Tested against a local fake Atlassian (`test/jira.test.js`, 22 tests incl. the contract suite and API → sync engine → webhook worker end to end). Browser-verified against the fake: Connect → consent → setup page → connection with site/scopes, project mapping, Sync now via the worker, Jira items in Activity and insights. The browser check found and fixed a wrong config path for the OAuth redirect URL.
> - UI: provider badges and source filter for every connector; an Authorization panel for OAuth connections. Setup: `docs/runbooks/integrations.md` §11.

> **Update: Phase 7 insights engine complete (2026-10-31).** Implemented and tested; browser-verified for admin (`/admin` dashboard), manager and employee (`/insights`) on the test database.
> - **API:** `GET /api/v1/insights?projectId&teamId&from&to` (`services/insights.js`), computed on request from tasks, meetings, synced records, activities and confirmed relationships. No new tables or migration.
> - **What it reports:**
>   - per-project health with the facts behind it (open/overdue/blocked tasks, open issues and PRs, PRs waiting for review, stalled items, open dependencies, target date);
>   - overdue tasks (oldest first), blockers (blocked tasks, records labelled "blocked" at the source, confirmed `blocks`/`depends_on` relationships with an unfinished blocker, flagged when they cross projects);
>   - review progress per open, non-draft PR (awaiting first review / changes requested / approved not merged, days waiting, requested reviewers), PRs merged and median hours to merge;
>   - meeting follow-through (approved tasks done/open/overdue per meeting in the period);
>   - workload per assignee; stalled work (no update for 14+ days); weekly trend (tasks created/completed, records opened/closed, PRs merged);
>   - a summary of highlights generated from those figures only (no AI text).
> - **Facts vs inferences:** counts and lists are `kind: 'fact'`; project health and the "busiest person" note are `kind: 'inference'` with the rule that produced them. Thresholds are returned as `rules`.
> - **Visibility:** Phase 4 rules. Admins see everything; managers projects they own or belong to (all tasks of projects they own); employees their own tasks plus records and meetings of their projects. Health is computed on what the requester can see. A project or team filter the person cannot see is 404; bad periods are 400 (max one year).
> - **UI:** `/admin` is now the organisation dashboard (the placeholder is gone); `/insights` for managers and employees (nav link). Project, team and period filters; every item links to its task, meeting, project or record page.
> - **Tests:** backend 497/497 (7 new), frontend 106/106 (4 new), build OK.
> - **Limitations:** rule thresholds are constants (`RULES` in `services/insights.js`), not yet configurable; computed on request (fine at single-company scale; cache if the data grows); the team filter applies to people-based figures (tasks, overdue, workload, follow-through), not to synced records.

> **Update: Phase 5 complete — cross-application correlation (2026-10-31).** Implemented and tested; browser-verified with a manager account on the test database (worker-produced suggestions reviewed, confirmed and rejected).
> - **Matchers** (`services/correlation/matchers.js`), provider-independent, on the unified model only:
>   - *key-reference*: `owner/repo#N` and Jira-style `PAY-42` keys (0.9), `#N` within the same repository (0.75) → `references`;
>   - *wording-overlap*: an approved task and an issue/PR of the same project sharing ≥2 significant words covering ≥50% of the shorter text (0.45–0.9, +0.1 when the task assignee is the record's author via identities) → `tracks`;
>   - *meeting-window*: an issue/PR created from 1 day before to 3 days after a meeting of its project, sharing words with the meeting or its tasks (0.45–0.8) → `discussed_in`.
>   - Keys, URLs and shas are stripped before wording comparison, so identifiers never count as shared topic words.
> - **Engine** (`evaluate()` in `services/correlation/index.js`): runs built-in and registered matchers, never pairs a record with itself, skips any pair that already has a link in any status (so rejected suggestions are never resurrected and confirmed ones never duplicated), stores evidence `{matcher, reason, …}` and confidence. Suggestions are only ever `suggested`; people confirm or reject.
> - **Re-evaluation:** job `correlation.evaluate` (deduplicated per subject) is queued by ingest for every inserted/updated record and by audit entries for task approval/update/project change and meeting create/update/transcript/review completion.
> - **Deleted records:** a record deleted at the source withdraws its open suggestions (marked rejected, history kept); deleted records are never suggested as targets. Disconnected integrations keep their data and confirmed links.
> - **UI:** `/suggestions` (admins and managers): both ends, relationship type, matcher, confidence, reason, Confirm/Reject. Managers see suggestions within projects they manage; employees have no access (route-guarded, API 403/404).
> - **Tests:** backend 490/490 (13 new), frontend 102/102 (1 new), build OK. No migration.
> - **Limitations:** deterministic rules only (no embeddings/LLM similarity); MySQL natural-language FULLTEXT preselects candidates (no stemming); Jira keys only become useful once a Jira connector syncs records.

> **Update: Phase 4 complete — unified records, activities, relationships, feed and search (2026-10-31).** Implemented and tested; browser-verified with admin, manager and employee accounts on the test database.
> - **Activity vocabulary:** one verb set for every source (`services/activities/types.js`), enforced on connector envelopes.
> - **WorkAgent events** (tasks, meetings, projects) become activities from the audit entry of each change, in the same transaction.
>   - `npm run activities:backfill` recreates history and is idempotent. On the dev DB it created 36 activities, then 0 on the second run.
> - **Changes without a provider event** (status change, rename, deletion at the source, archival) become activities during ingest, deduplicated against webhook events.
> - **Unified record model:** any reference (external record, meeting, task, project, user) resolves to one summary shape with source status (`services/records/refs.js`). Shared visibility rules live in `services/records/access.js`.
> - **Relationships:** list, add, confirm and reject (removal = rejection, history kept). Admins anywhere; managers within projects they manage; employees read-only.
>   - GitHub-stated links: closing keywords, and a merged PR's merge commit.
>   - Correlation boundary for Phase 5 (`services/correlation/`): suggestions only, rejected ones never resurrected, matcher registry, identity/key/project-context helpers.
> - **Feed:** `GET /api/v1/activities` with filters for project, person, provider, type, subject type, status, dates and record; keyset paging; non-admins see their permitted scope without choosing a project; activities expose `subject`.
> - **Search:** `GET /api/v1/search` over projects, meetings, tasks and synced records, using MySQL FULLTEXT (migration 008) with a LIKE fallback for keys and short words; permission-filtered.
> - **UI:**
>   - Activity page (`/activity`) with filters and "Load more";
>   - record page (`/records/:id`) with source identity, source status, discussion, timeline and Related records;
>   - search page and header search box;
>   - provider badges and source links;
>   - "View all activity" on project pages;
>   - Related records on task and meeting pages.
> - **Database:** migration `008_unified_feed_search.sql` (indexes, FULLTEXT, link types `includes`/`tracks`). The dev DB is migrated (backup `backups/meeting_action-pre-008-20261031-055305.sql`). Rollback: `docs/runbooks/rollback-008.sql`.
> - **Tests:** backend 477/477 (21 new Phase 4 tests plus updated read-API tests), frontend 101/101 (10 new), build OK.
> - **Limitations:**
>   - Search relevance uses MySQL's boolean FULLTEXT mode (no stemming or typo tolerance).
>   - Backfilled summaries use names as they are at backfill time.
>   - Relationship suggestions need Phase 5 matchers to appear (added in Phase 5).

> **Update: Phase 3B GitHub App integration implemented (2026-10-30). Live GitHub has NOT been verified yet.**
> - **Connector:** `services/integrations/providers/github/` implements the Phase 3A contract: settings, App JWT and installation tokens, mappers, sync streams, webhooks. No GitHub-specific tables.
> - **Auth:**
>   - RS256 App JWT (9 min, cached);
>   - installation tokens (1 h) stored encrypted in the vault, renewed before expiry and after a 401;
>   - each installation verified through the App before connecting;
>   - suspended/unapproved/foreign installations refused with clear messages.
> - **Data:** repositories (metadata in resources, plus a repository record), issues, pull requests, reviews, issue/PR comments, review comments, commits (default branch by sync, every branch by push webhooks). No file contents.
> - **Sync:** backfill (open items of any age + changes in the window), then incremental from the last watermark. Paginated; resumable after a worker restart; GitHub primary/secondary rate limits pause the connection.
> - **Webhooks** (`X-Hub-Signature-256`, current and previous secret, foreign-App deliveries refused):
>   - `installation` (deleted/suspend/unsuspend/new_permissions_accepted), `installation_repositories`, `repository`;
>   - `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`;
>   - `push`, `ping`.
> - **Identities:** GitHub numeric user ids with logins preserved; unregistered people kept unmatched; **no automatic name/login/alias matching** (it was removed from ingest for all providers; only a provider-verified email matches automatically); manual mappings are never overwritten.
> - **Projects:** repository → project mapping flows to every record and activity; manual record moves stay protected.
> - **UI:**
>   - Integrations page: GitHub availability and webhook URL, connect, a people-mapping card.
>   - Connection page: installation access, permissions, a "Manage repository access on GitHub" link, error/retry hints.
>   - Project page: **Development** card (open issues/PRs and recent activity, filtered by project permissions).
> - **Schema:** migration `007_sync_cursor_completion.sql` (additive: `integration_sync_cursors.completed_at`). The sync engine now runs a resource's streams in order (parents first) across jobs. Dev DB migrated to 007 (backup in `backups/`).
> - **Tests:** backend **456/456** (46 new GitHub tests, including the contract suite against a fake GitHub over HTTP), frontend **91/91**, build OK.
> - **Browser check:** test DB with a local fake GitHub. Connect → install redirect → setup → repo mapping → sync → signed webhook (duplicate ignored, forged refused) → member sees the project's Development card. No tokens or keys in the logs.
> - **Blocker for live verification:** a real GitHub App (ID, slug, private key, webhook secret) and the tunnel hostname. Procedure: `docs/runbooks/integrations.md` §8.4.

> **Update: Phase 3A integration framework complete (2026-10-30, after the 2.5 note below).**
> - **Migrations:** 005 (integration framework) and 006 (work records). The dev DB is at 006, with backups in `backups/`.
> - **Backend** (`services/integrations/`):
>   - encrypted credential vault (AES-256-GCM, key rotation);
>   - provider registry and connector contract;
>   - same-origin HTTP client;
>   - sync engine (bounded chunks, cursors, rate-limit pause), scheduler, `WORKER_JOB_TYPES`;
>   - signed webhook intake with redelivery, replay and retention;
>   - idempotent, stale-safe ingest;
>   - read APIs (`/external-records`, `/activities`, `/record-links`) with project visibility;
>   - identity matching;
>   - admin API under `/integrations`.
> - **Frontend:** Admin → Integrations (list, connect, setup callback, connection detail).
> - **Tests:** backend **410/410** (126 new in Phase 3A, including a secret-leak regression across responses, logs, jobs, audit rows and stored rows), frontend **87/87**, build OK.
> - **Browser check:** test DB, fake provider. Connect, map, enable, sync and a signed webhook all worked; a forged webhook was refused.
> - **Not yet:** any real provider. GitHub is Phase 3B. The Cloudflare Tunnel path has not been exercised.

> **Update — Phase 2.5 closeout done (2026-10-30, later the same day).** This supersedes the matching rows below:
> - Phase 1 and Phase 2 are committed on branch `phase-2-work-management` (`d9c4139`, `60b487e`); 2.5 is committed on top.
> - The dev DB was backed up to `backups/meeting_action-pre-004-20261030-204126.sql` (gitignored), then migrated to 004. Existing data is intact (11 users, 9 items before verification).
> - Browser-verified on the real dev stack (API :4000 → dev DB, Vite :5173, Mailpit):
>   - admin invites a manager → email arrives in Mailpit with no password in it → token is removed from the address bar → activation → manager signs in;
>   - the manager sees no admin navigation, gets 403 from admin APIs, creates a project, becomes its owner and adds a member;
>   - an admin moves an approved item into the project from the review screen (new control);
>   - an admin-created meeting in the project passes its project to a manual item;
>   - an invited employee sees "Project: …" on My Tasks and on task detail, gets 404 for a project they are not a member of and 403 for meetings;
>   - logout makes `/auth/me` return 401, and the `user_sessions` rows are marked `logout`;
>   - the server log contains no tokens.
> - New UI: a project selector on each review card (works in any review state), and the project shown on the employee task list and detail page.
> - Tests: frontend **78/78** (1 new test, 2 extended), build OK. No backend code changed in 2.5. The backend count is still 285/285 from the earlier run today.
> - Correction: the process on `:4100` belongs to a **different project** (`Ekanta-Updated/backend`, under nodemon), not WorkAgent. It was left running. Port 4100 is therefore unusable for WorkAgent's `backend-verify` launch config on this machine.
> - Verification data left in the dev DB: users `verify-admin@`, `verify-manager@` and `verify-employee@workagent.test`; project "Verification Project 2.5"; meeting 12 with one item; and item 4 ("Prepare the Q4 report") moved into that project. These are safe to deactivate/archive.
> - Still open: password reset for activated users (decision pending), product rename, manager access to meetings.

Source of this document: direct inspection of the repository working tree, the local databases (read-only queries) and test/build runs on 2026-10-30. Earlier reports (`docs/PROJECT_OVERVIEW.md` §13–§14) were checked against the code, not taken on trust. Detailed design history stays in `docs/PLANNING.md` and `docs/PROJECT_OVERVIEW.md`; this file is the current-state summary.

Labels: **Verified** = exercised by a check run on 2026-10-30. **DB evidence** = rows in the local dev database show it happened before, but it was not re-run today. **Implemented, not verified** = code read, nothing exercised it today. **Reported** = only stated by an earlier session.

---

## 1. Repository state

| Item | Finding |
|---|---|
| Branch | `main`; 4 commits, last `5ef3e25 Merge remote README with local project` |
| Uncommitted work | **All Phase 1 and Phase 2 work is uncommitted**: 39 modified tracked files (+574 / −99 lines) and ~25 untracked files/dirs (Phase 2 controllers, repositories, services, migration `004`, 4 backend test files, frontend pages, `start.sh`, `end.sh`, `docs/PROJECT_OVERVIEW.md`). |
| Git remote | `koushik-dinesh/AI-Meeting-To-Action` (per docs) |
| Product naming | Code/UI still use "Meeting to Action" (`mta_session` cookie, `meeting_action` DB, package names `meeting-action-*`). |
| Running processes | A Node API from an earlier session is listening on `:4100` (the `backend-verify` launch config, pointed at the **test** DB). Nothing on `:4000`/`:5173`. Docker: MySQL 8.4 (`:3307`) and Mailpit (`:8025`/`:1025`) healthy. |

## 2. Actual architecture

Single-company deployment (one install + one database per customer; no tenant columns anywhere — verified by reading all 4 migrations).

```
React SPA (Vite :5173) --/api proxy--> Express 5 API (:4000) --> MySQL 8.4 (:3307)
                                            | enqueue (jobs table)      ^
                                            v                           |
                                   Worker process (src/worker.js) ------+
                                     ai.extract  -> Anthropic Claude
                                     email.send  -> SMTP (Mailpit) / Resend (fetch)
                                     vexa.poll   -> Vexa REST (:18056) -> Google Meet bot
                                                                     -> faster-whisper (:8083)
```

- Backend layering: `routes/` (zod validation + auth guards) → `controllers/` → `services/` (rules, provider clients) → `repositories/` (parameterised SQL, `mysql2`, no ORM).
- Provider isolation: only `services/ai/claudeClient.js`, `services/vexa/client.js`, `services/email/*Provider.js` call external systems. This is the pattern future connectors should copy.
- Job queue: MySQL `jobs` table, `FOR UPDATE SKIP LOCKED` claim, heartbeat leases, exponential backoff, `dead`/`failed` terminal states, dedupe keys, `RescheduleJob` for polling, lease-ownership check on failure.
- Auth: bcrypt + HS256 JWT in httpOnly cookie carrying a random `sid`; every request requires a live `user_sessions` row and an active user.
- Authorization: three roles (`admin`, `manager`, `employee`); admin-only routers for users/meetings/review/email; per-resource checks for projects/teams in `services/permissions.js`.

## 3. Verified technology stack (from `package.json` + earlier lockfile audit)

Node 22.23.1 (verified `node -v`) · Express ^5.3.0 · mysql2 ^3.24.6 · MySQL 8.4 (Docker) · zod ^4.6.7 · bcrypt ^6.0.0 · jsonwebtoken ^9.0.3 · cookie-parser ^1.4.7 · @anthropic-ai/sdk ^1.1.0 · nodemailer 10.0.16 · supertest ^7.3.1 · node:test.
React ^19.3.1 · react-router ^8.5.0 · Vite ^8.3.5 · Tailwind ^4.3.3 · Vitest ^5.0.5 (verified in test output) · Testing Library · jsdom ^30.1.3.
No Redis, no ORM, no Resend SDK. Phase 2 added no dependencies (`package.json` dependency lists are unchanged in the diff).

## 4. Database

| Database | Migrations applied | Tables |
|---|---|---|
| `meeting_action_test` | 001, 002, 003, **004** | 21 (+ `schema_migrations`) |
| `meeting_action` (dev) | 001, 002, 003 — **004 NOT applied** | 15 |

**Consequence (verified by reading `authService.js`):** the current code cannot log anyone in against the dev database — `signSession` inserts into `user_sessions`, which does not exist there. Running `npm run dev` / `./start.sh` against the dev DB today gives a working health check but failing logins until `npm run migrate` is run.

Dev DB contents (read-only counts): 11 users, 11 meetings, 9 action items, 7 transcripts, 2 sent emails, 105 audit rows, 14 succeeded jobs, 0 failed jobs.

Phase 2 schema (`004_work_management.sql`): `users.role` + `manager`; `user_sessions`, `user_invitations`, `projects`, `project_members`, `teams`, `team_members`; nullable `meetings.project_id`, `action_items.project_id` with FKs (RESTRICT) and indexes. Additive only.

## 5. Module inventory

| Area | Key files | Status |
|---|---|---|
| Config | `config/index.js` | zod-validated env; external credentials forced off in tests |
| Auth & sessions | `middleware/auth.js`, `services/authService.js`, `repositories/sessionsRepository.js`, `routes/auth.js` | Verified (tests) |
| Invitations | `services/invitations.js`, `repositories/invitationsRepository.js`, `services/email/templates/invitationEmail.js`, `pages/AcceptInvitation.jsx` | Verified (tests) |
| Users & aliases | `controllers/usersController.js`, `pages/admin/Users.jsx` | Verified (tests) |
| Projects | `controllers/projectsController.js`, `repositories/projectsRepository.js`, `routes/projects.js`, `pages/projects/*` | Verified (tests) |
| Teams | `controllers/teamsController.js`, `repositories/teamsRepository.js`, `routes/teams.js`, `pages/teams/Teams.jsx` | Verified (tests) |
| Permissions | `services/permissions.js` | Verified (tests) |
| Meetings & transcripts | `controllers/meetings*`, `transcripts*`, `services/transcripts/parser.js` | Verified (tests) |
| AI extraction | `services/extraction.js`, `services/ai/*`, `services/matching/*`, `utils/dates.js`, `jobs/handlers/aiExtract.js` | Verified with fake Claude; DB evidence of real runs |
| Review | `services/review.js`, `controllers/actionItemsController.js`, `pages/admin/ReviewActionItems.jsx` | Verified (tests) |
| Email | `services/notifications.js`, `services/email/*`, `jobs/handlers/emailSend.js` | Verified with fake provider; DB evidence of SMTP sends |
| Employee portal | `controllers/tasksController.js`, `pages/employee/*` | Verified (tests) |
| Job queue | `jobs/queue.js`, `jobs/runner.js`, `worker.js` | Verified (tests) |
| Vexa bot | `services/meetingBot.js`, `services/vexa/*`, `jobs/handlers/vexaPoll.js` | Verified with fake Vexa; DB evidence of real bots |
| Audit | `services/audit.js` | Written everywhere; no UI except project activity feed |
| Admin dashboard | `pages/admin/Dashboard.jsx` | **Placeholder** (static "No meetings yet" text) |
| Integrations framework | — | Not implemented |

## 6. Functionality status

**Verified (automated tests, 2026-10-30):** login/logout, server-side session revocation (logout, deactivation, password set), pre-Phase-2 tokens rejected, role guards, inactive-user rejection, rate limiting, invitations (create, email via fake provider, verify, accept, single use, expiry, revoke, resend revokes older, refuse on deactivated/already-active/email-changed), users/aliases, projects CRUD + archive + members + ownership rules, teams CRUD + members + lead rules, project-scoped meetings/tasks/activity views, meeting↔project and item↔project linking with propagation, transcript parsing (4 formats), extraction pipeline + validator, review workflow, email planning/idempotency/retry, employee task scoping, job queue concurrency/leases/recovery/lost-lease, Vexa client/poller/import. Frontend component/page tests for all of the above screens. Production build.

**DB evidence (not re-run today):**
- 5 succeeded `extraction_runs` with real token counts (models `claude-opus-5-5` and `claude-haiku-5-5`, 2026-10-22 → 10-24) → real Claude extraction has run at least on small transcripts.
- 4 meetings with `bot_status=completed` and Vexa transcripts carrying detected languages (`en`, `hi`) → a Vexa bot was admitted and transcribed real Google Meets at least once. This contradicts the "only reached the lobby" statement in `PROJECT_OVERVIEW.md` §11/§13.4, which is out of date.
- 2 `email_messages` with status `sent` via SMTP (Mailpit).

**Implemented, not verified today:** worker process startup; frontend in a browser; manager role through the browser; migration 004 on the dev DB.

**Partially implemented:**
- Admin dashboard (placeholder).
- Per-item project change: API exists (`PUT /action-items/:id/project`), no review-screen control.
- Employee portal does not show an item's project (no `project` references in `pages/employee/*`).
- Managers can own projects but cannot link meetings (meetings remain admin-only).
- No "forgot password"/reset for already-activated users (invitation refuses users who have a password).
- Sessions cannot be listed or revoked per device in the UI.

**Not implemented:** integration framework and all connectors (GitHub, Jira, Teams, Outlook, Figma; Google Meet only via Vexa), unified work/external-record model, cross-application correlation, insights/risks/blockers, operations center (jobs/audit/email/AI-cost views), notifications beyond action-item emails, production deployment, capture device.

## 7. Test and build results (2026-10-30)

| Command | Result |
|---|---|
| `cd backend && npm test` | **285 tests, 285 pass, 0 fail, 0 skipped, 0 cancelled**, 73 suites, 104.7 s |
| `cd frontend && npm test` | **77 tests pass, 8 files**, 17.0 s |
| `cd frontend && npm run build` | OK — JS 427.49 kB (125.20 kB gzip), CSS 23.31 kB |
| `node --check` on all 80 `backend/src/**/*.js` | 0 failures |
| Import `src/app.js` + `src/jobs/handlers/index.js` (`NODE_ENV=test`) | OK |
| `bash -n start.sh end.sh` | OK |
| Migration check (read-only `schema_migrations`) | test DB 001–004; dev DB 001–003 |

Not run: live API/worker against the dev DB, browser checks, any real provider call.

## 8. Known issues

| Priority | Issue |
|---|---|
| **P0** | Phase 1 + Phase 2 exist only as uncommitted changes on `main`. One `git checkout .`/disk problem loses the whole phase. |
| **P0** | Dev DB lacks migration 004 → logins fail against it with the current code. Back up, then `npm run migrate`. |
| P1 | `PROJECT_OVERVIEW.md` integration status is stale (DB shows real Claude/Vexa runs). |
| P1 | No password reset for activated users; no production deployment docs/config (HTTPS, process manager, backups). |
| P2 | In-memory rate limiters; `trust proxy` unset; synchronous invitation email; meeting link editable while a bot is active; re-extraction drops admin edits on pending items; placeholder dashboard; naming still "Meeting to Action"; `start.sh` assumes Vexa in `~/vexa`. |
| P2 | A stale API process from a previous session is still listening on `:4100`. |

## 9. External integration status

| Integration | Status |
|---|---|
| Anthropic Claude | Verified with fakes; DB evidence of 5 real runs (small transcripts). Quality on real meetings not evaluated. Key configured in `backend/.env`. |
| SMTP (Mailpit) | Verified with fakes; DB evidence of real SMTP delivery to Mailpit. Real inbox never tested. |
| Resend | Coded, never called. |
| Vexa / Google Meet | Verified with fake server; DB evidence of completed bots with transcripts. Not re-run today. |
| GitHub, Jira, Microsoft Teams, Outlook, Figma | Not implemented. |
