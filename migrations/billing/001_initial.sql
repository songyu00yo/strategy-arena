CREATE TABLE IF NOT EXISTS billing_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  usd_limit_micros INTEGER NOT NULL CHECK (usd_limit_micros > 0 AND usd_limit_micros <= 120000000),
  request_limit INTEGER NOT NULL CHECK (request_limit > 0),
  token_limit INTEGER NOT NULL CHECK (token_limit > 0),
  hard_total_usd_micros INTEGER NOT NULL CHECK (hard_total_usd_micros = 200000000),
  cny_per_usd INTEGER NOT NULL CHECK (cny_per_usd = 6),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_attempts (
  attempt_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('CNY', 'USD')),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'held', 'settled')),
  estimated_amount_micros INTEGER NOT NULL CHECK (estimated_amount_micros >= 0),
  reserved_usd_micros INTEGER NOT NULL CHECK (reserved_usd_micros >= 0),
  max_tokens INTEGER NOT NULL CHECK (max_tokens > 0),
  amount_micros INTEGER CHECK (amount_micros >= 0),
  settled_usd_micros INTEGER CHECK (settled_usd_micros >= 0),
  input_tokens INTEGER CHECK (input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens >= 0),
  cached_input_tokens INTEGER CHECK (cached_input_tokens >= 0),
  response_id TEXT,
  created_at TEXT NOT NULL,
  settled_at TEXT,
  CHECK ((state = 'settled' AND amount_micros IS NOT NULL AND settled_usd_micros IS NOT NULL
          AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL
          AND cached_input_tokens <= input_tokens AND settled_at IS NOT NULL)
         OR (state IN ('reserved', 'held') AND amount_micros IS NULL AND settled_usd_micros IS NULL
          AND input_tokens IS NULL AND output_tokens IS NULL AND cached_input_tokens IS NULL
          AND response_id IS NULL AND settled_at IS NULL))
);
