-- Nullable additions preserve historical facts: missing metadata remains unknown.
ALTER TABLE billing_attempts ADD COLUMN service_tier TEXT;
ALTER TABLE billing_attempts ADD COLUMN model TEXT;
ALTER TABLE billing_attempts ADD COLUMN cache_write_input_tokens INTEGER
  CHECK (cache_write_input_tokens IS NULL OR
    (typeof(cache_write_input_tokens) = 'integer' AND cache_write_input_tokens >= 0));
ALTER TABLE billing_attempts ADD COLUMN cache_write_30m_input_tokens INTEGER
  CHECK (cache_write_30m_input_tokens IS NULL OR
    (typeof(cache_write_30m_input_tokens) = 'integer' AND cache_write_30m_input_tokens >= 0));
ALTER TABLE billing_attempts ADD COLUMN cache_write_12h_input_tokens INTEGER
  CHECK (cache_write_12h_input_tokens IS NULL OR
    (typeof(cache_write_12h_input_tokens) = 'integer' AND cache_write_12h_input_tokens >= 0));
