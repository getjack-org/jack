CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  id_prefix TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (org_id) REFERENCES orgs(id)
);

CREATE INDEX idx_api_tokens_id_prefix ON api_tokens(id_prefix)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_api_tokens_org ON api_tokens(org_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_api_tokens_user ON api_tokens(user_id)
  WHERE revoked_at IS NULL;
