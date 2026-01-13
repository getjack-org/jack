-- Migration: Add source snapshot and visibility columns for custom templates
-- source_snapshot_key: R2 key for latest source.zip
-- visibility: 'private' (default), 'public' (published for forking)
-- forked_from: lineage tracking (e.g., "alice/my-api")
-- owner_username: for URL construction ({username}-{slug}.runjack.xyz)

ALTER TABLE projects ADD COLUMN source_snapshot_key TEXT;
ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE projects ADD COLUMN forked_from TEXT;
ALTER TABLE projects ADD COLUMN owner_username TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_visibility ON projects(visibility);
CREATE INDEX IF NOT EXISTS idx_projects_forked_from ON projects(forked_from);
CREATE INDEX IF NOT EXISTS idx_projects_owner_username ON projects(owner_username);
