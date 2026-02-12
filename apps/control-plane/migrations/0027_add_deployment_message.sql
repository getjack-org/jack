-- Migration: Add message column to deployments
-- Description: Allow deploy messages (human or AI-generated) to be stored with each deployment

ALTER TABLE deployments ADD COLUMN message TEXT;
