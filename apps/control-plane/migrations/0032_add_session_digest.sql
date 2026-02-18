-- Migration: Add session digest column to deployments
-- Description: Store a short LLM-generated summary of the deploy session transcript

ALTER TABLE deployments ADD COLUMN session_digest TEXT;
