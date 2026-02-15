-- Replace do_usage (stale AE snapshots) with do_enforcement (enforcement state only).
-- Usage data is served directly from Analytics Engine; D1 only tracks enforcement flags.

DROP TABLE IF EXISTS do_usage;

CREATE TABLE do_enforcement (
  project_id TEXT PRIMARY KEY,
  daily_wall_time_ms INTEGER DEFAULT 0,
  daily_requests INTEGER DEFAULT 0,
  last_checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  enforced_at TEXT,
  enforced_reason TEXT,
  removed_bindings TEXT  -- JSON: store DO bindings before removal for future restoration
);
