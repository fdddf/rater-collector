-- Rater feedback collection — initial schema

-- Onboarded apps. api_key_hash holds a hex SHA-256; the plaintext key is returned only
-- once, at registration.
CREATE TABLE apps (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  app_store_id  TEXT,
  api_key_hash  TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_apps_api_key_hash ON apps(api_key_hash);

-- Server-side copy for the pre-prompt. The best-matching row is chosen by
-- (app_id, locale, min_app_version). locale = '*' is the catch-all; min_app_version is
-- the lowest app version the row applies to.
CREATE TABLE prompt_configs (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  locale            TEXT NOT NULL DEFAULT '*',
  min_app_version   TEXT NOT NULL DEFAULT '0',
  enabled           INTEGER NOT NULL DEFAULT 1,
  variant           TEXT NOT NULL DEFAULT 'default',
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  positive_label    TEXT NOT NULL,
  negative_label    TEXT NOT NULL,
  later_label       TEXT NOT NULL,
  feedback_title    TEXT,
  feedback_message  TEXT,
  categories_json   TEXT NOT NULL DEFAULT '[]',
  email_required    INTEGER NOT NULL DEFAULT 0,
  rules_json        TEXT,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_prompt_configs_key
  ON prompt_configs(app_id, locale, min_app_version);

-- A single piece of user feedback.
CREATE TABLE feedback (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | open | resolved | spam
  category          TEXT,
  message           TEXT NOT NULL,
  email             TEXT,
  app_version       TEXT,
  build             TEXT,
  bundle_id         TEXT,
  os_version        TEXT,
  device_model      TEXT,
  locale            TEXT,
  region            TEXT,
  timezone          TEXT,
  install_days      INTEGER,
  launch_count      INTEGER,
  metadata_json     TEXT,
  ip_country        TEXT,
  idempotency_key   TEXT NOT NULL,
  attachment_count  INTEGER NOT NULL DEFAULT 0,
  admin_note        TEXT
);
CREATE UNIQUE INDEX idx_feedback_idempotency ON feedback(app_id, idempotency_key);
CREATE INDEX idx_feedback_app_created ON feedback(app_id, created_at DESC);
CREATE INDEX idx_feedback_status ON feedback(status, created_at DESC);

-- Screenshots attached to a feedback. The bytes themselves live in R2.
CREATE TABLE attachments (
  id            TEXT PRIMARY KEY,
  feedback_id   TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  r2_key        TEXT NOT NULL,
  content_type  TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_attachments_feedback_idx ON attachments(feedback_id, idx);

-- Telemetry: prompt shown / positive / negative / dismissed / submitted, used for the
-- conversion funnel.
CREATE TABLE telemetry (
  id           TEXT PRIMARY KEY,
  app_id       TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  kind         TEXT NOT NULL,   -- shown | positive | negative | dismissed | submitted
  app_version  TEXT,
  variant      TEXT,
  locale       TEXT
);
CREATE INDEX idx_telemetry_app_created ON telemetry(app_id, created_at DESC);
CREATE INDEX idx_telemetry_kind ON telemetry(app_id, kind, created_at DESC);
