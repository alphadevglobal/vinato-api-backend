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
