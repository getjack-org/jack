-- Guestbook schema
-- Applied automatically by jack on first deploy

CREATE TABLE IF NOT EXISTS guestbook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fid INTEGER NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  pfp_url TEXT,
  message TEXT NOT NULL CHECK(length(message) <= 140),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_guestbook_created_at ON guestbook(created_at DESC);
