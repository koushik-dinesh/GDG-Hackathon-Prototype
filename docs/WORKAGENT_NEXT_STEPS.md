# WorkAgent — Next Steps (2026-10-30)

> **Update: Phase 3B (GitHub) is implemented and tested against a fake GitHub. Live verification is pending.**
>
> 1. **Human input needed:**
>    - create the GitHub App per `docs/runbooks/integrations.md` §8.1;
>    - put its ID, slug, private key path and webhook secret, plus `PUBLIC_WEBHOOK_BASE_URL` and `CREDENTIALS_ENCRYPTION_KEY`, in `backend/.env`;
>    - start the Cloudflare Tunnel limited to `/api/v1/webhooks/`.
> 2. Run the live verification procedure (§8.4) and record the result in `WORKAGENT_CURRENT_STATE.md`.
> 3. Then Phase 4: commitments, decisions, blockers, dependencies and insights on top of `external_records`, `activities` and `record_links`.

> **Update (end of 2026-10-30): Phase 3A is complete.** It was built as planned in `docs/PHASE_3A_PLAN.md` (the deviations are listed at the top of that file) and is operated per `docs/runbooks/integrations.md`.
> - Tests: backend 410/410, frontend 87/87, build OK.
> - Verified in the browser on the test DB with the fake provider.
> - The dev DB is migrated to 006.
>
> **Next: Phase 3B, the GitHub connector** (acceptance criteria below, "Phase 3B"). It needs from you:
> - a private GitHub App on your account or org, with the permissions and events in `PHASE_3A_PLAN.md` §11;
> - the App ID, slug, private key and webhook secret;
> - the public Cloudflare Tunnel hostname, routed to `/api/v1/webhooks/` only;
> - a test repository.

**Next phase: Phase 2.5 (closeout, prerequisite) → Phase 3A (integration framework + normalized record core).**
Phase 3B (GitHub connector) follows immediately on top of 3A.

Why not "Phase 3" as originally written: a connector's normalized output has nowhere to go until the Phase 4 core tables (`external_records`, `activities`, `record_links`) exist, and the working tree is not committed. So the order is: secure the work → build the framework together with its storage target → one complete connector.

---

## Step 0 — Phase 2.5 closeout — DONE (2026-10-30)

Results: committed on `phase-2-work-management`; dev DB backed up and migrated to 004; all three role flows browser-verified; review-screen project selector and employee project display shipped with tests (frontend 78/78). Item 6 is still open: password reset (now / Phase 11). Item 7: `:4100` is another project's server, so it was left alone. Details are at the top of `WORKAGENT_CURRENT_STATE.md`.

**The next phase is now Phase 3A** (below). It is waiting on the human decisions at the end of this file (GitHub auth mode, webhook reachability, encryption key handling).

| # | Task | Done when |
|---|---|---|
| 1 | Commit Phase 1 and Phase 2 (branch + PR, or two commits on `main` per your preference) | `git status` shows no Phase 1/2 files; CI-equivalent `npm test` passes on the commit |
| 2 | Back up the dev DB (`mysqldump`), then `cd backend && npm run migrate` | dev `schema_migrations` lists 001–004; admin can log in on `:4000` |
| 3 | Browser check: admin invites user → Mailpit link → activation → login; manager creates project, adds members; employee sees only own projects/tasks | Screenshots / notes recorded in `PROJECT_OVERVIEW.md` |
| 4 | Review screen: project selector per action item (uses existing `PUT /action-items/:id/project`) | Component test + manual check |
| 5 | Show project on employee My Tasks list and task detail | Component test |
| 6 | Decide: password reset now or in Phase 11 | Decision recorded |
| 7 | Stop stale `:4100` API; update stale integration notes in `PROJECT_OVERVIEW.md` §11/§13.4 | — |

---

## Phase 3A — Integration framework + normalized record core

### Objectives
1. A provider-neutral way to register, connect, authorize, sync, receive webhooks from, monitor and disconnect external applications.
2. A normalized store for anything a connector brings in, with full provenance.
3. No connector-specific code outside `services/integrations/<provider>/`.

### Required changes
**Database — migration `005_integrations.sql` (additive, no tenant columns)**
- `integration_connections` — provider, display name, status (`pending|connected|error|disconnected`), config JSON (non-secret), connected_by, last_sync_at, last_success_at, last_error, health fields.
- `integration_credentials` — connection_id, encrypted blob (AES-256-GCM, `node:crypto`), key version, expires_at. Never returned by any API.
- `sync_cursors` — connection_id, resource type, cursor/etag/since, updated_at.
- `webhook_deliveries` — provider, delivery_id UNIQUE (dedupe), event type, received_at, signature_ok, processed_at, job_id, error. Payload stored only as needed and size-bounded.
- `external_records` — connection_id, source_app, record_type, external_id, UNIQUE(connection_id, record_type, external_id), url, title, state, author external id, mapped user_id (nullable), project_id (nullable), metadata JSON, source_created_at, source_updated_at, synced_at.
- `activities` — external_record_id (nullable), source_app, activity_type, actor user/external id, occurred_at, summary, metadata JSON, dedupe key UNIQUE.
- `record_links` — from (type,id) → to (type,id), link_type (`same_as|references|implements|blocks|discussed_in`), source (`deterministic|ai|manual`), confidence, created_by.
- `external_identities` — connection_id, external user id/login → users.id (manual or alias-based mapping).

