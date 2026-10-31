-- 010_notifications (Phase 10). Additive: in-app notifications and per-user preferences.
-- No existing data is changed. MySQL DDL auto-commits; statements are independent (fix forward).

CREATE TABLE notifications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id     BIGINT UNSIGNED NOT NULL,
  kind        VARCHAR(32) NOT NULL,
  title       VARCHAR(300) NOT NULL,
  body        VARCHAR(1000) NULL,
  -- In-app path to open (e.g. /my/tasks/12); never an external URL.
  link        VARCHAR(500) NULL,
  entity_type VARCHAR(32) NULL,
  entity_id   BIGINT UNSIGNED NULL,
  -- One notification per event and person (e.g. task_overdue:12:2026-10-31:7).
  dedupe_key  VARCHAR(191) NOT NULL,
  read_at     DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_notif_dedupe (dedupe_key),
  KEY idx_notif_user (user_id, read_at, id),
  KEY idx_notif_created (created_at),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_preferences (
  user_id    BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  -- { notifications: { task_assigned: true, ... }, timeZone: "Europe/Berlin" }; defaults in code.
  settings   JSON NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_prefs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
