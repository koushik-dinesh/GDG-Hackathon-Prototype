# WorkAgent (formerly AI Meeting to Action) — Project Overview (status as of 2026-10-28)

> WorkAgent is the Universal AI Work Intelligence Platform being built on this codebase. Today the repository contains the meeting-to-action foundation described below. The Phase 1 audit results (what is verified vs only implemented, defects fixed, known issues, next steps) are in **§13**. Phase 2 (core work management: invitations, revocable sessions, manager role, projects, teams, project-aware meetings and tasks) is in **§14**.
>
> **2026-10-30 assessment:** current verified state, the updated 11-phase roadmap and the next phase are in `docs/WORKAGENT_CURRENT_STATE.md`, `docs/WORKAGENT_MASTER_ROADMAP.md` and `docs/WORKAGENT_NEXT_STEPS.md`. Note: the live-integration notes in §11 and §13.4 are out of date — the dev database shows completed Vexa bots with transcripts and real Claude extraction runs.

A full-stack prototype that turns meetings into reviewed, assigned and tracked action items:
**meeting → transcript → AI-extracted tasks → human review → email to assignees → employees track progress.**

Repository: `koushik-dinesh/AI-Meeting-To-Action` (GitHub). Design doc: `docs/PLANNING.md` (source of truth for architecture and decisions).

---

## 1. Status at a glance

| Phase (from PLANNING.md) | What | Status |
|---|---|---|
| 0 | Infra spike (Docker, Vexa) | Done during Phase 7 (Vexa running locally) |
| 1 | Skeleton: auth, roles, DB, React shell | ✅ Done |
| 2 | Users/aliases, meetings, manual transcript upload | ✅ Done |
| 3 | AI extraction (Claude) + deterministic validation + job queue/worker | ✅ Done |
| 4 | Admin review UI (edit, assign, resolve flags, approve/reject, manual items) | ✅ Done |
| 5 | Email notifications (SMTP/Mailpit, Resend option) | ✅ Done |
| 6 | Employee task portal | ✅ Done |
| 7 | Vexa meeting-bot integration (Google Meet) | ✅ Built; partially verified live (see §11) |
| 8 | Tracking & hardening (dashboard, audit/job/email views, prod readiness) | ❌ Not started |

Size: ~5,400 lines backend source, ~3,100 lines frontend source, ~4,200 lines of tests.
Tests (re-run 2026-10-28, Phase 1 audit): **217/217 backend tests passing** (~51 s), **42/42 frontend tests passing**, production build clean. See §13.7.

---

## 2. Technology stack

**Backend** — Node.js 22 (required; checked at startup), Express 5, JavaScript (ES modules)
- `mysql2` (no ORM; plain SQL with parameterized queries), plain `.sql` migrations + tiny runner
- `zod` (input/env validation), `bcrypt` (passwords), `jsonwebtoken` (JWT in httpOnly cookie), `cookie-parser`
- `@anthropic-ai/sdk` (Claude API), `nodemailer` 10.0.16 (SMTP)
- Tests: Node's built-in `node:test` + `supertest` (integration tests hit a real MySQL test database)

**Frontend** — React 19, Vite 8, React Router 8, Tailwind CSS 4 (via `@tailwindcss/vite`)
- Tests: Vitest 5 + Testing Library + jsdom

**Infrastructure (local, Docker)**
- MySQL 8.4 (port 3307) and Mailpit (local email catcher, UI 8025 / SMTP 1025) — this repo's `docker-compose.yml`
- Vexa (open-source meeting bot, v0.12) — **separate** project in `~/vexa`, its own Docker Compose stack (gateway port 18056)
- Vexa transcription unit (faster-whisper, CPU) — port 8083
- No Redis/BullMQ: background jobs use a MySQL `jobs` table

**AI** — Anthropic Claude, default model `claude-opus-5-5` (configurable via `ANTHROPIC_MODEL`), structured JSON output.

**Helper scripts** (untracked, written by the developer): `start.sh` / `end.sh` start/stop Docker, Vexa, backend, worker and frontend with logs/PIDs in `.run/`.

---

## 3. Architecture

```
Browser (React/Vite :5173) --/api proxy--> Express API (:4000) ---> MySQL 8.4 (:3307)
                                                 |                       ^
                                         enqueue jobs (MySQL table)      |
                                                 v                       |
                                       Worker process (npm run worker) --+
                                         - ai.extract   -> Anthropic Claude API
                                         - email.send   -> SMTP (Mailpit) / Resend
                                         - vexa.poll    -> Vexa REST API (:18056) -> bot joins Google Meet
                                                                                  -> faster-whisper (:8083)
```

