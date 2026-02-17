-- Ask Project latest-deploy index (V1)
-- Latest snapshot only per project for fast/cheap retrieval.

CREATE TABLE IF NOT EXISTS ask_code_index_latest (
  project_id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'indexing', -- indexing | ready | failed
  file_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  last_duration_ms INTEGER NOT NULL DEFAULT 0,
  queue_attempts INTEGER NOT NULL DEFAULT 1,
  error_message TEXT
);

-- Immutable run records for per-deploy indexing observability.
CREATE TABLE IF NOT EXISTS ask_code_index_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL, -- ready | failed
  queue_attempts INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ask_code_index_runs_project_created
ON ask_code_index_runs(project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ask_code_index_runs_deployment
ON ask_code_index_runs(deployment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ask_code_files_latest (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  language TEXT,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  PRIMARY KEY (project_id, path)
);

CREATE INDEX IF NOT EXISTS idx_ask_code_files_latest_project
ON ask_code_files_latest(project_id);

CREATE TABLE IF NOT EXISTS ask_code_symbols_latest (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  signature TEXT,
  PRIMARY KEY (project_id, path, symbol, kind, line_start)
);

CREATE INDEX IF NOT EXISTS idx_ask_code_symbols_latest_project_kind
ON ask_code_symbols_latest(project_id, kind);

CREATE TABLE IF NOT EXISTS ask_code_chunks_latest (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  content TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ask_code_chunks_latest_project
ON ask_code_chunks_latest(project_id);

-- FTS table for lexical retrieval. Keep project_id/path/chunk metadata as unindexed columns.
CREATE VIRTUAL TABLE IF NOT EXISTS ask_code_chunks_latest_fts USING fts5(
  project_id UNINDEXED,
  path UNINDEXED,
  chunk_index UNINDEXED,
  line_start UNINDEXED,
  line_end UNINDEXED,
  content
);