**Backend**
- `services/integrations/registry.js` — provider registry; each provider module exports `{ id, capabilities, authorize, completeAuthorization, initialSync, incrementalSync, verifyWebhook, handleWebhook, normalize, health }`.
- `services/integrations/credentials.js` — encrypt/decrypt with `INTEGRATIONS_ENCRYPTION_KEY` (32-byte, base64) from config; key version column for rotation.
- `services/integrations/normalize.js` — upsert into `external_records`/`activities` with stale-event protection (`source_updated_at` must not go backwards).
- Job handlers: `integration.sync` (initial/incremental, uses `RescheduleJob` for paging and rate-limit waits), `integration.webhook` (processes a stored delivery).
- Routes: `GET/POST /integrations`, `GET /integrations/:id`, `POST /integrations/:id/sync`, `POST /integrations/:id/disconnect`, OAuth/App callback route, public `POST /webhooks/:provider` (raw body, signature verified before anything else, then enqueue).
- Config: `INTEGRATIONS_ENCRYPTION_KEY`, `PUBLIC_WEBHOOK_BASE_URL`, per-provider keys (optional; provider disabled when unset). Forced off in tests like the existing providers.
- A **fake provider** used by tests to exercise the whole framework without network access.

**Frontend**
- Admin → Integrations page: list, connect, status, last sync, last error, sync now, disconnect.
- Project page: linked external sources placeholder (filled in 3B).

### Files/modules likely affected
New: `backend/src/db/migrations/005_integrations.sql`, `backend/src/services/integrations/**`, `backend/src/repositories/{integrations,externalRecords,activities,recordLinks}Repository.js`, `backend/src/controllers/integrationsController.js`, `backend/src/routes/{integrations,webhooks}.js`, `backend/src/jobs/handlers/{integrationSync,integrationWebhook}.js`, `frontend/src/pages/admin/Integrations.jsx`, `frontend/src/api/integrations.js`, tests for each.
Changed: `backend/src/config/index.js`, `backend/.env.example`, `backend/src/routes/index.js`, `backend/src/app.js` (raw body for `/webhooks`), `backend/src/jobs/handlers/index.js`, `frontend/src/router.jsx`, `frontend/src/components/AppShell.jsx`, docs.

### Prerequisites
- Step 0 items 1–2 done.
- Decisions in "Human input" below (at least the encryption-key approach and GitHub auth mode).

### Testing requirements
- Unit: credential encryption round-trip, tamper detection, wrong key version; normalizer upsert idempotency and stale-event rejection; webhook signature verification (valid, invalid, missing, replayed delivery ID).
- Integration (real MySQL test DB, fake provider): connect → initial sync → records/activities created → incremental sync with cursor → webhook → job → upsert → disconnect revokes credentials and stops jobs; rate-limit response reschedules without consuming attempts; credentials never appear in API responses, logs, audit rows or job payloads.
- Permissions: only admins manage integrations; webhook endpoint is public but refuses unsigned requests.
- Frontend: Integrations page states (none, connected, error, disconnected).
- All existing 285 backend / 77 frontend tests still pass.

### Acceptance criteria (Phase 3A)
1. Migration 005 is additive, applies cleanly to test and dev DBs, and adds no tenant columns.
2. A fake provider can be connected, synced (initial + incremental), receive a signed webhook, and be disconnected — all covered by tests.
3. Re-running a sync or re-delivering a webhook creates no duplicate `external_records`/`activities`.
4. An older event never overwrites a newer record.
5. Credentials are encrypted at rest; no API, log, audit row or job payload contains a secret (asserted by tests).
6. Sync failures surface as connection status + last error on the Integrations page; retries use the existing queue backoff; exhausted jobs end in `dead`.
7. Adding a provider requires only a new folder under `services/integrations/` plus registration.

## Phase 3B — GitHub connector (immediately after 3A)

Acceptance criteria:
1. Admin connects a real GitHub org/repo (GitHub App recommended) and maps repos to projects.
2. Initial sync imports open + recently updated PRs, reviews, issues and commits on the default branch as `external_records`/`activities` with URLs.
3. Webhooks (`pull_request`, `pull_request_review`, `issues`, `push`) update records within one job cycle; polling fallback when no public URL.
4. GitHub users map to WorkAgent users (manual mapping + alias suggestion).
5. Project page shows that project's PRs/issues/activity from real data.
6. Rate-limit headers respected; token refresh (installation tokens) automatic.
7. Verified against a real GitHub account with the product owner's credentials, and the result recorded.

---

## Human input needed
1. Authorization to commit (and branch/PR vs direct-to-`main`).
2. OK to back up and migrate the dev DB (`meeting_action`).
3. GitHub auth mode: **GitHub App (recommended)** vs OAuth App vs fine-grained PAT; a test org/repo and admin access to install it.
4. Webhook reachability for local dev: tunnel (e.g. smee.io/ngrok) or polling-only until deployment.
5. Encryption key handling: env variable per deployment (recommended for now) vs external secret manager later.
6. Whether to rename cookie/DB/package names to WorkAgent now (forces re-login and a DB rename) or in Phase 11.
7. Password reset timing (2.5 or 11).
