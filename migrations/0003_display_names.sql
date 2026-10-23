ALTER TABLE access_displays ADD COLUMN display_name TEXT
  CHECK (display_name IS NULL OR length(display_name) <= 80);
