-- Create cron_schedules table for managing scheduled tasks
CREATE TABLE cron_schedules (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expression TEXT NOT NULL,
  expression_normalized TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  is_running INTEGER DEFAULT 0,
  run_started_at TEXT,
  last_run_at TEXT,
  next_run_at TEXT NOT NULL,
  last_run_status TEXT,
  last_run_duration_ms INTEGER,
  consecutive_failures INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(project_id, expression_normalized)
);

-- Index for efficient cron polling (runs every minute)
CREATE INDEX idx_cron_due ON cron_schedules(next_run_at) WHERE enabled = 1;

-- Index for project lookups
CREATE INDEX idx_cron_project ON cron_schedules(project_id);
