-- Manual rollback of migration 009_operations_center (Phase 8). Not a migration.
-- 009 only added indexes; no data was changed. Back up first (docs/runbooks/integrations.md §6).
-- The operations center still works without them, only slower on large tables.
ALTER TABLE jobs DROP KEY idx_jobs_status_updated, DROP KEY idx_jobs_type_status;
ALTER TABLE audit_logs DROP KEY idx_audit_action_created, DROP KEY idx_audit_actor_created;
ALTER TABLE email_messages DROP KEY idx_email_created;
ALTER TABLE extraction_runs DROP KEY idx_runs_created;
DELETE FROM schema_migrations WHERE filename = '009_operations_center.sql';
