-- Add Durable Objects support columns and tables

-- Track applied migration tag per project for DO deployments
ALTER TABLE projects ADD COLUMN do_migration_tag TEXT;

-- Usage tracking table for DO metering (populated by 15-min cron from Analytics Engine)
CREATE TABLE IF NOT EXISTS do_usage (
  project_id TEXT NOT NULL,
  window TEXT NOT NULL,
  requests INTEGER DEFAULT 0,
  wall_time_ms INTEGER DEFAULT 0,
  alarm_time_ms INTEGER DEFAULT 0,
  enforced INTEGER DEFAULT 0,
  PRIMARY KEY (project_id, window)
);
