CREATE TABLE IF NOT EXISTS access_enrollments (
  id TEXT PRIMARY KEY NOT NULL,
  display_id TEXT NOT NULL UNIQUE,
  pending_hash TEXT UNIQUE,
  code_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'consumed')),
  approved_at INTEGER,
  approval_claim TEXT UNIQUE,
  consumed_at INTEGER,
  consume_claim TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS access_enrollments_status_expiry
  ON access_enrollments (status, expires_at);

CREATE TABLE IF NOT EXISTS access_displays (
  id TEXT PRIMARY KEY NOT NULL,
  enrollment_id TEXT NOT NULL UNIQUE REFERENCES access_enrollments (id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS access_displays_created
  ON access_displays (created_at DESC);

CREATE TABLE IF NOT EXISTS access_display_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  display_id TEXT NOT NULL UNIQUE REFERENCES access_displays (id),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS access_display_sessions_expiry
  ON access_display_sessions (expires_at);

CREATE TABLE IF NOT EXISTS access_rate_limits (
  bucket_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX IF NOT EXISTS access_rate_limits_expiry
  ON access_rate_limits (expires_at);
