# WorkAgent — Master Roadmap (updated 2026-10-30)

Baseline: the original 11-phase roadmap. Status below is from the repository assessment in `docs/WORKAGENT_CURRENT_STATE.md`. Effort figures are **engineering estimates**, not measured completion. Single-company deployment is a hard constraint for every phase (no tenant IDs, tenant switching, self-service org signup or shared customer DBs).

Status legend: **Complete** · **Complete (uncommitted)** · **Partial** · **Not started**.

---

## Summary

| # | Phase | Status | Evidence | Remaining work |
|---|---|---|---|---|
| 1 | Audit & foundation stabilization | Complete with limitations (uncommitted) | Lease fix in `queue.js`/`runner.js` + regression test; `MEETING_TIMEZONE=UTC` in test script; scripts derive `PROJECT_DIR`; `.run/` ignored; tests pass | Commit; refresh stale live-integration notes; deployment docs move to Phase 11 |
| 2 | Core work management | **Complete** (2.5 closeout done 2026-10-30) | Committed on `phase-2-work-management`; dev DB at 004; browser-verified admin/manager/employee flows; 285/285 backend, 78/78 frontend | Optional: password reset (decision pending), manager access to meetings |
| 3 | Universal integration framework | **3A complete; 3B implemented** (2026-10-30), live GitHub not yet verified | GitHub App connector on the 3A framework; 456 backend / 91 frontend tests; browser-verified against a local fake GitHub | Run the live verification (runbook §8.4) with a real App |
| 4 | Unified work data model | **Complete** (2026-10-31) | Unified record summaries for internal and external records; one activity vocabulary; internal activities and backfill; relationship management with provenance and review; unified feed and search, with UI; 477 backend / 101 frontend tests; browser-verified for 3 roles | Commitments, decisions, blockers and dependencies as records move to Phase 5/6, with the insights they feed |
| 5 | Cross-app intelligence | **Correlation complete** (2026-10-31) | Key-reference, wording-overlap and meeting-window matchers; `correlation.evaluate` job queued from ingest and audit; suggestions with confidence + evidence; human review page; withdrawal on source deletion; 490 backend / 102 frontend tests; browser-verified | Blocker/stall/review-wait and risk detection move to the insights engine (Phase 7); embedding/LLM similarity optional later |
| 6 | Generalized AI action engine | Partial (meetings only) | Claude extraction + deterministic validation + review | New sources, commitment model, external task linking |
| 7 | Intelligence dashboard | **Complete** (2026-10-31) | `GET /api/v1/insights`: project health, overdue, blockers/dependencies, review progress, follow-through, workload, stalled work, trends; facts vs labelled inferences; role-scoped; admin dashboard + `/insights`; 497 backend / 106 frontend tests; browser-verified for 3 roles | Configurable thresholds; caching if data grows |
| 8 | Ops center | Not started (data exists) | `jobs`, `audit_logs`, `email_messages`, `extraction_runs` (tokens) tables | All UIs + cost accounting |
| 9 | Reliable sync | Partial (queue only) | Lease-safe MySQL queue, retries, dead state, dedupe, reschedule | Sync cursors, webhook ingestion, ordering, backfill, reconciliation, token refresh |
| 10 | Notifications & automation | Partial (email only) | Explicit-confirmation action-item email with idempotency | Alerts, digests, policies, external writes |
| 11 | Security, production & device | Partial | Session revocation, bcrypt, zod, secrets in env, prompt-injection precautions | Deployment, HTTPS, backups, monitoring, secret encryption, retention; device workstream |

Complete: Phases 1, 2, 3A, 4, 5 (correlation), 7 (insights), and 3B in code (live GitHub check pending). Partial: 3, 6, 9, 10, 11. Not started: 8. Next: **the remaining connectors** (Jira, Microsoft Teams, Outlook, Google Meet, Figma) on the provider framework.

---

## Phase 1 — Repository Audit & Foundation Stabilization
- **Objective:** understand and stabilize the meeting-to-action prototype.
- **Implemented:** inventory, audit, lease-ownership fix, test TZ isolation, script fixes, `.gitignore`.
- **Verified (2026-10-30):** fixes present in the working tree; regression test passes; 80 backend files pass `node --check`; app/handlers import; scripts parse.
- **Incomplete:** nothing blocking. Phase-1 "known limitations" now resolved by Phase 2: invite flow, session revocation. Still open: placeholder dashboard (→ 7), deployment docs (→ 11), real-inbox email (→ 11).
- **Regressions:** none found. One stale statement: docs say Vexa never got past the lobby and Claude was never called live; the dev DB shows completed bots with transcripts and 5 real extraction runs.
- **Risk:** not committed.

