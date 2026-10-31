-- Manual rollback of migration 010_notifications (Phase 10). Not a migration.
-- Drops in-app notifications and user preferences (their data is lost). Back up first.
-- Roll the code back together with this script: Phase 10 code needs both tables.
DROP TABLE notifications;
DROP TABLE user_preferences;
DELETE FROM schema_migrations WHERE filename = '010_notifications.sql';
