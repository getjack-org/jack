CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  from_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  resend_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);
CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log(to_address);