## Phase 2 — Core Work Management Foundation
- **Objective:** represent employees, teams, projects and internal work.
- **Implemented / verified by automated tests:** invitations (send, verify, accept, single use, expiry, revoke, resend), revocable server-side sessions, `manager` role, employee management, project CRUD/ownership/archive/membership (incl. add-by-team), team CRUD/lead/membership, meeting↔project, item↔project with propagation, project meetings/tasks/activity views, backend permission enforcement (404 for invisible, 403 for not-manageable), frontend screens + tests.
- **Phase 2.5 closeout — DONE 2026-10-30:** items 1–4 done and browser-verified. Item 6: the `:4100` process turned out to belong to another project and was left alone; the docs are corrected. Item 5 (password reset) still needs a decision. Original list:
  1. Commit Phase 1 and Phase 2 (separate commits or one branch + PR).
  2. Back up the dev DB, apply migration 004 to it, re-seed if needed; confirm login on `:4000`.
  3. Browser check of the manager flow (create project, manage members, see own projects only).
  4. Project control on the review screen (API already exists); show project on employee task list/detail.
  5. Password reset for activated users (reuse invitation token machinery) — or explicitly defer to Phase 11.
  6. Stop the stale `:4100` process; refresh `PROJECT_OVERVIEW.md` §11/§13.4.
- **Dependencies:** none.
- **Acceptance:** clean `git status` for Phase 1/2 files; dev DB at migration 004; admin/manager/employee each sign in via browser on the dev stack; 285+/77+ tests pass.

## Phase 3 — Universal Integration Framework (recommended split)
- **Existing reusable:** provider-isolation pattern, zod config, job queue with `RescheduleJob` (polling), dedupe keys, audit log, Vexa poller as a reference "connector".
- **Missing:** provider registry, connection model, encrypted credential storage, OAuth/App auth flow, webhook endpoint with signature verification, sync state/cursors, rate-limit handling, connection health, normalization target.
- **3A — Framework + normalized storage core:** `integration_connections`, `integration_credentials` (AES-256-GCM with a key from env), `sync_cursors`, `webhook_deliveries`, plus the Phase 4 core tables the normalizers write to (`external_records`, `activities`, `record_links`). Generic connector interface (`authorize`, `initialSync`, `incrementalSync`, `handleWebhook`, `normalize`, `health`), job types `integration.sync` / `integration.webhook`. Admin Integrations page (connect, status, last sync, error, disconnect).
- **3B — GitHub connector:** GitHub App auth (installation tokens), repos/PRs/reviews/issues/commits initial + incremental sync, webhooks (`pull_request`, `pull_request_review`, `issues`, `push`) with HMAC verification, user mapping (GitHub login → user alias), map repos to projects.
- **Risks:** webhook delivery needs a public URL (local dev needs a tunnel or polling-only mode); secret-key management; GitHub rate limits; mapping identities.
- **Acceptance:** see `WORKAGENT_NEXT_STEPS.md`.
- **Estimate:** 3A ≈ 1.5–2 weeks, 3B ≈ 1.5–2 weeks (one developer + AI assistance; engineering estimate).

## Phase 4 — Unified Work Data Model
- **Existing:** users, aliases, projects, teams, memberships, meetings, transcripts, action items (with review/task status split), evidence, audit.
- **Done in 3A:** `external_records`, `activities`, `record_links` (provenance: source app, external ID, URL, type, metadata JSON, synced_at, source_updated_at).
- **Remaining:** `decisions`, `commitments` (distinct from action items and from external tasks), `blockers`, `dependencies`, `insights` + `insight_evidence`; duplicate/same-as links; rules that a commitment links to an existing external task rather than creating one.
- **Dependency:** 3A. Must land before Phase 5 and 6.
- **Acceptance:** every external record round-trips with provenance; a meeting commitment can be linked to a GitHub issue without creating a new task; schema stays tenant-free.

