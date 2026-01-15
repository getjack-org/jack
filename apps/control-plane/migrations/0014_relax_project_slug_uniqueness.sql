-- Migration: Allow reusing project slugs after delete (within an org)
-- Rebuild projects table to drop UNIQUE(org_id, slug) constraint

PRAGMA foreign_keys=OFF;

CREATE TABLE projects_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisioning',
  code_bucket_prefix TEXT NOT NULL,
  content_bucket_enabled INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME DEFAULT NULL,
  tags TEXT DEFAULT '[]',
  source_snapshot_key TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  forked_from TEXT,
  owner_username TEXT,
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

INSERT INTO projects_new (
  id,
  org_id,
  name,
  slug,
  status,
  code_bucket_prefix,
  content_bucket_enabled,
  created_at,
  updated_at,
  deleted_at,
  tags,
  source_snapshot_key,
  visibility,
  forked_from,
  owner_username
)
SELECT
  id,
  org_id,
  name,
  slug,
  status,
  code_bucket_prefix,
  content_bucket_enabled,
  created_at,
  updated_at,
  deleted_at,
  tags,
  source_snapshot_key,
  visibility,
  forked_from,
  owner_username
FROM projects;

DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;

PRAGMA foreign_keys=ON;

CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);
CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
CREATE INDEX IF NOT EXISTS idx_projects_visibility ON projects(visibility);
CREATE INDEX IF NOT EXISTS idx_projects_forked_from ON projects(forked_from);
CREATE INDEX IF NOT EXISTS idx_projects_owner_username ON projects(owner_username);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_org_slug_active
ON projects(org_id, slug)
WHERE status != 'deleted';

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_slug
ON projects(owner_username, slug)
WHERE status != 'deleted' AND owner_username IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS trg_projects_slug_boundary_insert
BEFORE INSERT ON projects
WHEN NEW.slug GLOB '-*' OR NEW.slug GLOB '*-'
BEGIN
  SELECT RAISE(ABORT, 'Slug cannot start or end with a hyphen');
END;

CREATE TRIGGER IF NOT EXISTS trg_projects_slug_boundary_update
BEFORE UPDATE OF slug ON projects
WHEN NEW.slug GLOB '-*' OR NEW.slug GLOB '*-'
BEGIN
  SELECT RAISE(ABORT, 'Slug cannot start or end with a hyphen');
END;
