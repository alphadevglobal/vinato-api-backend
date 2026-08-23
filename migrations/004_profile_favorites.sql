ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS avatar_url text;

CREATE TABLE IF NOT EXISTS user_favorites (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  wine_id uuid NOT NULL REFERENCES catalog_wines(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, wine_id)
);

CREATE INDEX IF NOT EXISTS user_favorites_user_idx
  ON user_favorites (user_id, created_at DESC);
