-- Recovery only. Keep managed public and owner routes closed until all checks pass.
UPDATE access_enrollments
SET expires_at = 0, code_hash = NULL, pending_hash = NULL
WHERE status IN ('pending', 'approved')
  AND (expires_at <> 0 OR code_hash IS NOT NULL OR pending_hash IS NOT NULL);

UPDATE access_displays
SET revoked_at = unixepoch()
WHERE revoked_at IS NULL;

DELETE FROM access_display_sessions;
