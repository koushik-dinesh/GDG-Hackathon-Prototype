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
