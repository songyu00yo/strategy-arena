CREATE TABLE IF NOT EXISTS billing_usage_policy_audit (
  revision INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  changed_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  previous_enabled INTEGER NOT NULL CHECK(previous_enabled IN (0,1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  previous_policy_revision INTEGER NOT NULL,
  billing_revision INTEGER NOT NULL,
  previous_policy_json TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS billing_usage_policy_no_update BEFORE UPDATE ON billing_usage_policy_audit
BEGIN SELECT RAISE(ABORT, 'Billing usage policy audit is immutable'); END;
CREATE TRIGGER IF NOT EXISTS billing_usage_policy_no_delete BEFORE DELETE ON billing_usage_policy_audit
BEGIN SELECT RAISE(ABORT, 'Billing usage policy audit is immutable'); END;
