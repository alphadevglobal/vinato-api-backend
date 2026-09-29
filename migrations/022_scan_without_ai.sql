-- Scan without AI tokens: the phone reads the label (text + barcode) and the API
-- first looks the wine up in the catalog; only an exact answer skips the AI.
-- Local mirror of vinato-web migration 0020, which applies it in production.

-- Product barcodes (EAN-13/EAN-8) linked to catalog wines. Learned from scans:
-- when a scan resolves the wine, the barcode on that photo finds it next time.
CREATE TABLE IF NOT EXISTS wine_barcodes (
  barcode text PRIMARY KEY CHECK (barcode ~ '^[0-9]{8}$|^[0-9]{13}$'),
  wine_id uuid NOT NULL REFERENCES catalog_wines(id) ON DELETE CASCADE,
  -- scan_ai: the AI read the label; scan_text: exact match on the label text; admin: set by the team.
  source text NOT NULL DEFAULT 'scan_ai' CHECK (source IN ('scan_ai', 'scan_text', 'admin')),
  confirmations integer NOT NULL DEFAULT 0,
  corrections integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wine_barcodes_wine_idx ON wine_barcodes (wine_id);

-- How each scan found its wine, and what the phone read.
ALTER TABLE scan_audit_logs ADD COLUMN IF NOT EXISTS resolved_by text CHECK (resolved_by IS NULL OR resolved_by IN ('barcode', 'text', 'ai'));
ALTER TABLE scan_audit_logs ADD COLUMN IF NOT EXISTS device_reading jsonb;
CREATE INDEX IF NOT EXISTS scan_audit_logs_resolved_idx ON scan_audit_logs (resolved_by, created_at DESC);
