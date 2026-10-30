-- 007_sync_cursor_completion (Phase 3B). Additive.
-- A resource sync run works through its streams in order (parents before children, e.g. issues
-- before their comments) and may span several jobs. completed_at marks the streams already
-- finished in the current run, so a rescheduled job continues where it stopped instead of
-- re-checking them. The marks are cleared when the whole resource run completes.
ALTER TABLE integration_sync_cursors
  ADD COLUMN completed_at DATETIME NULL AFTER last_run_at;