- Two Node processes from one codebase: **API** (`npm run dev`) and **worker** (`npm run worker`).
- **Job queue** in MySQL: claim with `SELECT … FOR UPDATE SKIP LOCKED`, leases with heartbeat, retries with exponential backoff + max attempts, stale-job recovery after crashes, dedupe keys so the same operation can't be queued twice, `RescheduleJob` for polling without consuming attempts.
- **Provider isolation**: only `services/ai/claudeClient.js` talks to Claude, only `services/vexa/client.js` talks to Vexa, only `services/email/*Provider.js` talk to mail providers.
- No DB transaction is held open during any external HTTP call.

---

## 4. End-to-end workflow (what a user can do today)

1. **Admin logs in** (JWT httpOnly cookie, roles `admin` / `employee`).
2. **Admin manages users** (create, edit, deactivate, aliases like "JL" → Jane Liu used for name matching).
3. **Admin creates a meeting** (title, Google Meet link, date, language hint, participants).
4. **Transcript arrives**, either:
   - **Manual upload/paste** — formats: plain text (`[00:12] Name: text`), WebVTT, SRT, Vexa JSON; ≤2 MB; or
   - **Meeting bot (Vexa)** — admin clicks "Send bot to meeting"; bot joins the Meet (host must admit it from the lobby); worker polls status; transcript imported automatically when the meeting ends.
5. **AI extraction** (button, or automatic after a bot transcript): background job sends transcript to Claude → structured JSON action items → **deterministic validation** (see §6) → saved as *pending* items with flags.
6. **Admin review**: view items + transcript evidence (click to jump to the transcript line), edit title/description/assignee/due date/priority, resolve flags, approve/reject/reopen, add manual items, then **Finish review** (meeting → `approved`).
7. **Email notifications**: preview recipients → confirm → one email per person with only their approved items → per-recipient delivery status, retry for failures. Never automatic.
8. **Employees** log in to **My tasks**: summary cards (total, not started, in progress, completed, overdue), filters, search, sorting, task detail with meeting context, evidence and history; update status (Not started / In progress / Blocked / Completed, reopen).

Meeting lifecycle: `draft → bot_requested → bot_joining → in_progress → ended → transcript_ready → extracting → review_pending → approved → emails_sent` (any → `failed` with a readable error).

---

## 5. Database (MySQL, 4 migrations)

- `001_init.sql` — `users`, `user_aliases`, `meetings`, `meeting_participants`, `transcripts`, `transcript_segments`, `extraction_runs`, `action_items`, `action_item_evidence`, `email_messages`, `email_message_items`, `email_attempts`, `jobs`, `audit_logs` (+ `schema_migrations`).
- `002_extraction_pipeline.sql` — extraction run states/job link/summary; `action_items.review_details` (JSON).
- `003_vexa_bot.sql` — `meetings.bot_status`, `bot_reason`, `bot_requested_at`, `bot_checked_at`.
- `004_work_management.sql` (Phase 2) — `users.role` + `manager`; `user_sessions`, `user_invitations`, `projects`, `project_members`, `teams`, `team_members`; nullable `meetings.project_id` and `action_items.project_id`. See §14.3.

Key ideas: action items keep `review_status` (pending/approved/rejected — admin) separate from `task_status` (todo/in_progress/blocked/done — employee). `email_messages.idempotency_key` = sha256(meeting:user:item ids), UNIQUE → no duplicate emails. Every important change writes `audit_logs`.

---

## 6. AI extraction details

- Prompt (`services/ai/extractionPrompt.js`): system prompt with rules (only real commitments, never invent owners/deadlines, quote evidence verbatim, treat transcript as untrusted data — prompt-injection resistant); transcript sent as `[S12] [00:12] Speaker: text` lines; participant names only (no emails).
- Structured output: hand-written JSON Schema via `output_config.format` (title, description, assignee_name_raw, assignee_confidence, due_date_raw, due_date_resolved, due_date_is_ambiguous, priority, ai_confidence, needs_review_reason, evidence[]).
- **Validator** (`services/ai/validator.js`, independent of the AI):
  - evidence quotes must actually appear in the stored transcript, else the item is rejected;
  - assignee matched to registered users (exact name / alias = assigned; unique first name = assigned + flagged; several matches / unknown / inactive = unassigned + flagged); never invents emails;
  - deadlines resolved by a deterministic date parser using meeting date + timezone; ambiguous ("next Friday", "soon") stays unresolved + flagged;
  - duplicates merged; items duplicating already-reviewed ones skipped; long text truncated + flagged.
- Re-extraction replaces only pending AI items; approved/rejected/manual items are kept.
- Claude-specific features used: structured outputs, streaming, prompt caching, effort setting, server-side refusal fallback (beta).

---

## 7. API endpoints (`/api/v1`, JSON)

