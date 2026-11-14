CREATE TABLE IF NOT EXISTS owner_credentials (
  owner TEXT PRIMARY KEY,
  recovery_hash TEXT UNIQUE,
  pending_recovery_hash TEXT UNIQUE,
  pending_created_at INTEGER,
  auth_generation INTEGER NOT NULL DEFAULT 0 CHECK (auth_generation >= 0),
  allow_legacy_cookie INTEGER NOT NULL DEFAULT 0 CHECK (allow_legacy_cookie IN (0, 1)),
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);
CREATE TABLE IF NOT EXISTS identity_recovery_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS identity_attempt_time ON identity_recovery_attempts(created_at);
CREATE INDEX IF NOT EXISTS arenas_owner_created ON arenas(owner, created_at DESC, id DESC);
