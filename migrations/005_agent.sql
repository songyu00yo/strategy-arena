CREATE TABLE IF NOT EXISTS agent_actions (
  step_id TEXT PRIMARY KEY REFERENCES steps(id),
  version_id TEXT NOT NULL REFERENCES versions(id),
  kind TEXT NOT NULL,
  role TEXT NOT NULL,
  round INTEGER NOT NULL,
  dependencies TEXT NOT NULL,
  payload TEXT NOT NULL,
  input_body TEXT,
  input_hash TEXT
);
CREATE INDEX IF NOT EXISTS agent_actions_version ON agent_actions(version_id);
CREATE TABLE IF NOT EXISTS version_corpora (
  version_id TEXT PRIMARY KEY REFERENCES versions(id), body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS model_drafts (
  step_id TEXT PRIMARY KEY REFERENCES steps(id),
  version_id TEXT NOT NULL REFERENCES versions(id), body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS model_drafts_version ON model_drafts(version_id);
