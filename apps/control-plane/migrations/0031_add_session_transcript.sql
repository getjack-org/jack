-- Migration: Add session transcript support to deployments
-- Description: Store Claude Code session transcript captured at deploy time

ALTER TABLE deployments ADD COLUMN has_session_transcript INTEGER DEFAULT 0;
