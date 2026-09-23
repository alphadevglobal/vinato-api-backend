CREATE TABLE IF NOT EXISTS unlisted_wine_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  unlisted_code text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'needs_registration' CHECK (status IN ('needs_registration', 'reviewing', 'registered', 'rejected')),
  image_data_url text NOT NULL,
  extracted_data jsonb NOT NULL,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  registered_wine_id uuid REFERENCES catalog_wines(id) ON DELETE SET NULL,
  admin_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
CREATE INDEX IF NOT EXISTS unlisted_wine_scans_status_idx ON unlisted_wine_scans (status, created_at DESC);
CREATE INDEX IF NOT EXISTS unlisted_wine_scans_user_idx ON unlisted_wine_scans (user_id, created_at DESC);

