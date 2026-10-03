-- In-app conversations: a feedback becomes a thread the user can follow from inside the
-- app, and that the console answers into rather than only by email.

-- Who sent the feedback, as far as the server can tell: the hex SHA-256 of a random token
-- the SDK keeps in the device Keychain (the `X-Rater-Reporter` header). NULL for feedback
-- from clients that predate conversations — those threads can only be answered by email.
ALTER TABLE feedback ADD COLUMN reporter_hash TEXT;
-- Bumped by every message in either direction. Rows written before this column existed —
-- or by the previous deploy in the window before this code goes live — are NULL, so
-- readers fall back to created_at.
ALTER TABLE feedback ADD COLUMN last_message_at INTEGER;
-- Read markers: the highest feedback_messages.seq each side has seen. A message is unread
-- for the user when an admin wrote it past user_read_seq, and the other way round.
ALTER TABLE feedback ADD COLUMN user_read_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feedback ADD COLUMN admin_read_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_feedback_reporter ON feedback(app_id, reporter_hash, created_at DESC);

-- Every message after the feedback itself, from either side.
--
-- `seq` is the polling cursor. AUTOINCREMENT, not a plain rowid alias, so a seq is never
-- handed out twice even after rows are deleted — a client holding `after=<seq>` must not
-- skip a message that reused a number it already passed.
CREATE TABLE feedback_messages (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  feedback_id       TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  author            TEXT NOT NULL,   -- user | admin
  body              TEXT NOT NULL,
  -- Client-chosen, so a resend from the SDK's retry queue lands once. User messages only.
  idempotency_key   TEXT,
  -- Set when an admin message was also emailed: the recipient, subject, and Resend's id.
  email_to          TEXT,
  email_subject     TEXT,
  email_provider_id TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_feedback_messages_thread ON feedback_messages(feedback_id, seq);
-- NULLs are distinct in a SQLite unique index, so admin rows (no key) never collide.
CREATE UNIQUE INDEX idx_feedback_messages_idempotency
  ON feedback_messages(feedback_id, idempotency_key);

-- Email replies sent so far become the opening admin messages of their threads, so the
-- console shows one timeline. feedback_replies itself stays until a later migration drops
-- it: the previous deploy still writes there until this code replaces it.
INSERT INTO feedback_messages
  (id, feedback_id, author, body, email_to, email_subject, email_provider_id, created_at)
SELECT id, feedback_id, 'admin', body, to_email, subject, provider_id, sent_at
  FROM feedback_replies
 ORDER BY sent_at;

UPDATE feedback
   SET last_message_at = COALESCE(
         (SELECT MAX(m.created_at) FROM feedback_messages m WHERE m.feedback_id = feedback.id),
         created_at),
       admin_read_seq = COALESCE(
         (SELECT MAX(m.seq) FROM feedback_messages m WHERE m.feedback_id = feedback.id),
         0);
