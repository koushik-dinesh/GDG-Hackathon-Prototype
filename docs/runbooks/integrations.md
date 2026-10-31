# Integrations runbook (Phase 3A)

Operational guide for the integration framework in one WorkAgent deployment. Design: `docs/PHASE_3A_PLAN.md`.
Everything below is per deployment (one company, one database). All commands run from `backend/` unless stated.

---

## 1. Turning integrations on

1. **Encryption key** (required before any provider that stores credentials can be used):
   ```bash
   openssl rand -base64 32
   ```
   Put the value in `backend/.env` as `CREDENTIALS_ENCRYPTION_KEY=…`.
   - Keep it outside the database and outside database backups (password manager or secret store).
   - Losing it only means stored connections must be reconnected. Synced records are not encrypted and stay.
   - The server refuses to start if the value doesn't decode to 32 bytes.
2. **Migrations:** back up first (§6), then `npm run migrate`. This applies `005_integrations.sql` and `006_work_records.sql`, which are additive.
3. **Workers.** Choose one setup:
   - One worker that runs every job type (default: `WORKER_JOB_TYPES` empty).
   - Recommended in production: two workers, so a long first sync never delays email or AI work:
     ```bash
     WORKER_JOB_TYPES=ai.extract,email.send,vexa.poll npm run worker
     WORKER_JOB_TYPES=integration.sync,integration.webhook,integration.maintenance npm run worker
     ```
   Only workers that run `integration.sync` schedule syncs. Several may run; jobs are deduplicated.
4. **Provider configuration:** each provider has its own variables (GitHub: Phase 3B). Admin → **Integrations** lists every provider and says what is missing.
5. **Trying the screens without a real provider:** `INTEGRATIONS_FAKE_PROVIDER=true` (ignored in production) adds a built-in fake provider with two repositories.

## 2. Connecting and syncing

1. Admin → Integrations → **Connect <provider>**. This goes through the provider's consent screen and back to `/integrations/<provider>/setup`.
   - The connect link works once, only for the admin who started it, for 10 minutes.
2. On the connection page:
   - Tick **Sync** for each repository/project to include. Nothing syncs by default.
   - Optionally choose a **Project**. Mind the warning: everyone who can see a project sees titles and activity of what is mapped to it.
3. Syncs run automatically:
   - Each enabled resource is re-synced every `INTEGRATION_SYNC_INTERVAL_MIN` (default 15).
   - The first sync covers `INTEGRATION_BACKFILL_DAYS` (default 90).
   - **Sync now** queues an immediate run.
4. Each sync job stops after `INTEGRATION_SYNC_CHUNK_MS` / `INTEGRATION_SYNC_CHUNK_REQUESTS` and continues later, so it never blocks other jobs.

| Connection shows | Meaning | Action |
|---|---|---|
| Health *Degraded* / *Failing* | Temporary provider errors (failing after 3 in a row) | Usually none; it recovers on the next successful sync |
| Rate limit *Paused until …* | The provider's request budget is nearly used (`INTEGRATION_RATE_LIMIT_RESERVE`) | None; resumes automatically |
| Status *Needs reconnect* | Credentials rejected or unreadable | Connect again (same account → same connection, data kept) |
| Status *Suspended* | Suspended at the provider | Unsuspend at the provider |
| Resource *access removed* | The provider no longer grants access | Re-grant at the provider, then **Refresh list** |

## 3. Webhooks

- **Endpoint:** `POST https://<public-host>/api/v1/webhooks/<provider>`.
- **What it accepts:** only correctly signed JSON, up to `WEBHOOK_MAX_BYTES` (10 MB by default). Anything else is refused and never stored.
- **Response:** `202`. Processing happens in the worker.
- **Delivery history:** shown on the connection page.
  - **Replay** re-queues a stored delivery; processing is idempotent.
  - Payloads are deleted after `WEBHOOK_PAYLOAD_RETENTION_DAYS` (default 14); the history stays. A maintenance job runs every 6 hours.
- **Missed webhooks** are not a data-loss risk: the periodic sync reconciles everything.

### Development: Cloudflare Tunnel (expose only the webhook path)

