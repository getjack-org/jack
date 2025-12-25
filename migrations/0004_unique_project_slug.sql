-- Enforce globally unique slugs for routing at {slug}.runjack.xyz
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug_unique ON projects(slug);
