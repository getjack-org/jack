-- Migration: Add deleted_at for soft-delete support
ALTER TABLE projects ADD COLUMN deleted_at DATETIME DEFAULT NULL;
CREATE INDEX IF NOT EXISTS idx_projects_deleted_at ON projects(deleted_at);