Never expose the whole API. Example `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: workagent-dev.<your-domain>
    path: ^/api/v1/webhooks/
    service: http://localhost:4000
  - service: http_status:404
```

Then run `cloudflared tunnel run <tunnel-name>`, and use `https://workagent-dev.<your-domain>/api/v1/webhooks/<provider>` as the provider's webhook URL.

Check the routing:
- `curl -i https://workagent-dev.<your-domain>/api/v1/health` must return **404**, because only the webhook path is routed.
- An unsigned POST to the webhook URL must return **401**.

The OAuth/App setup redirect goes to `APP_PUBLIC_URL` in the admin's own browser, so it doesn't need the tunnel.

## 4. Rotating the encryption key

1. Generate a new key.
2. In `backend/.env`, set `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` to the old key and `CREDENTIALS_ENCRYPTION_KEY` to the new one.
3. Restart the API and the workers. Both keys can now decrypt, and new writes use the new key. Rows are also re-encrypted as they are read.
4. Run `npm run credentials:rotate`. It re-encrypts every remaining row, is safe to repeat, and exits 1 if some rows are unreadable with both keys. Those connections must be reconnected.
5. Remove `CREDENTIALS_ENCRYPTION_KEY_PREVIOUS` and restart.

Webhook secrets are provider configuration (env). Providers accept a `…_PREVIOUS` secret during their own rotation (GitHub: Phase 3B).

## 5. Disconnecting and data

- **Disconnect:**
  - Deletes the stored credentials, tells the provider (best effort) and stops syncing.
  - Keeps the connection row and all synced records, activities and links.
  - Reconnecting the same account reuses the connection.
- **People:** `GET/PATCH /api/v1/integrations/identities` match source accounts to users. They match automatically only on an exact email, or an alias that belongs to exactly one user.
- **Deleting synced data** (retention or privacy requests) is a Phase 11 feature. Until then it is manual SQL; ask the developer.

## 6. Backup and rollback

- **Back up before every migration:**
  ```bash
  docker exec meeting-action-mysql-1 sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --triggers meeting_action' > ../backups/meeting_action-$(date +%Y%m%d-%H%M%S).sql
  ```
  `backups/` is gitignored. Store copies elsewhere for production.
- **Code rollback:** revert the Phase 3A commits. The new tables are ignored by older code.
- **Schema rollback** (destroys all integration data): `docs/runbooks/rollback-005-006.sql`. Dry-run it on a scratch database first (§7).

## 7. Verifying an installation

```bash
cd backend && npm test        # includes the integration framework and the secret-leak regression test
cd frontend && npm test && npm run build
```

Then check:
- `GET /api/v1/integrations/providers` as an admin lists the providers you expect, as `available`.
- A worker started with `WORKER_JOB_TYPES=integration.sync` logs `integration providers` on start-up.

## 8. GitHub (Phase 3B)

WorkAgent connects to GitHub as a **GitHub App** (no personal access tokens). There is one App per deployment. Each company account the App is installed on becomes one connection.

### 8.1 Create the App (once per deployment)

1. On GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App** (on the organization, for an org-owned App).
2. Fill in the App settings:
   - **Name:** e.g. `WorkAgent <Company>`. Its URL name is the *slug* (`github.com/apps/<slug>`).
   - **Homepage URL:** the WorkAgent URL.
   - **Setup URL:** `https://<workagent-host>/integrations/github/setup`. Tick **Redirect on update**.
     - Locally this is `http://localhost:5173/integrations/github/setup`. GitHub redirects the admin's browser, so localhost works.
   - **Callback URL / "Request user authorization (OAuth) during installation":** leave empty and unticked. They are not used.
   - **Webhook:** active.
     - URL: `PUBLIC_WEBHOOK_BASE_URL/api/v1/webhooks/github`. Locally, use the Cloudflare Tunnel hostname (§3), which routes only `/api/v1/webhooks/`.
     - Secret: `openssl rand -hex 32`. This becomes `GITHUB_WEBHOOK_SECRET`.
   - **Repository permissions** (all **read-only**):
     - Metadata (mandatory)
     - Issues
     - Pull requests
     - Contents (needed for commit history; WorkAgent never downloads file contents)

     Everything else: no access.
   - **Subscribe to events:** Issues, Issue comment, Pull request, Pull request review, Pull request review comment, Push, Repository. Installation events are always sent.
   - **Where can this App be installed:** *Only on this account* (recommended).
