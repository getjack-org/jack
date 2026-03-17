-- Migration: Add transcript event-level metadata columns to deployments
-- Description: Store canonical event counters for transcript rendering and diff summaries.

ALTER TABLE deployments ADD COLUMN transcript_event_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_message_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_tool_call_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_tool_result_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_reasoning_count INTEGER DEFAULT 0;
ALTER TABLE deployments ADD COLUMN transcript_other_event_count INTEGER DEFAULT 0;
