-- 004_work_management: Phase 2 (core work management foundation). Additive only; no existing
-- rows are changed except that the role ENUM gains a value.
--   users.role            + 'manager' (manages the projects it owns and the teams it leads)
--   user_sessions         server-side session per login, so logout/deactivation revoke the JWT
--   user_invitations      invitation tokens (sha256 hash only), single use, expiring
--   projects, project_members, teams, team_members
--   meetings.project_id, action_items.project_id   optional, NULL for all existing rows
-- Users are never hard-deleted by the app (soft delete via is_active). Foreign keys that point at
-- users therefore RESTRICT (owners, members) or SET NULL (actors), so history is never cascaded away.

ALTER TABLE users
  MODIFY COLUMN role ENUM('admin','manager','employee') NOT NULL;

CREATE TABLE user_sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  -- sha256 of the random session id carried in the JWT `sid` claim.
  sid_hash     CHAR(64) NOT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  revoked_at   DATETIME NULL,
  revoked_reason VARCHAR(32) NULL,
  ip           VARCHAR(45) NULL,
  user_agent   VARCHAR(255) NULL,
  UNIQUE KEY uq_sessions_sid (sid_hash),
  KEY idx_sessions_user (user_id, revoked_at),
  KEY idx_sessions_expires (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE user_invitations (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id      BIGINT UNSIGNED NOT NULL,
  -- sha256 of the token; the token itself is only ever in the email.
  token_hash   CHAR(64) NOT NULL,
  -- The address the invitation was sent to. Accepting fails if the user's email changed since.
  email        VARCHAR(255) NOT NULL,
  created_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at   DATETIME NOT NULL,
  sent_at      DATETIME NULL,
  send_error   VARCHAR(255) NULL,
  accepted_at  DATETIME NULL,
  revoked_at   DATETIME NULL,
  revoked_by   BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_invitations_token (token_hash),
  KEY idx_invitations_user (user_id, created_at),
  CONSTRAINT fk_invitations_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_invitations_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_invitations_revoker FOREIGN KEY (revoked_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE projects (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(200) NOT NULL,
  description   TEXT NULL,
  status        ENUM('planning','active','on_hold','completed','archived') NOT NULL DEFAULT 'planning',
  owner_user_id BIGINT UNSIGNED NOT NULL,
  start_date    DATE NULL,
  target_date   DATE NULL,
  created_by    BIGINT UNSIGNED NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_projects_name (name),
  KEY idx_projects_status (status),
  KEY idx_projects_owner (owner_user_id),
  CONSTRAINT chk_projects_dates CHECK (start_date IS NULL OR target_date IS NULL OR target_date >= start_date),
  CONSTRAINT fk_projects_owner FOREIGN KEY (owner_user_id) REFERENCES users(id),
  CONSTRAINT fk_projects_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE project_members (
  project_id BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  added_by   BIGINT UNSIGNED NULL,
  added_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, user_id),
  KEY idx_project_members_user (user_id),
  CONSTRAINT fk_pm_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT fk_pm_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_pm_added_by FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE teams (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name         VARCHAR(200) NOT NULL,
  description  TEXT NULL,
  lead_user_id BIGINT UNSIGNED NULL,
  created_by   BIGINT UNSIGNED NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_teams_name (name),
  KEY idx_teams_lead (lead_user_id),
  CONSTRAINT fk_teams_lead FOREIGN KEY (lead_user_id) REFERENCES users(id),
  CONSTRAINT fk_teams_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE team_members (
  team_id  BIGINT UNSIGNED NOT NULL,
  user_id  BIGINT UNSIGNED NOT NULL,
  added_by BIGINT UNSIGNED NULL,
  added_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (team_id, user_id),
  KEY idx_team_members_user (user_id),
  CONSTRAINT fk_tm_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_tm_added_by FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Projects are never deleted by the app (they are archived), so RESTRICT keeps history intact.
ALTER TABLE meetings
  ADD COLUMN project_id BIGINT UNSIGNED NULL AFTER title,
  ADD KEY idx_meetings_project (project_id),
  ADD CONSTRAINT fk_meetings_project FOREIGN KEY (project_id) REFERENCES projects(id);

ALTER TABLE action_items
  ADD COLUMN project_id BIGINT UNSIGNED NULL AFTER meeting_id,
  ADD KEY idx_items_project (project_id, review_status),
  ADD CONSTRAINT fk_items_project FOREIGN KEY (project_id) REFERENCES projects(id);
