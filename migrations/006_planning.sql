CREATE TABLE IF NOT EXISTS planning_sessions (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  body TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS planning_owner ON planning_sessions(owner, updated_at DESC);
CREATE TABLE IF NOT EXISTS planning_operations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES planning_sessions(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  role TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS planning_one_pending ON planning_operations(session_id) WHERE state='pending';
CREATE TABLE IF NOT EXISTS planning_calls (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES planning_operations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  reservation TEXT NOT NULL,
  usage TEXT,
  output TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
