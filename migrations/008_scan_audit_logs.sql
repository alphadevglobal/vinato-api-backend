-- One row per label scan, kept apart from the generic app_event_logs: the photo,
-- which AI model read it (and every attempt), whether the catalog was queried,
-- and how the scan ended. Written by POST /wine-scanner/scan, read by the
-- vinato-web admin "Logs → Scans da API".
CREATE TABLE IF NOT EXISTS scan_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  success boolean NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('matched', 'needs_registration', 'recognition_failed', 'catalog_failed')),
  error_stage text CHECK (error_stage IS NULL OR error_stage IN ('recognition', 'catalog')),
  error_message text,
  image_data_url text,
  image_mime text,
  image_bytes integer,
  model_used text,
  models_tried jsonb NOT NULL DEFAULT '[]'::jsonb,
  reading jsonb,
  confidence numeric,
  catalog_queried boolean NOT NULL DEFAULT false,
  catalog_candidates integer,
  catalog_wine_id uuid REFERENCES catalog_wines(id) ON DELETE SET NULL,
  match_score numeric,
  unlisted_code text,
  image_added boolean,
  duration_ms integer,
  recognition_ms integer,
  catalog_ms integer,
  platform text,
  app_version text
);

CREATE INDEX IF NOT EXISTS scan_audit_logs_created_idx ON scan_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS scan_audit_logs_outcome_idx ON scan_audit_logs (outcome, created_at DESC);
CREATE INDEX IF NOT EXISTS scan_audit_logs_model_idx ON scan_audit_logs (model_used, created_at DESC);
CREATE INDEX IF NOT EXISTS scan_audit_logs_user_idx ON scan_audit_logs (user_id, created_at DESC);
