-- Migration: Add transcript provider session identity to deployments
-- Description: Store additive provider session identifiers for deployment transcript debugging.

ALTER TABLE deployments ADD COLUMN transcript_provider_session_id TEXT;
