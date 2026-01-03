-- Feedback table for user submissions
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  email TEXT,
  jack_version TEXT,
  os TEXT,
  project_name TEXT,
  deploy_mode TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for chronological queries
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);

-- Index for filtering by email (find all feedback from a user)
CREATE INDEX IF NOT EXISTS idx_feedback_email ON feedback(email);
