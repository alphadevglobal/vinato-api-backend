CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'editor', 'owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX IF NOT EXISTS user_sessions_expiry_idx ON user_sessions (expires_at);

CREATE TABLE IF NOT EXISTS user_cellars (
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  wine_id uuid NOT NULL REFERENCES catalog_wines(id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  added_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, wine_id)
);
CREATE INDEX IF NOT EXISTS user_cellars_user_idx ON user_cellars (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS user_scan_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  wine_id uuid REFERENCES catalog_wines(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('success', 'error')),
  image_uri text,
  result jsonb,
  scanned_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_scan_history_user_idx ON user_scan_history (user_id, scanned_at DESC);

CREATE TABLE IF NOT EXISTS news_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  summary text NOT NULL,
  image_url text,
  link_url text,
  published boolean NOT NULL DEFAULT false,
  published_at timestamptz,
  author_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_posts_published_idx ON news_posts (published, published_at DESC);

INSERT INTO news_posts (title, summary, published, published_at)
SELECT
  'O VINATO está evoluindo',
  'Acompanhe novidades do aplicativo, novos recursos e conteúdos selecionados para escolher vinhos com mais confiança.',
  true,
  now()
WHERE NOT EXISTS (SELECT 1 FROM news_posts);
