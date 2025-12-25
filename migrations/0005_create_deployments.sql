-- Migration: Create deployments table
-- Description: Track deployment lifecycle for projects

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'building', 'live', 'failed')),
  source TEXT NOT NULL,
  artifact_bucket_key TEXT,
  worker_version_id TEXT,
  error_message TEXT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Index for listing deployments by project
CREATE INDEX IF NOT EXISTS idx_deployments_project_id ON deployments(project_id);

-- Index for querying by status (useful for background workers)
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
