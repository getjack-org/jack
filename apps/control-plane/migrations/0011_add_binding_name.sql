-- Add binding_name column to track which binding a resource is for
-- This enables multiple resources of the same type (e.g., multiple R2 buckets)
ALTER TABLE resources ADD COLUMN binding_name TEXT;

-- Index for looking up resources by binding
CREATE INDEX IF NOT EXISTS idx_resources_binding
ON resources(project_id, resource_type, binding_name);
