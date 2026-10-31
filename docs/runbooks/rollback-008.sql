-- Manual rollback of migration 008_unified_feed_search (Phase 4). Not a migration.
-- 008 only added indexes and two relationship types; no data was changed by it. Removing the
-- relationship types fails while links of those types exist: reject or delete them first
-- (SELECT * FROM record_links WHERE link_type IN ('includes','tracks')).
-- Back up first (docs/runbooks/integrations.md §6). The Phase 4 code needs these indexes for
-- search; roll the code back together with this script.
ALTER TABLE activities DROP KEY idx_act_provider_time, DROP KEY idx_act_type_time, DROP KEY idx_act_actor_user_time;
ALTER TABLE external_records DROP KEY idx_rec_provider_type;
ALTER TABLE external_records DROP KEY ft_rec_text;
ALTER TABLE action_items DROP KEY ft_items_text;
ALTER TABLE meetings DROP KEY ft_meetings_text;
ALTER TABLE projects DROP KEY ft_projects_text;
ALTER TABLE record_links
  MODIFY COLUMN link_type ENUM('references','implements','fixes','duplicates','same_as','blocks','depends_on','discussed_in','related') NOT NULL;
DELETE FROM schema_migrations WHERE filename = '008_unified_feed_search.sql';
-- Internal activities (provider = 'workagent') can stay: older code ignores them. To remove them:
-- DELETE FROM activities WHERE provider = 'workagent';
