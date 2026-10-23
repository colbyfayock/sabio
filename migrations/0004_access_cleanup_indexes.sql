-- Support bounded expiry cleanup without a full table scan.
-- access_display_sessions and access_rate_limits already index expires_at.
CREATE INDEX IF NOT EXISTS access_displays_expiry
  ON access_displays (expires_at);

CREATE INDEX IF NOT EXISTS access_enrollments_expiry
  ON access_enrollments (expires_at);