Auth: `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/invitations/verify|accept` (public)
Invitations (admin): `GET/POST /users/:id/invitations`, `POST /users/:id/invitations/revoke`
Projects (signed in, per-project permissions): `GET/POST /projects`, `GET/PATCH /projects/:id`, `GET/POST /projects/:id/members`, `DELETE /projects/:id/members/:userId`, `GET /projects/:id/meetings|tasks|activity`
Teams (signed in): `GET/POST /teams`, `GET/PATCH /teams/:id`, `POST /teams/:id/members`, `DELETE /teams/:id/members/:userId`; directory (admin, manager): `GET /directory/users`; `PUT /action-items/:id/project` (admin)
Users (admin): `GET/POST /users`, `PATCH/DELETE /users/:id`, `GET/POST /users/:id/aliases`, `DELETE /users/:id/aliases/:aliasId`
Meetings (admin): `GET/POST /meetings`, `GET/PATCH /meetings/:id`, `POST /meetings/:id/transcript/upload`, `GET /meetings/:id/transcript`, `POST /meetings/:id/transcript/refresh` (import Vexa transcript)
Extraction & review (admin): `POST /meetings/:id/extract`, `GET/POST /meetings/:id/action-items`, `POST /meetings/:id/approve`, `PATCH /action-items/:id`, `POST /action-items/:id/approve|reject|reopen`
Email (admin): `GET /meetings/:id/emails/preview`, `POST /meetings/:id/send-emails`, `GET /meetings/:id/emails`, `POST /emails/:id/retry`
Bot (admin): `GET/POST/DELETE /meetings/:id/bot`, `POST /meetings/:id/bot/check`
Employee: `GET /me/tasks`, `GET /me/tasks/:id`, `PATCH /me/tasks/:id/status`
Health: `GET /health`

