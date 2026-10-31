-- 009_operations_center (Phase 8). Additive: indexes for the operations center listings
-- (jobs by status/type, audit log by action/actor, e-mail and AI run history by time).
-- No data is changed. MySQL DDL auto-commits; statements are independent (fix forward).

ALTER TABLE jobs
  ADD KEY idx_jobs_status_updated (status, updated_at),
  ADD KEY idx_jobs_type_status (type, status, updated_at);

ALTER TABLE audit_logs
  ADD KEY idx_audit_action_created (action, created_at),
  ADD KEY idx_audit_actor_created (actor_user_id, created_at);

ALTER TABLE email_messages ADD KEY idx_email_created (created_at);
ALTER TABLE extraction_runs ADD KEY idx_runs_created (created_at);