3. Create the App, then from its settings page:
   - note the **App ID**;
   - **Generate a private key** (a `.pem` download). Store it outside the repository with `chmod 600`.
4. Configure `backend/.env` (see `.env.example`):
   - `GITHUB_APP_ID`
   - `GITHUB_APP_SLUG`
   - `GITHUB_APP_PRIVATE_KEY_PATH` (or `GITHUB_APP_PRIVATE_KEY`)
   - `GITHUB_WEBHOOK_SECRET`
   - `PUBLIC_WEBHOOK_BASE_URL`
   - `CREDENTIALS_ENCRYPTION_KEY` (§1)

   Restart the API and the workers. The API refuses to start with a malformed private key. Admin → Integrations should now show GitHub as available, with the webhook URL to paste.

### 8.2 Connect and choose repositories

1. Admin → Integrations → **Connect GitHub**. GitHub shows the install screen: choose the account, then *All* or *Only select repositories*.
2. GitHub sends you back to WorkAgent. The installation is verified through the App's own credentials before anything is stored.
   - "An organization owner must approve…" means the installation is waiting for an org owner. Connect again once it has been approved.
3. On the connection page:
   - Tick **Sync** for each repository to include, and map it to a project.
   - New repositories granted later on GitHub arrive unticked.
   - **Manage repository access on GitHub** opens the installation settings.
4. Map people under **Integrations → People in connected applications**. GitHub accounts are never matched to users by login or name automatically.

What is synced per repository:
- repository metadata;
- issues, including open ones older than the backfill window;
- pull requests, with their reviews;
- issue/PR comments and review comments;
- default-branch commits.

Webhooks bring changes in between syncs, including commits on other branches. No file contents, diffs or archives are downloaded.

### 8.3 Rotation and revocation

| What | How |
|---|---|
| Webhook secret | Put the new secret in GitHub. Set `GITHUB_WEBHOOK_SECRET_PREVIOUS` = old and `GITHUB_WEBHOOK_SECRET` = new, then restart. Both are accepted. Remove the previous one once no old deliveries remain. |
| Private key | Generate a new key on GitHub (several can be active), switch `GITHUB_APP_PRIVATE_KEY_PATH`, restart, then delete the old key on GitHub. |
| Installation tokens | Automatic: 1-hour tokens, renewed 5 minutes before expiry and after any 401. Stored only in the encrypted vault. |
| App uninstalled on GitHub | The `installation.deleted` webhook marks the connection disconnected and deletes its credentials. Synced data stays. |
| Suspended on GitHub | The connection shows *Suspended* and syncing stops; unsuspending resumes it. |

### 8.4 Real GitHub verification procedure

Run this against a real App and a test repository. Live verification has **not** been performed yet: the automated tests use a fake GitHub over HTTP.

1. **Setup:**
   - Create the App (§8.1) with the tunnel webhook URL.
   - Create a private test repository containing:
     - 2 issues (1 closed);
     - 1 pull request with a review and a review comment;
     - an issue comment;
     - 2 commits on `main`.
2. **Configure:** set `.env` and start the API, a worker and the tunnel.
   - Check: `curl -i https://<tunnel>/api/v1/health` returns **404**.
   - Check: an unsigned `POST` to the webhook URL returns **401**.
3. **Connect:** Admin → Integrations → Connect GitHub. Install on the test repository only.
   - **Expect:** the connection is *Connected*, the repository is listed (private), and *Stored credentials* shows "installation token".
4. **First sync:** tick **Sync**, map to a project, then **Sync now**.
   - **Expect:** health *Healthy*.
   - **Expect** on the project page, under *Development*:
     - the open issue and the PR;
     - activity entries for created/closed, the review, the comments and the commits.
