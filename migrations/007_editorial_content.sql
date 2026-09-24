CREATE TABLE IF NOT EXISTS sommelier_selections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_id uuid REFERENCES catalog_wines(id) ON DELETE SET NULL,
  eyebrow text NOT NULL DEFAULT 'SELEÇÃO DO SOMMELIER',
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  image_url text,
  cta_label text NOT NULL DEFAULT 'Acessar Dossier',
  published boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sommelier_selections_public_idx ON sommelier_selections (published, sort_order, updated_at DESC);
