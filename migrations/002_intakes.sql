CREATE TABLE IF NOT EXISTS intake_drafts (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  submitted_arena_id TEXT
);
CREATE INDEX IF NOT EXISTS intake_owner ON intake_drafts(owner, updated_at);
CREATE TABLE IF NOT EXISTS intake_attachments (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES intake_drafts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  bytes BLOB NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intake_operations (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES intake_drafts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS intake_calls (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES intake_operations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  usage TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
