CREATE TABLE IF NOT EXISTS google_photo_connections (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  refresh_token_ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
