-- 005_integrations: Phase 3A integration framework (docs/PHASE_3A_PLAN.md §4.1). Additive only:
-- new tables, no change to existing ones. No tenant columns (one deployment per company).
--   integration_connections   one authorized account/installation per row (never deleted)
--   integration_credentials   encrypted secrets per connection (AES-256-GCM, see services/integrations)
--   integration_auth_states   single-use CSRF state for install/OAuth redirects
--   integration_resources     what an admin chose to sync (repository, Jira project, channel, ...)
--   integration_sync_cursors  one checkpoint per resource and stream
--   webhook_deliveries        inbound events, stored before they are processed
-- Statements are in foreign-key order. MySQL DDL auto-commits, so a failure is fixed forward.

CREATE TABLE integration_connections (
  id                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider               VARCHAR(32) NOT NULL,
  -- Where the account lives: github.com, a GitHub Enterprise host, a Jira cloud id.
  source_instance        VARCHAR(191) NOT NULL,
  -- The provider's id for this authorization, e.g. a GitHub App installation id.
  external_account_id    VARCHAR(191) NOT NULL,
  account_login          VARCHAR(191) NULL,
  account_type           VARCHAR(32) NULL,
  display_name           VARCHAR(200) NOT NULL,
  status                 ENUM('pending','active','suspended','error','disconnected') NOT NULL DEFAULT 'pending',
  -- Admin intent, separate from the provider-side status: FALSE pauses scheduling and processing.
  is_enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  -- Non-secret provider settings (granted permissions, subscribed events, repository selection).
  settings               JSON NULL,
  health                 ENUM('unknown','healthy','degraded','failing') NOT NULL DEFAULT 'unknown',
  consecutive_failures   INT NOT NULL DEFAULT 0,
  last_error_code        VARCHAR(64) NULL,
  last_error_message     VARCHAR(500) NULL,
  rate_limit_remaining   INT NULL,
  -- Rate-limit pause shared by every worker and resource of this connection.
  paused_until           DATETIME NULL,
  last_sync_started_at   DATETIME NULL,
  last_sync_succeeded_at DATETIME NULL,
  last_webhook_at        DATETIME NULL,
  connected_by           BIGINT UNSIGNED NULL,
  connected_at           DATETIME NULL,
  disconnected_by        BIGINT UNSIGNED NULL,
  disconnected_at        DATETIME NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_conn_account (provider, source_instance, external_account_id),
  KEY idx_conn_status (status, is_enabled),
  CONSTRAINT fk_conn_connected_by FOREIGN KEY (connected_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_conn_disconnected_by FOREIGN KEY (disconnected_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Only services/integrations/vault.js reads or writes this table. Rows are deleted on disconnect.
CREATE TABLE integration_credentials (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  connection_id BIGINT UNSIGNED NOT NULL,
  kind          VARCHAR(32) NOT NULL,
  -- Which key encrypted the row (HMAC-derived id, reveals nothing about the key).
  key_id        CHAR(16) NOT NULL,
  iv            BINARY(12) NOT NULL,
  auth_tag      BINARY(16) NOT NULL,
  ciphertext    VARBINARY(16384) NOT NULL,
  expires_at    DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cred (connection_id, kind),
  KEY idx_cred_key (key_id),
  CONSTRAINT fk_cred_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_auth_states (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider      VARCHAR(32) NOT NULL,
  purpose       ENUM('install','oauth','reconnect') NOT NULL,
  -- sha256 of a 256-bit random token; the token itself only travels through the redirect.
  state_hash    CHAR(64) NOT NULL,
  user_id       BIGINT UNSIGNED NOT NULL,
  connection_id BIGINT UNSIGNED NULL,
  expires_at    DATETIME NOT NULL,
  consumed_at   DATETIME NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_state (state_hash),
  KEY idx_state_expires (expires_at),
  CONSTRAINT fk_state_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_state_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_resources (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  connection_id             BIGINT UNSIGNED NOT NULL,
  resource_type             VARCHAR(32) NOT NULL,
  external_id               VARCHAR(191) NOT NULL,
  name                      VARCHAR(255) NOT NULL,
  url                       VARCHAR(2048) NULL,
  access_status             ENUM('accessible','removed') NOT NULL DEFAULT 'accessible',
  -- Opt-in: nothing is synced until an admin enables the resource.
  is_enabled                BOOLEAN NOT NULL DEFAULT FALSE,
  -- Default project for records from this resource.
  project_id                BIGINT UNSIGNED NULL,
  metadata                  JSON NULL,
  next_sync_at              DATETIME NULL,
  initial_sync_completed_at DATETIME NULL,
  last_synced_at            DATETIME NULL,
  last_error_message        VARCHAR(500) NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_res (connection_id, resource_type, external_id),
  KEY idx_res_due (is_enabled, access_status, next_sync_at),
  KEY idx_res_project (project_id),
  CONSTRAINT fk_res_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id),
  CONSTRAINT fk_res_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE integration_sync_cursors (
  resource_id        BIGINT UNSIGNED NOT NULL,
  stream             VARCHAR(48) NOT NULL,
  phase              ENUM('backfill','incremental') NOT NULL DEFAULT 'backfill',
  -- Opaque to the framework ({since, page, etag, ...}); CURSOR is a reserved word in MySQL.
  cursor_state       JSON NULL,
  -- Newest source_updated_at seen on this stream.
  high_watermark     DATETIME(3) NULL,
  last_run_at        DATETIME NULL,
  last_error_message VARCHAR(500) NULL,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (resource_id, stream),
  CONSTRAINT fk_cursor_resource FOREIGN KEY (resource_id) REFERENCES integration_resources(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Requests that fail signature verification are never stored here.
CREATE TABLE webhook_deliveries (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider            VARCHAR(32) NOT NULL,
  delivery_id         VARCHAR(191) NOT NULL,
  event_type          VARCHAR(64) NOT NULL,
  action              VARCHAR(64) NULL,
  -- From the payload (e.g. installation.id), so an event can be bound to its connection later.
  external_account_id VARCHAR(191) NULL,
  connection_id       BIGINT UNSIGNED NULL,
  -- Set to NULL once older than the retention period.
  payload             JSON NULL,
  payload_bytes       INT UNSIGNED NOT NULL,
  payload_sha256      CHAR(64) NOT NULL,
  status              ENUM('received','processing','processed','ignored','failed') NOT NULL DEFAULT 'received',
  attempts            INT NOT NULL DEFAULT 0,
  last_error_message  VARCHAR(1000) NULL,
  -- No foreign key: old jobs may be pruned.
  job_id              BIGINT UNSIGNED NULL,
  received_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at        DATETIME NULL,
  payload_purged_at   DATETIME NULL,
  UNIQUE KEY uq_delivery (provider, delivery_id),
  KEY idx_deliv_status (status, received_at),
  KEY idx_deliv_conn (connection_id, received_at),
  CONSTRAINT fk_deliv_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
