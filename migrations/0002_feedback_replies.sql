-- Email replies sent to a user from the admin console.
--
-- One row per successful send. A failed send is reported to the console instead of being
-- stored: a row here means the provider accepted the message, so the list doubles as the
-- record of what the user actually received.
CREATE TABLE feedback_replies (
  id           TEXT PRIMARY KEY,
  feedback_id  TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  to_email     TEXT NOT NULL,
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  provider     TEXT NOT NULL DEFAULT 'resend',
  -- The provider's own message id, so a bounce report can be traced back to this row.
  provider_id  TEXT,
  sent_at      INTEGER NOT NULL
);
CREATE INDEX idx_feedback_replies_feedback ON feedback_replies(feedback_id, sent_at);
