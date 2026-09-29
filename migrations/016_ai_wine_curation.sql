-- Local mirror of vinato-web migration 0011 (AI-created wines, wine_ai_proposals,
-- front/back photo protection, 'ai_created' scan outcome), which applies it in
-- production together with the conversion of the old review queue.
ALTER TABLE catalog_wines ADD COLUMN IF NOT EXISTS data_source text NOT NULL DEFAULT 'catalog';

ALTER TABLE catalog_wines ADD COLUMN IF NOT EXISTS curation_status text NOT NULL DEFAULT 'approved';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_wines_data_source_check') THEN
    ALTER TABLE catalog_wines ADD CONSTRAINT catalog_wines_data_source_check CHECK (data_source IN ('catalog', 'ai_scan', 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_wines_curation_status_check') THEN
    ALTER TABLE catalog_wines ADD CONSTRAINT catalog_wines_curation_status_check CHECK (curation_status IN ('approved', 'pending', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS catalog_wines_curation_idx ON catalog_wines (curation_status, data_source)
  WHERE curation_status <> 'approved' OR data_source <> 'catalog';

-- What the AI proposes for a wine: every field of a wine it created ('new_wine'),
-- or the fields it would fill or change on an existing wine ('update').
-- proposed/current_values use the same field names (see lib/wine-curation.ts).
CREATE TABLE IF NOT EXISTS wine_ai_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_id uuid NOT NULL REFERENCES catalog_wines(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('new_wine', 'update')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'partially_applied', 'rejected')),
  proposed jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_values jsonb NOT NULL DEFAULT '{}'::jsonb,
  reading jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  confidence numeric,
  user_id uuid,
  unlisted_code text,
  times_proposed integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_proposed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  decisions jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS wine_ai_proposals_pending_idx ON wine_ai_proposals (wine_id, kind) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS wine_ai_proposals_status_idx ON wine_ai_proposals (status, last_proposed_at DESC);

-- Front and back labels: images->0 is the front, images->1 the back. The pool
-- trim (0010) now protects both.
CREATE OR REPLACE FUNCTION vinato_trim_wine_photo_pool() RETURNS trigger AS $$
DECLARE
  front_hash text;
  back_hash text;
BEGIN
  SELECT md5(vinato_image_ref(images->0)), md5(vinato_image_ref(images->1)) INTO front_hash, back_hash
  FROM catalog_wines WHERE id = NEW.wine_id;
  DELETE FROM wine_photo_candidates c
  WHERE c.wine_id = NEW.wine_id
    AND c.image_md5 IS DISTINCT FROM front_hash
    AND c.image_md5 IS DISTINCT FROM back_hash
    AND c.id NOT IN (
      SELECT id FROM wine_photo_candidates
      WHERE wine_id = NEW.wine_id AND image_md5 IS DISTINCT FROM front_hash AND image_md5 IS DISTINCT FROM back_hash
      ORDER BY last_seen_at DESC, first_seen_at DESC
      LIMIT 5
    );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF to_regclass('public.scan_audit_logs') IS NOT NULL THEN
    ALTER TABLE scan_audit_logs DROP CONSTRAINT IF EXISTS scan_audit_logs_outcome_check;
    ALTER TABLE scan_audit_logs ADD CONSTRAINT scan_audit_logs_outcome_check
      CHECK (outcome IN ('matched', 'needs_registration', 'recognition_failed', 'catalog_failed', 'ai_created'));
  END IF;
END $$;
