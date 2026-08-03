CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS wines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lwin text NOT NULL UNIQUE,
  status text,
  display_name text NOT NULL,
  producer_title text,
  producer_name text,
  wine text,
  country text,
  region text,
  sub_region text,
  site text,
  parcel text,
  colour text,
  type text,
  sub_type text,
  designation text,
  classification text,
  vintage_config text,
  first_vintage text,
  final_vintage text,
  date_added text,
  date_updated text,
  reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wines_display_name_idx ON wines (display_name);
CREATE INDEX IF NOT EXISTS wines_display_name_trgm_idx ON wines USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS wines_country_lower_idx ON wines (lower(country));
CREATE INDEX IF NOT EXISTS wines_colour_lower_idx ON wines (lower(colour));
CREATE INDEX IF NOT EXISTS wines_region_lower_idx ON wines (lower(region));
CREATE INDEX IF NOT EXISTS wines_type_lower_idx ON wines (lower(type));
