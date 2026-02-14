CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT 'Default',
  status_code INTEGER,
  latency_ms INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'cron',
  error TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_checks_group_created ON checks(group_name, created_at);
CREATE INDEX IF NOT EXISTS idx_checks_created ON checks(created_at);
