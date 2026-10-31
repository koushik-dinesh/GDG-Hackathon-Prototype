# Database migrations

Migrations are plain SQL in `backend/src/db/migrations/`, applied in filename order by `npm run migrate` and recorded with a checksum in `schema_migrations`. An applied file must never change. Rollbacks are manual scripts in this folder, not migrations.

## Which database am I touching?

| Name | Used by | Notes |
|---|---|---|
| `meeting_action` | `npm run migrate`, `npm run dev`, `npm run worker` | Dev data. Back up first. |
| `meeting_action_test` | `npm test` (default `DB_TEST_NAME`) | **`npm test` migrates it automatically and every test file wipes it.** |

Host and port come from `backend/.env` (`127.0.0.1:3307`, Docker).

## Running tests without touching the shared test database

Real environment variables override `backend/.env`, so point `DB_TEST_NAME` at a throwaway database. The app user needs access to it, so create it as root:

```bash
docker exec meeting-action-mysql-1 sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysql -uroot -e "CREATE DATABASE wa_tmp CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; GRANT ALL PRIVILEGES ON wa_tmp.* TO '"'"'meeting_action'"'"'@'"'"'%'"'"';"'
```

```bash
cd backend && DB_TEST_NAME=wa_tmp NODE_ENV=test MEETING_TIMEZONE=UTC node --test --test-concurrency=1 'test/**/*.test.js'
```

## Applying a migration to the dev database

1. Confirm the target: `DB_NAME` in `backend/.env` and the latest row of `schema_migrations`.
2. Back up to `backups/` (gitignored):
   ```bash
   docker exec meeting-action-mysql-1 sh -c 'MYSQL_PWD=$MYSQL_ROOT_PASSWORD mysqldump -uroot --single-transaction --routines --triggers --no-tablespaces --set-gtid-purged=OFF meeting_action' > backups/meeting_action-pre-NNN-$(date +%Y%m%d-%H%M%S).sql
   ```
3. Check the backup: it ends with `-- Dump completed`, restores into a scratch database, and row counts match per table.
4. Rehearse on that scratch copy: run `DB_NAME=<scratch> node src/db/migrate.js` from `backend/`, then the rollback script, then migrate again.
5. Stop the API and worker, run `npm run migrate`, and check tables, indexes and foreign keys in `information_schema`.
6. Restart the API and worker. **Deploy code and migration together:** new code without its tables logs errors, and scheduled jobs fail until they go dead.

Never try a rollback on the dev database to see if it works; rehearse on a copy.

## Migration log (dev database)

| Migration | Applied (UTC) | Backup | Rollback |
|---|---|---|---|
| `004_work_management.sql` | 2026-10-30 15:11 | `meeting_action-pre-004-20261030-204126.sql` | none |
| `005_integrations.sql`, `006_work_records.sql` | 2026-10-30 16:11, 16:33 | `…pre-005-…`, `…pre-006-…` | `rollback-005-006.sql` |
| `007_sync_cursor_completion.sql` | 2026-10-30 18:05 | `…pre-007-…` | none |
| `008_unified_feed_search.sql` | 2026-10-31 00:23 | `…pre-008-…` | `rollback-008.sql` |
| `009_operations_center.sql` | 2026-10-31 01:42 | `…pre-009-…` | `rollback-009.sql` |
| `010_notifications.sql` | 2026-10-31 04:23 | `meeting_action-pre-010-20261031-095201.sql` | `rollback-010.sql` |

### Migration 010 record

- **Changes:** additive. New tables `notifications` (unique `uq_notif_dedupe`; indexes `idx_notif_user`, `idx_notif_created`; FK `fk_notif_user` → `users`, cascade) and `user_preferences` (FK `fk_prefs_user` → `users`, cascade).
- **Backup:** 147,148 bytes, restored into a scratch database, all 31 tables matched on row count.
- **Rehearsal:** on the restored copy, migrate → `rollback-010.sql` (tables gone, back at 009, row counts of all 31 tables unchanged) → migrate again succeeded.
- **Test database:** `meeting_action_test` was deliberately left at 009. The next plain `npm test` will apply 010 to it.
- **Before rolling back:** roll the code back too, because Phase 10 code needs both tables. Rolling back loses all notifications and preferences.
