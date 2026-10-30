-- Manual rollback of migrations 005_integrations and 006_work_records (Phase 3A).
-- NOT a migration: run it by hand only if the integration data is not needed. It deletes every
-- connection, stored credential, synced record, activity, link and webhook delivery.
-- Back up first:  docker exec meeting-action-mysql-1 sh -c 'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction meeting_action' > backup.sql
-- Then revert the Phase 3A code (the old code ignores these tables, so code can also be rolled
-- back without running this script).

DELETE FROM jobs WHERE type LIKE 'integration.%';

-- Children before parents (foreign keys).
DROP TABLE IF EXISTS record_links;
DROP TABLE IF EXISTS activities;
DROP TABLE IF EXISTS external_records;
DROP TABLE IF EXISTS external_identities;
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS integration_sync_cursors;
DROP TABLE IF EXISTS integration_resources;
DROP TABLE IF EXISTS integration_auth_states;
DROP TABLE IF EXISTS integration_credentials;
DROP TABLE IF EXISTS integration_connections;

-- 007 (Phase 3B) only added a column to integration_sync_cursors, which is dropped above.
DELETE FROM schema_migrations WHERE filename IN ('005_integrations.sql', '006_work_records.sql', '007_sync_cursor_completion.sql');
