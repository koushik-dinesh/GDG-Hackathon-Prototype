# Phase 10 — Notifications, profile and preferences (2026-10-31)

Status: the **notification part of Phase 10 is complete**. The **automation part of the roadmap's Phase 10 is deferred**; see "Scope decisions". Phase 10 as a whole is therefore still partial.

## What exists

**In-app notifications** (`backend/src/services/notifications/`, table `notifications`). Each one belongs to one person, links to an in-app path and has a unique dedupe key.

| Kind | Who gets it | Trigger | At most |
|---|---|---|---|
| `task_assigned` | Assignee | Meeting review completes, or an approved task's assignee changes | Once per task and person |
| `task_overdue` | Assignee and project owner | Hourly scan, using `MEETING_TIMEZONE`'s "today" | Once per task and due date |
| `task_blocked` | Project owner (no project: admins) | Task status becomes `blocked` | Daily per task |
| `daily_digest` | Anyone with open tasks or unread notifications | Hourly scan, from 9:00 in the person's time zone | Once per local day |
| `suggestions` | Admins, and a manager who owns the projects at both ends | Correlation job stored a suggestion | Daily |
| `integration_error` | Admins | Sync: credentials unreadable, `auth`, `suspended`, other permanent provider errors | Daily per connection |
| `jobs_dead` | Admins | Hourly scan: `dead` or `failed` jobs in the last 24 hours, not admin-cancelled | Daily |

Transient provider errors and rate limits do not notify. Kinds are limited by role in `KINDS`; the API refuses preferences for a kind outside the person's role.

**API** (`routes/me.js`, signed-in person only): `GET/PATCH /me/profile`, `POST /me/password`, `GET/PUT /me/preferences`, `GET /me/notifications`, `GET /me/notifications/unread-count`, `POST /me/notifications/read-all`, `POST /me/notifications/:id/read`.

**Password change:** needs the current password, refuses reuse, is limited to 10 attempts per 15 minutes per person, ends every other session and keeps this one.

**Worker:** `notifications.scan` is queued hourly, runs one at a time (dedupe key), is safe to repeat and can be retried from Operations.

**Frontend:** `/notifications` (read state, mark one or all, filter, "Load more", empty and error states), `/profile` (name, password, preferences, time zone), and an unread badge in the header. The badge reads the count once a minute while the tab is visible, when the tab returns, and after a change in that tab.

**Database:** migration `010_notifications.sql`; see `docs/runbooks/database-migrations.md`.

## Scope decisions

Taken from `WORKAGENT_MASTER_ROADMAP.md`: "notification rules (overdue, blocker, digest), in-app notifications, automation policies table, approval queue for external writes, backend-enforced permissions on every AI-proposed action", and the summary row "Alerts, digests, policies, external writes".

| Requirement | In the roadmap? | Decision |
|---|---|---|
| In-app notifications, overdue rule | Explicit | Done |
| Blocker rule | Explicit | Done for tasks marked blocked. **Deferred:** synced records labelled blocked and `blocks`/`depends_on` links; they show in Insights but do not notify. |
| Scheduled digest | Explicit | Done, in-app |
| Time-zone-aware scheduling | Not named; needed for a digest | Done for the digest. Overdue dates use the company time zone, matching the task pages. |
| Email notifications | Not named as a Phase 10 item | **Deferred.** `email_messages.meeting_id` is required, so email is tied to meetings today; alert and digest email needs a schema change and a per-kind channel preference. |
| Notification retention | Listed under Phase 11 ("data retention") | **Deferred to Phase 11.** Deleting a row also frees its dedupe key, so a task still overdue would notify again; the rule needs deciding with the rest of retention. |
| Automation policies | Explicit | **Deferred.** The roadmap makes it depend on Phase 6 and connectors with write scopes. Every connector is read-only and Phase 6 is partial, so there is nothing yet to govern. |
| Approval queue for external writes | Explicit | **Deferred,** same reason. |
| Permissions on AI-proposed actions | Explicit | **Deferred** for external actions, same reason. Meeting extraction already requires human review. |

## Verification (2026-10-31)

| Check | Environment | Result |
|---|---|---|
| Backend suite | Disposable database | See `WORKAGENT_CURRENT_STATE.md` |
| Live workflow script: 44 checks through the real API and real worker | Dev database, test accounts | 44 passed |
| Suspended, forbidden, auth, transient and rate-limited provider failures, and the failed-job report: 7 checks | Scratch database | 7 passed |
| Browser: employee, manager, admin | Dev stack; integration links on the scratch stack | Passed |
| Rollback, then re-apply | Scratch restore of the backup | Passed |

**Limits of that verification:**
- The fake provider's failure switch lives in process memory, so provider failures ran in a script using the real queue, runner and handlers, not in the `npm run worker` process, and against the fake provider. **No real provider has been exercised.**
- Digest timing across time zones is proven by automated tests with fixed clocks. Live, only the 9:00+ path ran, in Asia/Kolkata.
- Suggestion notifications ran in automated tests against the correlation job, not in the browser, because the dev database has no synced records.
- Second-employee privacy and the second manager were checked through the live API; the browser sessions used one employee, one manager and one admin.

## Known limitations

- A task can't be reassigned once its meeting's review has completed, because the API locks it. So reassignment notifications only arise during review.
- The time zone preference affects only the daily digest.
- The digest is sent late rather than skipped if the worker was down at 9:00.
- `start.sh`'s worker has no file watching: restart it after backend changes.

## Test data left in the dev database

Accounts `p10-admin@`, `p10-mgr1@`, `p10-mgr2@`, `p10-emp1@` and `p10-emp2@workagent.test`; projects "P10 Alpha …" and "P10 Beta …"; meetings "P10 weekly …" and "Browser check …" with their tasks; and one deliberately failed `email.send` job. All can be deactivated or archived. Existing dev users also received real notifications from the scans.
