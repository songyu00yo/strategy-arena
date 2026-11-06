CREATE TABLE IF NOT EXISTS decision_reviews (
  id TEXT PRIMARY KEY,
  arena_id TEXT NOT NULL REFERENCES arenas(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','completed','failed','uncertain')),
  body TEXT NOT NULL,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_review_version ON decision_reviews(version_id, created_at);
CREATE INDEX IF NOT EXISTS decision_review_input ON decision_reviews(version_id, input_hash, configuration_hash, created_at);
