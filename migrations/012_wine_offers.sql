-- "Onde encontrar": prices only from stores approved by the VINATO team.
-- wine_merchants is the approved list (managed in vinato-web); the price agent
-- (vinato-web GitHub Action, every 6 h) reads each active store and upserts
-- wine_offers; price_agent_runs keeps a report of every run.
CREATE TABLE IF NOT EXISTS wine_merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  website_url text NOT NULL UNIQUE,
  logo_url text,
  -- high: always above everything else; medium and low compete on price
  -- (medium wins ties).
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  active boolean NOT NULL DEFAULT true,
  notes text,
  last_run_at timestamptz,
  last_run_status text,
  last_run_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wine_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_id uuid NOT NULL REFERENCES catalog_wines(id) ON DELETE CASCADE,
  merchant_id uuid NOT NULL REFERENCES wine_merchants(id) ON DELETE CASCADE,
  product_name text NOT NULL,
  product_url text NOT NULL,
  price numeric(12,2) NOT NULL CHECK (price > 0),
  currency text NOT NULL DEFAULT 'BRL',
  bottle_size_ml integer,
  in_stock boolean NOT NULL DEFAULT true,
  match_score numeric,
  source text,
  hidden boolean NOT NULL DEFAULT false,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wine_offers_one_per_product UNIQUE (merchant_id, product_url)
);
CREATE INDEX IF NOT EXISTS wine_offers_wine_idx ON wine_offers (wine_id, price) WHERE NOT hidden AND in_stock;
CREATE INDEX IF NOT EXISTS wine_offers_merchant_idx ON wine_offers (merchant_id, last_seen_at);

CREATE TABLE IF NOT EXISTS price_agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  merchants integer NOT NULL DEFAULT 0,
  products_seen integer NOT NULL DEFAULT 0,
  offers_upserted integer NOT NULL DEFAULT 0,
  offers_unmatched integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS price_agent_runs_started_idx ON price_agent_runs (started_at DESC);
