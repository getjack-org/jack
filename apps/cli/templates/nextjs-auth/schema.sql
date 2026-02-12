CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0,
  image TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  expiresAt INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshTokenExpiresAt INTEGER,
  scope TEXT,
  password TEXT,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL DEFAULT (unixepoch()),
  updatedAt INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);
CREATE INDEX IF NOT EXISTS idx_session_userId ON session(userId);
CREATE INDEX IF NOT EXISTS idx_account_userId ON account(userId);