5. **Webhooks:**
   - **Edit** an issue title on GitHub. **Expect:** a delivery shows *Processed* within seconds and the title updates.
   - **Redeliver** the same delivery from the App's *Advanced* tab. **Expect:** no duplicate records or activities.
6. **Branch push:** push a commit to another branch. **Expect:** a commit activity with that branch.
7. **Repository access:** add a second repository to the installation on GitHub. **Expect:** it appears, unticked.
8. **Credential refresh:** revoke the installation token (or wait an hour) and **Sync now**. **Expect:** it still succeeds, because a new token is minted.
9. **Uninstall:** uninstall the App on GitHub. **Expect:** status *Disconnected*, *Stored credentials* "None", and synced data still visible.
10. **Secrets:** search the API and worker logs for `ghs_`, `BEGIN` and the webhook secret. **Expect:** no matches.
11. **Record the result:** date, App ID (not the key), and any deviations, in `docs/WORKAGENT_CURRENT_STATE.md`.

## 9. Unified activity, search and relationships (Phase 4)

- **Activity feed** (`/activity`, `GET /api/v1/activities`): WorkAgent events and connected-application events in one timeline.
  - WorkAgent events cover tasks (created, assigned, started, completed, reopened), meetings (scheduled, conducted, review completed) and projects (created, status changed).
  - Filters: project, person, source, activity type, subject type, status, date range and record. Paged with "Load more".
  - Visibility follows projects. Task events follow task visibility: members see only their own tasks; project owners and admins see all.
- **Activity vocabulary:** `backend/src/services/activities/types.js`. Connectors must use these verbs.
- **WorkAgent activities** come from the audit entry of each change (`services/audit.js` → `services/activities/internal.js`), in the same transaction.
  - History before Phase 4: run `npm run activities:backfill`. It is idempotent: a second run creates 0.
- **Record changes without a provider event** (status change, rename, deletion at the source, archival) are added by ingest, with the connectors' own key format, so they never duplicate a webhook event.
- **Search** (`/search` and the header box, `GET /api/v1/search`) covers projects, meetings, tasks and synced records.
  - Uses MySQL InnoDB FULLTEXT (migration 008). Words of 3+ letters are prefix-matched; shorter words and keys (`#12`, a commit sha) use LIKE.
  - Records deleted at the source are hidden unless `includeDeleted=true`.
- **Relationships** (Related records on record, task and meeting pages; `GET/POST/PATCH /api/v1/record-links`):
  - **Who may change them:** admins anywhere; managers when both records are in projects they manage; employees never.
  - **Removing** a relationship rejects it, so its history and provenance stay.
  - **Inferred relationships** (`origin` rule/ai) are only ever *suggested*. A person confirms or rejects them, and a rejected one is never suggested again (`services/correlation/`).
  - **GitHub-stated relationships** (origin `source`, confirmed): "Fixes/Closes/Resolves #N" in a PR or commit (same repository), and a merged PR `includes` its merge commit.
- **Source status** on record pages:
  - *deleted*: deleted at the source;
  - *disconnected* / *needs reconnect*: integration status;
  - *access removed* / *not syncing*: the repository.

  In every case the data and history are kept, and nothing is deleted automatically.
- **Retention:**
  - records, activities and relationships are kept indefinitely;
  - webhook payloads for 14 days (§3);
  - deleting synced data on request is a Phase 11 feature.
- **Rollback of 008:** `docs/runbooks/rollback-008.sql`. It only removes indexes and two relationship types.

## 10. Relationship suggestions (Phase 5)

- **What produces them:** job `correlation.evaluate`, run by the worker. It is queued (one active job per subject) when ingest inserts or updates a record, and when tasks or meetings change (approval, edit, project change, transcript, review completed).
- **Matchers** (`backend/src/services/correlation/matchers.js`):
  - *Explicit reference* — `owner/repo#12`, `PAY-42` (0.9), `#12` inside one repository (0.75).
  - *Similar wording* — an approved task and an issue/PR in the same project (0.45–0.9; +0.1 when the same person).
  - *Around a meeting* — an issue/PR created 1 day before to 3 days after a meeting of its project, about the same topic (0.45–0.8).
  - Further matchers can be added with `registerMatcher()`; they must return suggestions only.
