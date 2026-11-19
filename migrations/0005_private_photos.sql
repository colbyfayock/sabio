CREATE TABLE IF NOT EXISTS photo_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS photo_oauth_states_expiry
  ON photo_oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS photo_imports (
  id TEXT PRIMARY KEY NOT NULL,
  google_session_ciphertext TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  picker_uri_ciphertext TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('picking', 'importing')),
  locked_until INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS photo_imports_one_active
  ON photo_imports ((1));

CREATE INDEX IF NOT EXISTS photo_imports_expiry
  ON photo_imports (expires_at);

CREATE TABLE IF NOT EXISTS photo_items (
  id TEXT PRIMARY KEY NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  source_hash TEXT NOT NULL UNIQUE,
  import_id TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS photo_items_position
  ON photo_items (position, created_at);
