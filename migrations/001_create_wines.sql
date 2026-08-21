CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS catalog_wines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_code text,
  display_name text NOT NULL,
  normalized_search text NOT NULL DEFAULT '',
  wine_name text,
  description text,
  producer_manufacturer text,
  producer_status text,
  producer_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  wine_type text,
  color text,
  country text,
  region text,
  sub_region text,
  designation text,
  classification text,
  vintage smallint,
  grapes jsonb NOT NULL DEFAULT '[]'::jsonb,
  alcohol_percent numeric,
  residual_sugar_g_l numeric,
  images jsonb NOT NULL DEFAULT '[]'::jsonb,
  pairings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_wines_scan_code_idx ON catalog_wines (scan_code) WHERE scan_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS catalog_wines_display_name_idx ON catalog_wines (display_name);
CREATE INDEX IF NOT EXISTS catalog_wines_normalized_search_trgm_idx ON catalog_wines USING gin (normalized_search gin_trgm_ops);
CREATE INDEX IF NOT EXISTS catalog_wines_country_lower_idx ON catalog_wines (lower(country));
CREATE INDEX IF NOT EXISTS catalog_wines_color_lower_idx ON catalog_wines (lower(color));
CREATE INDEX IF NOT EXISTS catalog_wines_region_lower_idx ON catalog_wines (lower(region));
CREATE INDEX IF NOT EXISTS catalog_wines_type_lower_idx ON catalog_wines (lower(wine_type));
