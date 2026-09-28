-- Identical photos (same md5 of the data URL) reuse the existing unlisted scan
-- instead of storing the image again. Mirrors vinato-web migrations 0008/0009,
-- which apply it in production.
ALTER TABLE unlisted_wine_scans ADD COLUMN IF NOT EXISTS image_md5 text GENERATED ALWAYS AS (md5(image_data_url)) STORED;
ALTER TABLE unlisted_wine_scans ADD COLUMN IF NOT EXISTS resubmissions integer NOT NULL DEFAULT 0;
ALTER TABLE unlisted_wine_scans ADD COLUMN IF NOT EXISTS last_submitted_at timestamptz;
CREATE INDEX IF NOT EXISTS unlisted_wine_scans_image_md5_idx ON unlisted_wine_scans (image_md5, created_at DESC);