Authorization is enforced on the server (admin-only routers; employee endpoints always scoped to the logged-in user; other people's tasks return 404).

---

## 8. Security and reliability features

- bcrypt passwords, JWT in httpOnly SameSite=Lax cookie (Secure in production), login rate limiting, per-request user re-check (deactivation takes effect immediately).
- zod validation on all inputs (strict schemas reject unknown fields), parameterized SQL only.
- Secrets only in `backend/.env` (gitignored); API keys never sent to the browser; error messages sanitized (no keys/stack traces).
- Email: HTML escaping, no header injection, idempotency key, retries with backoff, permanent vs temporary failure classification, interrupted sends marked failed instead of resent.
- Audit log for logins, user changes, meeting/transcript changes, extraction, reviews, emails, bot lifecycle, task status changes.
- Test suite never calls real Claude, Vexa or mail providers (keys forced off in test mode; fakes injected).

---

## 9. Configuration (`backend/.env`, see `backend/.env.example`)

DB (`DB_HOST/PORT/USER/PASSWORD/NAME/TEST_NAME`), auth (`JWT_SECRET`, `JWT_EXPIRES_IN`, `COOKIE_SECURE`), seed users (`SEED_ADMIN_*`, `SEED_EMPLOYEE_*`),
Claude (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT`, `ANTHROPIC_MAX_OUTPUT_TOKENS`, `ANTHROPIC_TIMEOUT_MS`, `ANTHROPIC_REFUSAL_FALLBACK`, `MEETING_TIMEZONE`, `EXTRACTION_*`),
worker (`WORKER_POLL_INTERVAL_MS`, `JOB_MAX_ATTEMPTS`, `JOB_BACKOFF_BASE_MS`, `JOB_STALE_AFTER_MS`),
email (`EMAIL_PROVIDER`, `EMAIL_FROM`, `SMTP_*`, `RESEND_API_KEY`, `EMAIL_MAX_ATTEMPTS`, `APP_PUBLIC_URL`),
Vexa (`VEXA_BASE_URL`, `VEXA_API_KEY` — a `vxa_…` user key, `VEXA_BOT_NAME`, `VEXA_*_MS`, `VEXA_AUTO_EXTRACT`).

---

## 10. Running locally (macOS, Apple Silicon)

1. Docker Desktop running; `docker compose up -d` (MySQL + Mailpit).
2. Vexa: `~/vexa` → `make all`; native Apple-Silicon bot built with `make bot` and `BROWSER_IMAGE=vexa/vexa-bot:dev` in Vexa's `.env`; transcription unit in `deploy/transcription`.
3. Backend: `npm install`, `npm run migrate`, `npm run seed`, `npm run dev` (API) and `npm run worker`.
4. Frontend: `npm install`, `npm run dev` → http://localhost:5173. Mailpit inbox: http://localhost:8025.
5. Or use `./start.sh` / `./end.sh`.

---

## 11. What is verified vs not

**Verified (automated tests + manual browser checks):** login/roles, users/aliases, meetings, transcript upload/parsing, extraction pipeline (with a mocked Claude), validator rules, job queue (concurrency, retries, recovery), review workflow, email flow (real SMTP delivery into local Mailpit), employee portal, Vexa client/poller/ingestion (with a mocked Vexa API).

**Live checks done:** Vexa stack runs; the app requests bots successfully; bots launch and reach Google Meet's "Ask to join" page.

**Not yet verified end-to-end:**
- A full real meeting (bot admitted → real transcript → real Claude extraction). The first bots ran under x86 emulation and failed to appear in the lobby; a native arm64 bot has since been built but not yet tested in a meeting.
- Real Claude extraction quality on real meetings (only mocked + manual tests so far).
- Real email to real inboxes (only Mailpit locally; Resend coded per its docs but never called).

---

## 12. Known limitations / not built yet

- Admin dashboard page is a placeholder; no UI for audit logs, jobs, or a global email list (Phase 8).
- ~~No invite / password-setup flow~~ — done in Phase 2 (§14).
- Only Google Meet links for the bot (Teams/Zoom not enabled); Vexa webhooks not used (polling only).
- Rate limiter is in-memory (single API process).
- Re-running extraction replaces pending AI items including admin edits (with a confirmation in the UI).
- Finished reviews can't be reopened at meeting level.
- Not deployed anywhere; no production config (HTTPS, process manager, backups, monitoring).
- Considering a free alternative to Claude (NVIDIA Nemotron API): technically easy to add behind a provider switch, but NVIDIA's free trial terms allow testing/evaluation only and forbid uploading personal data.

---

## 13. Phase 1 audit — repository audit & foundation stabilization (2026-10-28)

Scope: audit the existing code, run every available check, fix only critical foundation defects. No Phase 2 work (integration framework, new connectors, unified work model, AI search, hardware) was started.

**Labels used below:** *Verified* = exercised by a check run during this audit (test suite, build, or live HTTP request). *Implemented, not verified* = code read and looks correct, but nothing exercised it. *Blocked* = needs credentials or an external service that was not exercised.

### 13.1 Current architecture (confirmed by reading the code)

Single-company deployment (one install per customer; no tenants). Two Node processes from one codebase — the API (`backend/src/server.js`) and the worker (`backend/src/worker.js`) — share MySQL. The API only enqueues jobs; the worker runs `ai.extract`, `email.send` and `vexa.poll` (`backend/src/jobs/handlers/`). Layering: `routes/` (zod validation, auth guards) → `controllers/` → `services/` (rules, provider clients) → `repositories/` (parameterised SQL via `mysql2`). Only `services/ai/claudeClient.js`, `services/vexa/client.js` and `services/email/*Provider.js` talk to external systems. The React SPA (`frontend/src`) calls `/api/v1` through the Vite proxy (same origin, so no CORS).

### 13.2 Verified technology stack (installed versions)

Node 22.23.1 · Express 5.3.0 · mysql2 3.24.6 · MySQL 8.4.13 (Docker) · zod 4.6.7 · bcrypt 6.0.0 · jsonwebtoken 9.0.3 · cookie-parser 1.4.7 · @anthropic-ai/sdk 1.1.0 · nodemailer 10.0.16 · supertest 7.3.1 — React 19.3.1 · react-router 8.5.0 · Vite 8.3.5 · Tailwind 4.3.3 · Vitest 5.0.5 · Testing Library (react 16.3.3) · jsdom 30.1.3. Mailpit v1.31 for local mail. No Resend SDK (Resend is called over `fetch`). No Redis, no ORM.

### 13.3 Module inventory

| Area | Files | Role |
|---|---|---|
| Config | `backend/src/config/index.js` | zod-validated env; forces AI/email/Vexa credentials off when `NODE_ENV=test`; refuses the example `JWT_SECRET` in production |
| Auth | `middleware/auth.js`, `services/authService.js`, `routes/auth.js`, `middleware/rateLimit.js` | bcrypt verify (timing-equalised), HS256 JWT in `mta_session` httpOnly SameSite=Lax cookie, user re-read on every request, in-memory login limiter (10 / 15 min per IP+email) |
| Users | `controllers/usersController.js`, `repositories/users*`, `aliases*` | CRUD, soft delete, aliases for name matching |
| Meetings & transcripts | `controllers/meetings*`, `transcripts*`, `services/transcripts/parser.js` | create/edit, participants, upload (txt/VTT/SRT/Vexa JSON, ≤2 MB), replace-only-before-extraction |
| AI extraction | `services/extraction.js`, `jobs/handlers/aiExtract.js`, `services/ai/*`, `services/matching/*`, `utils/dates.js` | queue run + job in one transaction → Claude structured output → validator (evidence must exist verbatim, assignee matching, deadline resolution, duplicate merge) → replace pending AI items |
| Review | `services/review.js`, `controllers/actionItemsController.js` | edit/approve/reject/reopen, flag resolution, finish review; meeting row locked first |
| Email | `controllers/emailsController.js`, `services/notifications.js`, `jobs/handlers/emailSend.js`, `services/email/*` | preview → explicit send → one message per recipient (sha256 idempotency key, UNIQUE) → worker delivery with retry/backoff |
| Employee portal | `controllers/tasksController.js`, `repositories/tasksRepository.js`, `services/tasks.js` | own tasks only (scoped by session user), status transitions with audit row in the same transaction |
| Job queue | `jobs/queue.js`, `jobs/runner.js`, `worker.js` | `FOR UPDATE SKIP LOCKED` claim, 30 s heartbeat lease, backoff, stale-lease recovery, dedupe keys, `RescheduleJob` |
| Meeting bot | `services/meetingBot.js`, `services/vexa/*`, `jobs/handlers/vexaPoll.js`, `controllers/botController.js` | request bot, poll status, import transcript, auto-queue extraction |
| Audit | `services/audit.js` | `audit_logs` writes (best-effort, or transactional via `recordAudit`) |
| Frontend | `frontend/src/router.jsx`, `auth/*`, `api/*`, `pages/*`, `components/*` | login, admin (dashboard placeholder, meetings, meeting detail with transcript/bot/review/emails, users), employee (my tasks, task detail) |
| Tooling | `docker-compose.yml`, `docker/mysql/init/`, `start.sh`, `end.sh`, `.claude/launch.json` (local only) | MySQL + Mailpit; scripts also start the external Vexa stack in `~/vexa` |

### 13.4 Feature status

**Verified working (automated tests run in this audit against a real MySQL test database; external providers faked):**
login/logout, cookie flags, JWT validation, role guards, inactive-user rejection, login rate limiting, user + alias management, meeting CRUD and participants, transcript upload/parsing for all four formats, extraction job pipeline (fake Claude), validator rules, assignee matching, deadline resolution, duplicate handling, review workflow incl. "re-extraction keeps approved/rejected/manual items", email plan/idempotency/retry/interrupted-send handling (fake provider), employee task scoping and transitions, job queue concurrency/leases/recovery, Vexa client/poller/import (fake Vexa HTTP server). Frontend: 42 component/page tests; production build.

**Verified live in this audit:** API starts with the documented command and connects to MySQL (`GET /api/v1/health` → `{"status":"ok","db":"ok"}`); unauthenticated requests get 401; unknown login gets the generic 401; security headers present. Migrations 001–003 are applied in the dev database and the 14 application tables + `schema_migrations` exist.

**Implemented, not verified in this audit:** worker process startup against the dev database (not started, to avoid processing real queued jobs and making paid API calls); frontend dev server in a browser (port 4000 was held by another local backend, so the Vite proxy would not have reached this checkout); real SMTP delivery into Mailpit (previously reported as done, not re-run).

**Partially implemented:** admin dashboard (placeholder page with static text); account onboarding (admins can create users but there is no invite/password flow — only seeded users can log in).

**Not implemented (by design, later phases):** multi-application integrations (GitHub, Jira, Teams, Outlook, Figma), cross-application intelligence, unified work data model, audit/job/email admin views, in-person capture device.

**Blocked by external services/credentials (never verified end-to-end):**

| Integration | Status |
|---|---|
| Anthropic Claude | Request parameters checked against the installed SDK 1.1.0 types and the current API: `claude-opus-5-5`, `output_config.effort` + `output_config.format` (json_schema), streaming `finalMessage()`, `refusal` / `stop_details` handling, beta `server-side-fallback-2026-07-01` with `fallbacks: "default"`, `models.retrieve`. No real call made in this audit. The local `backend/.env` overrides the model to `claude-haiku-5-5` (effort `medium`); a previous worker log shows the startup model check timing out. **Unverified live.** |
| SMTP / Mailpit | Code + fake-provider tests verified; Mailpit container running. Real-inbox delivery never tested. |
| Resend | Coded from Resend's REST docs; never called (no key configured). **Unverified.** |
| Vexa / Google Meet | Client and poller verified against a fake server. Earlier live tests reached the Meet lobby only; no admitted meeting, real transcript or live extraction has been observed. **Partially verified.** |

### 13.5 Database & migration audit

- 3 forward-only migrations, applied in filename order with SHA-256 checksums (a modified applied file aborts the run). DDL is not transactional in MySQL, so a failing migration must be fixed forward — documented in `db/migrate.js`.
- Integrity: every child table has a FK; deletes cascade from `meetings` (participants, transcripts → segments, runs, items → evidence, email messages → items/attempts); users are soft-deleted (`email_messages.recipient_user_id` has no cascade, which is correct). `action_item_evidence.segment_id` is `SET NULL`, so replacing a transcript keeps evidence text but drops the segment link.
- Idempotency constraints: `jobs.dedupe_key` UNIQUE (cleared when a job finishes), `email_messages.idempotency_key` UNIQUE, `transcripts.meeting_id` UNIQUE, `transcript_segments (transcript_id, vexa_segment_id)` UNIQUE, `user_aliases (normalized_alias, user_id)` UNIQUE, `meetings (platform, native_meeting_id, scheduled_at)` UNIQUE (the duplicate is mapped to a 409).
- Review status (`pending/approved/rejected`) and task status (`todo/in_progress/blocked/done`) are separate columns; employees can only change `task_status`.
- No schema change was needed in this phase.

### 13.6 Changes made in Phase 1

| File | Problem | Fix | Regression test |
|---|---|---|---|
| `backend/src/jobs/queue.js`, `backend/src/jobs/runner.js` | A worker whose lease had expired (job recovered and re-claimed by another worker) still ran the handler's failure hook. For `ai.extract` that could mark the meeting/run failed while the new owner was working; for `email.send` it could mark a message failed that the other worker then sent, inviting a duplicate on admin retry. | `fail()` now only updates a job still `running` under this worker and returns `owned`; the runner skips the failure hook (and logs a warning) when the lease was lost. | `test/jobQueue.test.js` — "a worker that lost its lease cannot fail the job, and its failure hook does not run" (fails without the fix); existing `fail()` assertions extended with `owned: true`. |
| `backend/package.json` (`test` script) | The suite read `MEETING_TIMEZONE` from the developer's `backend/.env`; with a non-UTC value one extraction test failed (215/216). | Test script pins `MEETING_TIMEZONE=UTC` (real env vars override `.env`). | The existing extraction test now passes regardless of the local `.env`. |
| `start.sh`, `end.sh` (untracked helper scripts) | Hard-coded `PROJECT_DIR` pointed at the old `ai-meeting-to-action-prototype` checkout, so they started/stopped the wrong project. | `PROJECT_DIR` is derived from the script's own location. | `bash -n` syntax check; not executed (they also start/stop the external Vexa stack). |
| `.gitignore` | `.run/` (PID files from `start.sh`) was not ignored (logs were, via `*.log`). | Added `.run/`. | `git check-ignore` confirms. |

### 13.7 Test and build results (2026-10-28)

| Command | Result |
|---|---|
| `cd backend && npm test` (before fixes) | 216 tests: 215 pass, **1 fail** (timezone leak above), 0 skipped |
| `cd backend && npm test` (after fixes) | **217 tests: 217 pass, 0 fail, 0 skipped** (~51 s) |
| `node --check` on every tracked `backend/src/*.js` + import of app/handlers/migrate | all OK |
| `cd frontend && npm test` | **42 pass, 0 fail** (4 files) |
| `cd frontend && npm run build` | OK (JS 391.75 kB, 117.93 kB gzip) |
| `GET /api/v1/health` on a freshly started API | 200 `{"status":"ok","db":"ok"}` |

Requires: Docker running, `docker compose up -d` (MySQL :3307 with the `meeting_action_test` database created by `docker/mysql/init`). Tests never use real Claude/Vexa/mail credentials (forced off in test mode).

### 13.8 Known defects and risks (not fixed in Phase 1)

**P1**
- Logout clears the cookie but the JWT stays valid until it expires (`JWT_EXPIRES_IN`, default 8 h); no server-side revocation. Deactivation and role changes do take effect immediately.
- No invite / password-setup flow: users created in the UI cannot sign in.
- Live integrations unverified end-to-end (Claude, Vexa in an admitted meeting, real email delivery).

**P2**
- Login limiter is in-memory and keyed by IP+email: resets on restart, per-process only, and does not bound attempts spread across many emails/IPs. `trust proxy` is not set, so behind a reverse proxy every client would share the proxy's IP.
- A meeting's link can be edited while a bot is active; the bot keeps using the previously parsed link.
- Re-running extraction discards admin edits on still-pending AI items (UI asks for confirmation).
- Admin dashboard is a placeholder whose text ("No meetings yet") is misleading.
- `start.sh` / `end.sh` are untracked and assume Vexa in `~/vexa`.
- No production deployment config (HTTPS, process manager, backups, monitoring) and no deployment documentation.

### 13.9 Required configuration (names only)

Root `.env` (Docker): `MYSQL_ROOT_PASSWORD`, `MYSQL_PASSWORD` (required), `MYSQL_DATABASE`, `MYSQL_USER`, `MYSQL_TEST_DATABASE`.
`backend/.env` required: `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET` (≥32 chars). Required for features: `ANTHROPIC_API_KEY` (extraction), `EMAIL_PROVIDER` + `EMAIL_FROM` (+ `RESEND_API_KEY` for Resend), `VEXA_BASE_URL` + `VEXA_API_KEY` (bot), `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` (dev seed). All others have defaults (see `backend/.env.example`). In this workspace both `.env` files exist and the required variables are set.

### 13.10 Startup (current, verified for the API)

```bash
docker compose up -d                       # MySQL + Mailpit
cd backend && npm install && npm run migrate && npm run seed
npm run dev                                 # API :4000
npm run worker                              # worker (separate terminal)
cd ../frontend && npm install && npm run dev   # http://localhost:5173 (proxies /api to :4000)
```
Or `./start.sh` / `./end.sh` (also start/stop Vexa from `~/vexa`). Port 4000 must be free: the Vite proxy target is fixed to `http://localhost:4000`.

### 13.11 Architecture decisions affecting later phases

- **Dedicated deployment per customer**: keep single-tenant; company-specific settings stay in environment configuration. No tenant columns were added.
- Keep the MySQL job queue (now lease-safe on failure) as the backbone for future connector sync jobs; no Redis needed at current scale.
- The provider-isolation pattern (one module per external system, credentials only in backend config, fakes in tests) is the template for future connectors.
- The product name in code/UI/cookie (`Meeting to Action`, `mta_session`, DB `meeting_action`) was deliberately not renamed in Phase 1; renaming the DB or cookie would log users out / need a data migration, so it should be a planned change.

### 13.12 Recommended next steps (before / at the start of Phase 2)

1. Run one real end-to-end check with credentials: real Claude extraction on a sample transcript, SMTP delivery to a real inbox (or Resend with a verified domain), and an admitted Vexa bot in a real Google Meet.
2. Decide on session revocation (e.g. a per-user token version) and an invite/password-set flow.
3. Commit or document `start.sh` / `end.sh`; add deployment documentation for the per-customer model.
4. Replace the placeholder admin dashboard when Phase 2 defines the cross-application views.

---

## 14. Phase 2 — core work management foundation (2026-10-28)

Scope: employee onboarding, revocable sessions, a manager role, projects, teams, and optional project association for existing meetings and action items. Single-company deployment is unchanged (no tenant columns, no tenant switching). No integration framework or connector work was started.

### 14.1 Starting point (verified before changes)
- Baseline re-run: backend 217/217, frontend 42/42, build OK. Phase 1 changes were uncommitted (`queue.js`, `runner.js`, `jobQueue.test.js`, `package.json`, `.gitignore`, untracked `start.sh`/`end.sh`/this file) and were left untouched.
- No project, team, invitation or session code or tables existed. `users.role` was `admin|employee`; users were soft-deleted; `001_init.sql` explicitly deferred invite tables. The email provider abstraction (`services/email/index.js`) and audit log were reused.

### 14.2 Decisions
| Topic | Decision | Why |
|---|---|---|
| Session revocation | JWT now carries a random `sid`; `user_sessions` stores `sha256(sid)`, expiry (DB clock), revoked_at/reason, ip, user agent. `requireAuth` requires a live session row and an active user. Logout revokes the current session; deactivation revokes all of the user's sessions. | Smallest change to the existing JWT-cookie design; no new auth framework. One indexed lookup per request (the user was already re-read per request). |
| Behaviour change | Tokens issued before Phase 2 (no `sid`) are rejected → everyone signs in once after upgrading. | Unavoidable for real revocation. |
| Invitations | 256-bit `crypto.randomBytes` token, only `sha256` stored, TTL `INVITATION_TTL_HOURS` (default 72, max 720), single use (row locked + `accepted_at` set in the same transaction as the password), new invitation revokes older open ones, refused if the user is inactive / already has a password / changed email since sending. | Requirements; sha256 is adequate for high-entropy tokens and allows an indexed lookup. |
| Invitation delivery | Sent synchronously through the existing provider (`email.getProvider()`), not the `email.send` job queue. If sending fails the invitation is revoked (`failed`), and the API returns 502/503. The token is never returned by the API, logged, audited or stored in a job payload. Link: `${APP_PUBLIC_URL}/accept-invitation#token=…` (URL fragment ⇒ never sent to servers / request logs); the page removes it from the address bar. | The job queue would have needed the raw token in `jobs.payload`. |
| Roles | Added `manager` to the existing enum. Admin = everything; manager = create projects/teams, manage the ones they own/lead; employee = read projects/teams they belong to, own tasks only. Owners/leads must be admin or manager; only admins change ownership/leads. Meetings, review and email remain admin-only. | Adapts the existing role model instead of adding per-project ACLs. |
| Projects | `projects` (unique name, status enum `planning/active/on_hold/completed/archived`, owner, optional dates with a CHECK `target ≥ start`). Archive = status; archived projects are read-only except reactivation. Projects are never deleted. | |
| Membership | `project_members`, `team_members` (composite PKs). Removing a member deletes only the membership row (audited); tasks/meetings/audit stay. Deactivated users stay listed with `isActive=false` and can't be newly added. FKs to users RESTRICT so history can't be cascaded away. | |
| Meeting ↔ project | Nullable `meetings.project_id`, chosen manually by an admin (create/edit form). Archived/missing projects refused. No backfill and no AI guessing. | Backward compatible. |
| Task ↔ project | Nullable `action_items.project_id`, separate from `review_status`, `task_status`, assignee, meeting and evidence. Extracted and manual items take the meeting's project; when a meeting's project changes, items that followed it move too, items an admin moved explicitly (`PUT /action-items/:id/project`) stay. | Keeps the concepts separate; project pages query one indexed column. |
| Project task visibility | Owner/admin: every item of the project with review + task status. Other members: only their own tasks, with the same visibility rule as the employee portal (approved + meeting review finished). | Avoids broadening employee permissions. |
| Visibility errors | Projects/teams a user can't see return 404 (existence not revealed); visible-but-not-manageable returns 403. | |

### 14.3 Schema (`004_work_management.sql`, additive)
- `users.role` → `ENUM('admin','manager','employee')`.
- `user_sessions(user_id FK CASCADE, sid_hash UNIQUE, expires_at, revoked_at, revoked_reason, ip, user_agent)`; indexes on `(user_id, revoked_at)`, `expires_at`. Rows expired > 1 day are deleted opportunistically at login.
- `user_invitations(user_id FK CASCADE, token_hash UNIQUE, email, created_by/revoked_by FK SET NULL, expires_at, sent_at, send_error, accepted_at, revoked_at)`.
- `projects(name UNIQUE, status, owner_user_id FK RESTRICT, start_date, target_date, created_by FK SET NULL, CHECK chk_projects_dates)`.
- `project_members(project_id FK CASCADE, user_id FK RESTRICT, added_by FK SET NULL)`, `teams(name UNIQUE, lead_user_id FK RESTRICT)`, `team_members(team_id FK CASCADE, user_id FK RESTRICT)`.
- `meetings.project_id`, `action_items.project_id`: NULL, FK RESTRICT to projects, indexed (`idx_meetings_project`, `idx_items_project (project_id, review_status)`).
- Applied to the test database by the suite. **Not applied to the dev database `meeting_action`** in this phase (another local backend on :4000 shares it); run `cd backend && npm run migrate` when ready.

### 14.4 Verification
| Check | Result |
|---|---|
| `cd backend && npm test` | **285/285 pass** (see §14.6) |
| `cd frontend && npm test` | **77/77 pass** (8 files; 35 new) |
| `cd frontend && npm run build` | OK (JS 427.5 kB, 125.2 kB gzip) |
| Live, real SMTP → Mailpit, API on :4100 against the test DB | admin login → create employee → invitation email delivered to Mailpit (subject, link, no password) → verify → accept → second accept refused (400) → invitee login → logout → old cookie refused (401) → deactivation → protected request 401 and login 401. Server log contains no token. |
| Live, browser (Vite on :5174 → API :4100) | Users page: add + invite; activation page from the Mailpit link (token removed from URL), password set, login notice, invitee sign-in; reused link shows the invalid message; admin creates a project with a manager owner, adds a member, creates a meeting in the project; project page shows the meeting and activity. |

Not verified: delivery to a real inbox or via Resend (Mailpit only); the migration on the dev database; a manager signing in through the browser (covered by API and component tests only).

### 14.5 Remaining issues / limitations
- Rate limits (login, invitation verify/accept, invitation sending) are in-memory per process.
- Invitation sending is synchronous: a slow SMTP server delays the admin's request (provider timeouts apply).
- Per-item project changes have an API (`PUT /action-items/:id/project`) but no review-screen control yet.
- Managers cannot link meetings to projects (meetings are admin-only).
- Session rows are not listed or revocable per device in the UI.
- The product name in UI/cookie is still "Meeting to Action"/`mta_session` (see §13.11).

### 14.6 Final test run (2026-10-28)
- `cd backend && npm test`: **285 tests, 285 pass, 0 fail, 0 skipped** (217 existing, unchanged and passing + 68 new in `sessions`, `invitations`, `projects`, `teams` test files).
- `cd frontend && npm test`: **77/77 pass**; `npm run build`: OK.

---

## 15. Phase 3A — integration framework & core data architecture (2026-10-30)

Implemented as planned in `docs/PHASE_3A_PLAN.md` (the deviations are listed at its top). Operations: `docs/runbooks/integrations.md`. Rollback: `docs/runbooks/rollback-005-006.sql` (dry-run verified on a scratch database).

- **Schema:** migrations `005_integrations.sql` (connections, encrypted credentials, connect states, resources, sync cursors, webhook deliveries) and `006_work_records.sql` (external identities, external records, activities, record links). Additive only, no tenant columns.
- **Backend:**
  - `services/integrations/`: crypto/vault, registry/contract, http, connections, sync, scheduler, webhooks, ingest, envelopes, links.
  - Job types `integration.sync`, `integration.webhook` and `integration.maintenance`.
  - Fake provider for tests and local demos.
- **API:**
  - admin `/integrations/*`;
  - public `POST /webhooks/:provider`;
  - signed-in `/external-records`, `/activities`, `/record-links`.
- **Frontend:** Admin → Integrations, connection detail, `/integrations/:provider/setup`.
- **Tests:** backend 410/410, frontend 87/87.
- **Next:** Phase 3B, the GitHub connector.
