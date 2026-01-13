-- Migration: Change slug uniqueness from global to per-user
-- This enables multiple users to have projects with the same slug

-- Drop the global slug unique index
DROP INDEX IF EXISTS idx_projects_slug_unique;

-- Create per-owner slug uniqueness (only for projects with owner_username set)
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_owner_slug
ON projects(owner_username, slug)
WHERE status != 'deleted' AND owner_username IS NOT NULL;
