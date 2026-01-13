-- Enforce that slugs and usernames cannot start or end with hyphens.
-- This ensures unambiguous URL parsing: alice-my-api.runjack.xyz
-- can only be parsed as username="alice" + slug="my-api"

-- Trigger for projects.slug on INSERT
CREATE TRIGGER IF NOT EXISTS trg_projects_slug_boundary_insert
BEFORE INSERT ON projects
WHEN NEW.slug GLOB '-*' OR NEW.slug GLOB '*-'
BEGIN
  SELECT RAISE(ABORT, 'Slug cannot start or end with a hyphen');
END;

-- Trigger for projects.slug on UPDATE
CREATE TRIGGER IF NOT EXISTS trg_projects_slug_boundary_update
BEFORE UPDATE OF slug ON projects
WHEN NEW.slug GLOB '-*' OR NEW.slug GLOB '*-'
BEGIN
  SELECT RAISE(ABORT, 'Slug cannot start or end with a hyphen');
END;

-- Trigger for users.username on INSERT (allow NULL)
CREATE TRIGGER IF NOT EXISTS trg_users_username_boundary_insert
BEFORE INSERT ON users
WHEN NEW.username IS NOT NULL AND (NEW.username GLOB '-*' OR NEW.username GLOB '*-')
BEGIN
  SELECT RAISE(ABORT, 'Username cannot start or end with a hyphen');
END;

-- Trigger for users.username on UPDATE (allow NULL)
CREATE TRIGGER IF NOT EXISTS trg_users_username_boundary_update
BEFORE UPDATE OF username ON users
WHEN NEW.username IS NOT NULL AND (NEW.username GLOB '-*' OR NEW.username GLOB '*-')
BEGIN
  SELECT RAISE(ABORT, 'Username cannot start or end with a hyphen');
END;
