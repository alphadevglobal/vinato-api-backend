-- Mirror of vinato-web migrations 0008 (image helper functions) and 0010
-- (wine photo pool), which apply them in production. scripts/migrate.ts reruns
-- every file, so the backfill only inserts what is missing.

-- Label photos live inside catalog_wines.images (jsonb), usually as base64 data
-- URLs written by the API scanner. Reading that column to measure or compare
-- photos means detoasting megabytes per row, so every change is recorded here
-- once, with the size and an md5 per image, and the admin panel reads this instead.
CREATE OR REPLACE FUNCTION vinato_image_ref(item jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT nullif(btrim(CASE
    WHEN jsonb_typeof(item) = 'string' THEN item #>> '{}'
    WHEN jsonb_typeof(item) = 'object' THEN coalesce(item->>'url', item->>'src', item->>'image_url', item->>'data')
  END), '')
$$;

-- Decoded size of a base64 data URL; NULL for remote URLs (size unknown without fetching them).
CREATE OR REPLACE FUNCTION vinato_image_ref_bytes(ref text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN left(ref, 5) = 'data:' AND position(';base64,' IN left(ref, 120)) > 0 THEN
    (floor((length(ref) - strpos(ref, ',')) * 3 / 4.0) - (length(ref) - length(rtrim(ref, '='))))::bigint
  END
$$;

CREATE OR REPLACE FUNCTION vinato_images_refs(images jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(ref ORDER BY position) FILTER (WHERE ref IS NOT NULL), '{}')
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(images) = 'array' THEN images ELSE '[]'::jsonb END) WITH ORDINALITY AS e(item, position)
  CROSS JOIN LATERAL (SELECT vinato_image_ref(item) AS ref) r
$$;

-- Pool of label photos per catalog wine: the latest distinct photos sent by the
-- scanner for that wine, so the admin can choose which one the app shows
-- (catalog_wines.images->0). A byte-identical photo is stored once and counted
-- in times_seen. Written by vinato-api-backend (this is the local mirror of vinato-web migration 0010).
CREATE TABLE IF NOT EXISTS wine_photo_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_id uuid NOT NULL REFERENCES catalog_wines(id) ON DELETE CASCADE,
  image_data_url text NOT NULL,
  image_md5 text GENERATED ALWAYS AS (md5(image_data_url)) STORED,
  image_bytes bigint GENERATED ALWAYS AS (vinato_image_ref_bytes(image_data_url)) STORED,
  source text NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'unlisted_scan', 'catalog')),
  unlisted_code text,
  user_id uuid,
  times_seen integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wine_id, image_md5)
);

CREATE INDEX IF NOT EXISTS wine_photo_candidates_wine_idx ON wine_photo_candidates (wine_id, last_seen_at DESC);

-- Keeps the 5 most recent photos of a wine, plus the one currently shown as the
-- main photo (never discarded, however old).
CREATE OR REPLACE FUNCTION vinato_trim_wine_photo_pool() RETURNS trigger AS $$
DECLARE
  main_hash text;
BEGIN
  SELECT md5(vinato_image_ref(images->0)) INTO main_hash FROM catalog_wines WHERE id = NEW.wine_id;
  DELETE FROM wine_photo_candidates c
  WHERE c.wine_id = NEW.wine_id
    AND c.image_md5 IS DISTINCT FROM main_hash
    AND c.id NOT IN (
      SELECT id FROM wine_photo_candidates
      WHERE wine_id = NEW.wine_id AND image_md5 IS DISTINCT FROM main_hash
      ORDER BY last_seen_at DESC, first_seen_at DESC
      LIMIT 5
    );
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vinato_wine_photo_pool_trim ON wine_photo_candidates;

CREATE TRIGGER vinato_wine_photo_pool_trim
AFTER INSERT OR UPDATE OF last_seen_at ON wine_photo_candidates
FOR EACH ROW EXECUTE FUNCTION vinato_trim_wine_photo_pool();

-- Photos stored in the catalog today (scanner photos kept as data URLs).
INSERT INTO wine_photo_candidates (wine_id, image_data_url, source, first_seen_at, last_seen_at)
SELECT w.id, ref, 'catalog', w.updated_at, w.updated_at
FROM catalog_wines w
CROSS JOIN LATERAL unnest(vinato_images_refs(w.images)) AS ref
WHERE jsonb_typeof(w.images) = 'array' AND w.images <> '[]'::jsonb AND vinato_image_ref_bytes(ref) IS NOT NULL
ON CONFLICT (wine_id, image_md5) DO NOTHING;

-- Scans the admin linked to a wine: one candidate per distinct photo.
DO $$
BEGIN
  IF to_regclass('public.unlisted_wine_scans') IS NOT NULL THEN
    INSERT INTO wine_photo_candidates (wine_id, image_data_url, source, unlisted_code, user_id, times_seen, first_seen_at, last_seen_at)
    SELECT DISTINCT ON (registered_wine_id, md5(image_data_url))
      registered_wine_id, image_data_url, 'unlisted_scan', unlisted_code, user_id,
      sum(1 + resubmissions) OVER photo, min(created_at) OVER photo, max(coalesce(last_submitted_at, created_at)) OVER photo
    FROM unlisted_wine_scans
    WHERE registered_wine_id IS NOT NULL
    WINDOW photo AS (PARTITION BY registered_wine_id, md5(image_data_url))
    ORDER BY registered_wine_id, md5(image_data_url), created_at DESC
    ON CONFLICT (wine_id, image_md5) DO NOTHING;
  END IF;
END $$;
