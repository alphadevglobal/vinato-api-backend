ALTER TABLE catalog_wines
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'lwin',
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS vintage_year integer,
  ADD COLUMN IF NOT EXISTS alcohol numeric(5,2),
  ADD COLUMN IF NOT EXISTS price_usd numeric(12,2),
  ADD COLUMN IF NOT EXISTS rating numeric(3,2),
  ADD COLUMN IF NOT EXISTS grapes text,
  ADD COLUMN IF NOT EXISTS image_path text,
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS source_url text,
  ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS catalog_wines_source_source_id_idx
  ON catalog_wines (source, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_wines_rating_idx ON catalog_wines (rating DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS winesensed_observations (
  id text PRIMARY KEY,
  vintage_id text NOT NULL,
  image_path text,
  review text,
  experiment_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS winesensed_observations_vintage_idx
  ON winesensed_observations (vintage_id);

COMMENT ON TABLE winesensed_observations IS
  'WineSensed test data (CC BY-NC-ND 4.0); not approved for commercial production use.';