## Phase 5 — Cross-Application Intelligence Engine
- **Existing reusable:** `services/matching/*` (name normalization, alias matching), validator's evidence-must-exist rule.
- **Remaining:** entity resolution (person/project/feature), event correlation (deterministic first: issue keys, PR references, branch names, URLs; then embeddings/LLM-assisted with confidence), relational relationship graph (`record_links`; graph DB only if queries prove it necessary), blocker/stall/review-wait detection rules, inconsistency and risk detection, evidence-backed insight records.
- **Dependencies:** 3B + 4 and at least a second connector (Jira) for real cross-app value.
- **Risk:** false-positive correlations erode trust → every insight needs evidence + confidence + human review.

## Phase 6 — Generalized AI Action & Commitment Engine
- **Existing:** prompt with injection precautions, structured outputs, deterministic validator, assignee matching, deadline parser, dedupe, review UI.
- **Remaining:** source-agnostic extraction input (email threads, chat, issue comments), commitment vs action item vs decision classification, linking to existing external tasks, controlled external task creation (behind Phase 10 approvals).
- **Dependencies:** 4; sources from 3B and later connectors.

## Phase 7 — WorkAgent Intelligence Dashboard
- **Existing:** project detail (meetings, tasks, activity from `audit_logs`, real data); My Tasks; placeholder admin dashboard.
- **Remaining:** organization overview, extended project intelligence (PRs, issues, blockers, insights), My Work incl. commitments, unified timeline over `activities`, risks/blockers view, insight review (confirm/dismiss/resolve).
- **Dependencies:** 4 (data), 5 (insights). An org overview over internal data can start right after 2.5.

## Phase 8 — Integration Management & Operations Center
- **Existing data:** `jobs` (status, attempts, last_error), `audit_logs`, `email_messages`/`email_attempts`, `extraction_runs` (model, tokens).
- **Remaining:** job dashboard + retry of dead jobs, audit-log viewer, global email history, AI run log, model usage + cost (needs a price table in config), connection health (from 3A).
- **Dependencies:** 3A for integration health; the rest can be built anytime.

## Phase 9 — Reliable Synchronization & Background Processing
- **Existing:** lease-safe queue, backoff, dead state, dedupe keys, stale-lease recovery.
- **Remaining:** per-connection cursors, webhook→job ingestion with delivery-ID dedupe, ordering/stale-event protection (`source_updated_at` comparison), token refresh, backfill/resync, reconciliation jobs, rate-limit backoff from provider headers, scheduled jobs (cron-like enqueuer).
- **Note:** the minimum of this needed by GitHub lands in 3A/3B; Phase 9 generalizes and hardens it. No Redis unless measured load requires it.

## Phase 10 — Notifications & Controlled Automation
- **Existing:** reviewed, explicitly confirmed, idempotent email sending.
- **Remaining:** notification rules (overdue, blocker, digest), in-app notifications, automation policies table, approval queue for external writes (Jira create, GitHub assign), backend-enforced permissions on every AI-proposed action.
- **Dependencies:** 5, 6, connectors with write scopes.

## Phase 11 — Security, Production Readiness & Meeting Device
- **Existing:** bcrypt, revocable sessions, httpOnly cookies, zod, parameterised SQL, secret isolation, prompt-injection rules, audit.
- **Remaining:** deployment packaging (Docker images for API/worker/SPA, reverse proxy + HTTPS), `trust proxy`, persistent rate limiting, backups/restore runbook, structured logging + error reporting, credential encryption key rotation, data retention, dependency scanning, install/upgrade docs per customer, password reset (if not in 2.5), product rename (cookie/DB names).
- **Device:** separate hardware workstream; only dependency on the platform is an authenticated upload API for audio/transcripts (can reuse the transcript upload + Vexa JSON format).

---

## Recommended execution order

1. **Phase 2.5 — closeout** (days): commit, migrate dev DB, browser check, small gaps.
2. **Phase 3A — integration framework + normalized record core** (includes the Phase 4 tables the framework needs).
3. **Phase 3B — GitHub connector**, verified against a real GitHub org/repo.
4. **Phase 8 (slice) — ops views** for jobs, sync health and AI usage (needed to operate 3B).
5. **Phase 4 (rest)** — commitments, decisions, blockers, dependencies, insights.
6. **Second connector: Jira** (cross-app value needs two sources) — reuses 3A.
7. **Phase 5** correlation + blocker/risk rules, then **Phase 6** generalized extraction.
8. **Phase 7** dashboard over real data (org overview can start earlier).
9. **Phase 9** hardening, **Phase 10** automation, remaining connectors (Teams, Outlook, Figma).
10. **Phase 11** production readiness before the first customer deployment; device workstream in parallel.
