-- 008_unified_feed_search (Phase 4). Additive: indexes for the unified activity feed and search,
-- and two more relationship types. No data is changed.
-- MySQL DDL auto-commits; statements are independent, so a failure is fixed forward.

-- Unified activity feed filters (each ends in occurred_at for newest-first paging).
ALTER TABLE activities
  ADD KEY idx_act_provider_time (provider, occurred_at),
  ADD KEY idx_act_type_time (activity_type, occurred_at),
  ADD KEY idx_act_actor_user_time (actor_user_id, occurred_at);

ALTER TABLE external_records
  ADD KEY idx_rec_provider_type (provider, record_type, source_updated_at);

-- Unified search (InnoDB FULLTEXT; short terms and keys fall back to LIKE in the service).
ALTER TABLE external_records ADD FULLTEXT KEY ft_rec_text (title, body);
ALTER TABLE action_items ADD FULLTEXT KEY ft_items_text (title, description);
ALTER TABLE meetings ADD FULLTEXT KEY ft_meetings_text (title);
ALTER TABLE projects ADD FULLTEXT KEY ft_projects_text (name, description);

-- Relationship types: a pull request `includes` a commit; a WorkAgent task `tracks` external work.
ALTER TABLE record_links
  MODIFY COLUMN link_type ENUM('references','implements','fixes','duplicates','same_as','blocks','depends_on','discussed_in','related','includes','tracks') NOT NULL;
