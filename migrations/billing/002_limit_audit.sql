CREATE TABLE IF NOT EXISTS billing_limit_audit (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  changed_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  stage_id TEXT NOT NULL UNIQUE,
  previous_usd_limit_micros INTEGER NOT NULL,
  previous_request_limit INTEGER NOT NULL,
  previous_token_limit INTEGER NOT NULL,
  usd_limit_micros INTEGER NOT NULL,
  request_limit INTEGER NOT NULL,
  token_limit INTEGER NOT NULL,
  baseline_rowid INTEGER NOT NULL,
  baseline_json TEXT NOT NULL,
  stage_usd_limit_micros INTEGER NOT NULL CHECK(stage_usd_limit_micros > 0 AND stage_usd_limit_micros <= 10000000),
  stage_request_limit INTEGER NOT NULL CHECK(stage_request_limit > 0 AND stage_request_limit <= 300),
  stage_token_limit INTEGER NOT NULL CHECK(stage_token_limit > 0 AND stage_token_limit <= 5000000)
);
CREATE TRIGGER IF NOT EXISTS billing_audit_no_update BEFORE UPDATE ON billing_limit_audit
BEGIN SELECT RAISE(ABORT, 'Billing audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_audit_no_delete BEFORE DELETE ON billing_limit_audit
BEGIN SELECT RAISE(ABORT, 'Billing audit is immutable'); END;