- **Review:** `/suggestions` (admins everywhere, managers within projects they manage) or Related records on any record/task/meeting page. Confirming creates the relationship; rejecting keeps the row as rejected so it is never suggested again.
- **Nothing is ever linked automatically.** Records deleted at the source withdraw their open suggestions.
- **Re-running for everything** (after adding a matcher, or for data synced before Phase 5): `cd backend && npm run correlation:queue`. Safe to repeat: subjects that already have an active job are skipped.
- **Worker scoping:** include `correlation.evaluate` in `WORKER_JOB_TYPES` if that variable is set.
- **Rollback:** no migration. To disable, remove the handler from a worker's `WORKER_JOB_TYPES`; queued jobs stay pending. To discard open suggestions: `UPDATE record_links SET status='rejected' WHERE status='suggested' AND origin IN ('rule','ai')`.

## 11. Jira Cloud

**Status:** implemented and tested against a local fake of Atlassian's OAuth and Jira REST v3 (`backend/test/jira.test.js`, 22 tests). **Not verified against a live Jira site** — no Atlassian credentials were available.

### 11.1 Create the OAuth app (once, by an Atlassian admin)

1. developer.atlassian.com → Developer console → Create → **OAuth 2.0 integration**, e.g. "WorkAgent".
2. **Permissions → Jira API → Add**, then configure these scopes: `read:jira-work`, `read:jira-user`. (`offline_access` is requested by WorkAgent itself so refresh tokens are issued.)
3. **Authorization → OAuth 2.0 (3LO)**: callback URL `<APP_PUBLIC_URL>/integrations/jira/setup` (e.g. `https://workagent.example.com/integrations/jira/setup`). It must match exactly.
4. **Settings**: copy the Client ID and Secret into `backend/.env` as `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET`; set `JIRA_SITE_URL` to your site (`https://<company>.atlassian.net`). Restart the API and worker.
5. While the app is in development, only its owner can consent; for other admins, set **Distribution → Sharing** on.

### 11.2 Webhooks (recommended; polling works without them)

1. Generate a secret: `openssl rand -hex 32`, set it as `JIRA_WEBHOOK_SECRET`, restart.
2. In Jira: **Settings → System → WebHooks → Create a WebHook**: URL `<PUBLIC_WEBHOOK_BASE_URL>/api/v1/webhooks/jira`, the same **Secret**, events: Issue created/updated/deleted and Comment created/updated/deleted. Optionally restrict with JQL to the synced projects.
3. Jira signs each delivery (`X-Hub-Signature: sha256=…`); unsigned or wrongly signed requests get 401 and are never stored. Deliveries are deduplicated by `X-Atlassian-Webhook-Identifier`.

### 11.3 Connect and sync

