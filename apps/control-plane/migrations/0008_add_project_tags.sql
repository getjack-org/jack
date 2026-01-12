-- Migration: Add tags column to projects table
ALTER TABLE projects ADD COLUMN tags TEXT DEFAULT '[]';
