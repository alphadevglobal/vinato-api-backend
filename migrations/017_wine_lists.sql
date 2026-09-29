-- Local mirror of vinato-web migration 0013 ("Verificação de carta": restaurants,
-- wine lists, their files, transcribed items, bottle checks and the wine list AI
-- model), which applies it in production.
CREATE TABLE IF NOT EXISTS restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  name_key text NOT NULL,
  city text,
  address text,
  latitude numeric CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90),
  longitude numeric CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS restaurants_name_city_idx ON restaurants (name_key, (coalesce(lower(btrim(city)), '')));

CREATE TABLE IF NOT EXISTS wine_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE SET NULL,
  user_id uuid,
  restaurant_name text,
  city text,
  address text,
  latitude numeric,
  longitude numeric,
  source text NOT NULL CHECK (source IN ('photo', 'pdf')),
  status text NOT NULL DEFAULT 'transcribed' CHECK (status IN ('transcribed', 'failed')),
  curation_status text NOT NULL DEFAULT 'pending' CHECK (curation_status IN ('pending', 'approved', 'rejected')),
  model text,
  models_tried jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb,
  error_message text,
  duration_ms integer,
  item_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid
);

CREATE INDEX IF NOT EXISTS wine_lists_restaurant_idx ON wine_lists (restaurant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wine_lists_created_idx ON wine_lists (created_at DESC);

CREATE TABLE IF NOT EXISTS wine_list_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_list_id uuid NOT NULL REFERENCES wine_lists(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  mime text NOT NULL,
  file_data_url text NOT NULL,
  file_bytes bigint GENERATED ALWAYS AS (vinato_image_ref_bytes(file_data_url)) STORED
);

CREATE INDEX IF NOT EXISTS wine_list_files_list_idx ON wine_list_files (wine_list_id, position);

CREATE TABLE IF NOT EXISTS wine_list_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_list_id uuid NOT NULL REFERENCES wine_lists(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  section text,
  name text NOT NULL,
  producer text,
  vintage smallint,
  country text,
  region text,
  grapes text,
  style text,
  volume text,
  price numeric,
  glass_price numeric,
  currency text NOT NULL DEFAULT 'BRL',
  notes text,
  catalog_wine_id uuid REFERENCES catalog_wines(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS wine_list_items_list_idx ON wine_list_items (wine_list_id, position);

CREATE TABLE IF NOT EXISTS wine_list_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_list_id uuid NOT NULL REFERENCES wine_lists(id) ON DELETE CASCADE,
  item_id uuid REFERENCES wine_list_items(id) ON DELETE CASCADE,
  user_id uuid,
  image_data_url text,
  verdict text CHECK (verdict IN ('match', 'mismatch', 'uncertain')),
  confidence numeric,
  observed jsonb,
  differences jsonb NOT NULL DEFAULT '[]'::jsonb,
  explanation text,
  model text,
  models_tried jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb,
  error_message text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wine_list_checks_list_idx ON wine_list_checks (wine_list_id, created_at DESC);

CREATE INDEX IF NOT EXISTS wine_list_checks_created_idx ON wine_list_checks (created_at DESC);

-- AI model for wine lists (transcription and bottle check), chosen in the admin logs.
CREATE TABLE IF NOT EXISTS wine_list_agent_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model text NOT NULL DEFAULT 'google/gemini-3.8-flash',
  fallback_model text NOT NULL DEFAULT 'google/gemini-3.1-flash-lite',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

INSERT INTO wine_list_agent_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