- Integrations → Jira → **Connect**. Atlassian asks for consent; choose the site in `JIRA_SITE_URL`. WorkAgent refuses grants for other sites or without offline access.
- Projects appear as resources (disabled). Tick **Sync** and map each to a WorkAgent project.
- Sync: open issues of any age plus everything updated in the backfill window, then incremental by `updated` (JQL in the API user's time zone, with a 5-minute overlap). Comments beyond those inlined in search results are fetched per issue.
- Data: issues (key `PAY-42`, status and category, assignee, labels, due date, priority, parent), comments, people (Atlassian account ids; e-mail only if the user's privacy settings share it), and links: *blocks*, *duplicates*, *relates/clones* (related) and sub-tasks (*includes*). Deleted issues and comments are marked deleted, never removed.
- `PAY-42` mentioned in GitHub, tasks or meetings is suggested as a relationship (Phase 5); Jira issues count in insights (Phase 7), including labels containing "blocked" and *blocks* links.

### 11.4 Tokens, revocation and disconnecting

- Access tokens last an hour and are refreshed automatically; Atlassian rotates the refresh token on each refresh and WorkAgent stores the new one with the access token (both encrypted).
- If the grant is revoked or the refresh token expires (90 days without use), the connection turns to **error / needs reconnect**; use Connect again — resources, mappings and data are kept.
- Disconnect deletes the stored tokens. Atlassian has no API to revoke a 3LO grant: also remove the app at **id.atlassian.com → Security → Connected apps**.
- Rate limits: HTTP 429 with `Retry-After` pauses the connection until then.

### 11.5 Live verification checklist (when credentials exist)

1. Connect; check Integrations shows the site, scopes and projects.
2. Enable one project; **Sync now**; compare issue count with `project = KEY AND (statusCategory != Done OR updated >= -90d)` in Jira.
3. Edit an issue in Jira; with webhooks on it appears within seconds (Webhook deliveries list: processed), otherwise at the next sync.
4. Revoke the app at id.atlassian.com; the next sync marks the connection *needs reconnect*.
5. Record the result in `docs/WORKAGENT_CURRENT_STATE.md`.

## 12. Microsoft Teams and Outlook (Microsoft Graph)

**Status:** implemented and tested against a local fake of Microsoft identity and Graph (`backend/test/microsoft.test.js`, 25 tests incl. both contract suites and API → sync engine end to end). **Not verified against a live Microsoft 365 tenant.** **Change notifications (Graph subscriptions) are not implemented:** both connectors poll with delta queries on the sync interval (`INTEGRATION_SYNC_INTERVAL_MIN`).

### 12.1 Register the app (once, by an Entra administrator)

1. entra.microsoft.com → App registrations → New registration: "WorkAgent", **single tenant**.
2. Redirect URIs (platform *Web*): `<APP_PUBLIC_URL>/integrations/microsoft_teams/setup` and `<APP_PUBLIC_URL>/integrations/outlook/setup`.
3. Certificates & secrets → New client secret; note its expiry and put a renewal reminder in the calendar.
4. API permissions → Microsoft Graph → **Delegated**: `User.Read`, `offline_access`, and
   - Teams: `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` (needs **admin consent**);
   - Outlook: `Mail.Read`, `Calendars.Read`.
   Then **Grant admin consent** for the tenant.
5. `backend/.env`: `MS_CLIENT_ID` (Application ID), `MS_CLIENT_SECRET`, `MS_TENANT_ID` (Directory ID). Restart API and worker.

### 12.2 What each connection is

- A connection is **one Microsoft account** of the tenant (whoever signs in on Connect). Teams sees the channels of the teams that account belongs to; Outlook sees that account's mail folders and calendars. Use a dedicated service account if the data should not depend on one person.
- WorkAgent refuses grants missing the permissions above (e.g. no admin consent) and grants without offline access.
- **Teams:** resources are channels (`Team / Channel`). Records: channel posts and their replies (`message`), edits and deletions. Mentions like `PAY-42` or `acme/api#12` produce relationship suggestions.
- **Outlook:** resources are mail folders and calendars. Mail records keep subject, sender, recipients and Graph's ~255-character **preview only** — never full bodies or attachments. Calendar events keep subject, start/end, organizer, attendees, the Teams join link and status (scheduled / done / cancelled). Senders and organizers are people identified by e-mail address and matched to WorkAgent users with the same e-mail automatically.
- Deletions (Graph `@removed`) mark records deleted and keep what was stored. An expired delta token (Graph forgets them after ~7 days without sync) restarts from the backfill window. HTTP 429/503 with `Retry-After` pauses the connection.

### 12.3 Revocation and disconnecting

- Tokens: access ~1 h, refreshed automatically; refresh tokens are replaced on each refresh. A revoked grant or expired client secret turns the connection to **needs reconnect**.
- Disconnect deletes the stored tokens. To revoke at Microsoft: Entra → Enterprise applications → WorkAgent → Permissions/Users, or the user at myaccount.microsoft.com → Apps.

### 12.4 Live verification checklist

1. Connect Teams with the service account; check channels are listed. Enable one channel, map it, Sync now; compare messages with the channel.
2. Delete a message in Teams; after the next sync the record shows *deleted* with its text kept.
3. Connect Outlook; enable Inbox and Calendar; check mail previews and events (with join links).
4. Remove admin consent in Entra; the next sync marks the connection *needs reconnect*.
5. Record the result in `docs/WORKAGENT_CURRENT_STATE.md`.
