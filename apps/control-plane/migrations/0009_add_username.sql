-- Migration: Add username column to users table
-- Username rules: lowercase alphanumeric + hyphens, 3-39 chars, must start/end with alphanumeric

-- SQLite can't add UNIQUE column directly, so add column then create unique index
ALTER TABLE users ADD COLUMN username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
