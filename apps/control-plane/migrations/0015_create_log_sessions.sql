-- Log tailing sessions (1-hour debug windows)
-- Used to control Tail Worker attachment duration and enable SSE streaming.

CREATE TABLE IF NOT EXISTS log_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | expired | revoked
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (org_id) REFERENCES orgs(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- One active session per project at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_log_sessions_project_active
ON log_sessions(project_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_log_sessions_project_id ON log_sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_log_sessions_org_id ON log_sessions(org_id);
CREATE INDEX IF NOT EXISTS idx_log_sessions_status ON log_sessions(status);
CREATE INDEX IF NOT EXISTS idx_log_sessions_expires_at ON log_sessions(expires_at);

-- Trigger to update updated_at on row changes
CREATE TRIGGER IF NOT EXISTS log_sessions_updated_at
  AFTER UPDATE ON log_sessions
  FOR EACH ROW
BEGIN
  UPDATE log_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = OLD.id;
END;

