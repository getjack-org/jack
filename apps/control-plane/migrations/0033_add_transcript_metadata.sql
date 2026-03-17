-- Migration: Add transcript metadata columns to deployments
-- Description: Store provider/schema/counts/timestamps and raw transcript presence.

ALTER TABLE deployments ADD COLUMN transcript_provider TEXT;
ALTER TABLE deployments ADD COLUMN transcript_schema_version TEXT;
ALTER TABLE deployments ADD COLUMN transcript_turn_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_user_turn_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_assistant_turn_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_first_turn_at TEXT;
ALTER TABLE deployments ADD COLUMN transcript_last_turn_at TEXT;
ALTER TABLE deployments ADD COLUMN has_raw_session_transcript INTEGER DEFAULT 0;
