-- Add cron_secret column to projects for HMAC signing of cron requests
ALTER TABLE projects ADD COLUMN cron_secret TEXT;
