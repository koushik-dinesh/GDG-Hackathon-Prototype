# WorkAgent — Current State (assessment of 2026-10-30)

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
