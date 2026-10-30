-- 006_work_records: Phase 3A core data architecture (docs/PHASE_3A_PLAN.md §4.2). Additive only.
--   external_identities  people and bots in source systems, optionally matched to a user
--   external_records     normalized copy of each source object (issue, pull request, commit, ...)
--   activities           append-only meaningful events: the future unified timeline
--   record_links         typed relationships between records, meetings, action items and users
-- Rules: a record's project lives only in external_records.project_id (never in record_links);
-- internal entities (meetings, action items) are not copied into external_records.

CREATE TABLE external_identities (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider         VARCHAR(32) NOT NULL,
  source_instance  VARCHAR(191) NOT NULL,
  -- The provider's stable user id (GitHub numeric id: logins can change).
  external_user_id VARCHAR(191) NOT NULL,
  login            VARCHAR(191) NULL,
  display_name     VARCHAR(200) NULL,
  email            VARCHAR(255) NULL,
  is_bot           BOOLEAN NOT NULL DEFAULT FALSE,
  user_id          BIGINT UNSIGNED NULL,
  match_method     ENUM('none','manual','email','alias') NOT NULL DEFAULT 'none',
  matched_by       BIGINT UNSIGNED NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ident (provider, source_instance, external_user_id),
  KEY idx_ident_user (user_id),
  CONSTRAINT fk_ident_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_ident_matched_by FOREIGN KEY (matched_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Records are never hard-deleted (source deletions set source_deleted_at).
CREATE TABLE external_records (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  provider           VARCHAR(32) NOT NULL,
  source_instance    VARCHAR(191) NOT NULL,
  record_type        VARCHAR(48) NOT NULL,
  -- Unique per (provider, source_instance, record_type), not per connection, so reinstalling an
  -- app (new connection) updates the same records instead of duplicating them.
  external_id        VARCHAR(191) NOT NULL,
  -- Human key used for cross-application matching: owner/repo#123, PAY-42.
  external_key       VARCHAR(191) NULL,
  connection_id      BIGINT UNSIGNED NOT NULL,
  resource_id        BIGINT UNSIGNED NULL,
  parent_record_id   BIGINT UNSIGNED NULL,
  url                VARCHAR(2048) NULL,
  title              VARCHAR(500) NULL,
  body               TEXT NULL,
  state              VARCHAR(32) NULL,
  status_category    ENUM('todo','in_progress','done','cancelled','unknown') NOT NULL DEFAULT 'unknown',
  author_identity_id BIGINT UNSIGNED NULL,
  project_id         BIGINT UNSIGNED NULL,
  -- TRUE when the project was set by hand; then a resource re-mapping leaves the record alone.
  project_locked     BOOLEAN NOT NULL DEFAULT FALSE,
  metadata           JSON NULL,
  -- sha256 of the normalized content; an unchanged hash means nothing is written.
  content_hash       CHAR(64) NOT NULL,
  source_created_at  DATETIME(3) NULL,
  source_updated_at  DATETIME(3) NULL,
  source_deleted_at  DATETIME(3) NULL,
  first_seen_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Last time content from the source was written.
  last_synced_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rec_source (provider, source_instance, record_type, external_id),
  KEY idx_rec_project (project_id, record_type, source_updated_at),
  KEY idx_rec_resource (resource_id, record_type, source_updated_at),
  KEY idx_rec_key (external_key),
  KEY idx_rec_parent (parent_record_id),
  KEY idx_rec_author (author_identity_id),
  CONSTRAINT fk_rec_connection FOREIGN KEY (connection_id) REFERENCES integration_connections(id),
  CONSTRAINT fk_rec_resource FOREIGN KEY (resource_id) REFERENCES integration_resources(id) ON DELETE SET NULL,
  CONSTRAINT fk_rec_parent FOREIGN KEY (parent_record_id) REFERENCES external_records(id) ON DELETE SET NULL,
  CONSTRAINT fk_rec_author FOREIGN KEY (author_identity_id) REFERENCES external_identities(id) ON DELETE SET NULL,
  CONSTRAINT fk_rec_project FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Append-only. dedupe_key is derived from what happened (not from how it arrived), so the same
-- event seen by a webhook and by a sync is stored once.
CREATE TABLE activities (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  dedupe_key          VARCHAR(191) NOT NULL,
  provider            VARCHAR(32) NOT NULL,
  activity_type       VARCHAR(48) NOT NULL,
  -- No ON DELETE action: MySQL forbids referential actions on columns used in a CHECK, and
  -- records are never deleted anyway.
  external_record_id  BIGINT UNSIGNED NULL,
  -- Internal subject (Phase 7 timeline); not written in Phase 3.
  entity_type         ENUM('meeting','action_item','project') NULL,
  entity_id           BIGINT UNSIGNED NULL,
  actor_identity_id   BIGINT UNSIGNED NULL,
  actor_user_id       BIGINT UNSIGNED NULL,
  -- Denormalized from the record for timeline queries; kept in step with record project changes.
  project_id          BIGINT UNSIGNED NULL,
  occurred_at         DATETIME(3) NOT NULL,
  summary             VARCHAR(500) NOT NULL,
  details             JSON NULL,
  origin              ENUM('webhook','sync','internal') NOT NULL,
  webhook_delivery_id BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_act_dedupe (dedupe_key),
  KEY idx_act_project_time (project_id, occurred_at),
  KEY idx_act_record_time (external_record_id, occurred_at),
  KEY idx_act_actor_time (actor_identity_id, occurred_at),
  KEY idx_act_entity (entity_type, entity_id),
  KEY idx_act_time (occurred_at),
  CONSTRAINT chk_act_subject CHECK (external_record_id IS NOT NULL OR entity_type IS NOT NULL),
  CONSTRAINT fk_act_record FOREIGN KEY (external_record_id) REFERENCES external_records(id),
  CONSTRAINT fk_act_actor_identity FOREIGN KEY (actor_identity_id) REFERENCES external_identities(id) ON DELETE SET NULL,
  CONSTRAINT fk_act_actor_user FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_act_project FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT fk_act_delivery FOREIGN KEY (webhook_delivery_id) REFERENCES webhook_deliveries(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Polymorphic endpoints have no foreign keys; services/integrations/links.js checks that both
-- exist. Symmetric link types are stored once, smaller (type, id) first.
CREATE TABLE record_links (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  from_type   ENUM('external_record','meeting','action_item','user') NOT NULL,
  from_id     BIGINT UNSIGNED NOT NULL,
  to_type     ENUM('external_record','meeting','action_item','user') NOT NULL,
  to_id       BIGINT UNSIGNED NOT NULL,
  link_type   ENUM('references','implements','fixes','duplicates','same_as','blocks','depends_on','discussed_in','related') NOT NULL,
  -- source = stated by the provider; rule/ai = inferred (Phase 5/6); manual = added by a person.
  origin      ENUM('source','rule','ai','manual') NOT NULL,
  status      ENUM('suggested','confirmed','rejected') NOT NULL,
  confidence  DECIMAL(4,3) NULL,
  evidence    JSON NULL,
  created_by  BIGINT UNSIGNED NULL,
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_link (from_type, from_id, to_type, to_id, link_type),
  KEY idx_link_to (to_type, to_id),
  CONSTRAINT chk_link_not_self CHECK (NOT (from_type = to_type AND from_id = to_id)),
  CONSTRAINT chk_link_confidence CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT fk_link_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_link_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
