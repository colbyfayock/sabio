ALTER TABLE access_displays ADD COLUMN device_type TEXT NOT NULL DEFAULT 'unknown'
  CHECK (device_type IN ('unknown', 'desktop', 'tablet', 'phone'));
ALTER TABLE access_displays ADD COLUMN browser_label TEXT;
ALTER TABLE access_displays ADD COLUMN os_label TEXT;
ALTER TABLE access_displays ADD COLUMN last_seen_at INTEGER;
ALTER TABLE access_displays ADD COLUMN weather_location TEXT;
ALTER TABLE access_displays ADD COLUMN weather_time_zone TEXT;
ALTER TABLE access_displays ADD COLUMN weather_location_at INTEGER;
