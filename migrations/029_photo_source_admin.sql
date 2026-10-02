-- Photos uploaded in the admin ("Editar ficha") join the wine's photo pool as source
-- 'admin'. Mirror of vinato-web migration 0027, which also marks the uploads made
-- before it (found in admin_audit_log, a vinato-web table).
ALTER TABLE wine_photo_candidates DROP CONSTRAINT IF EXISTS wine_photo_candidates_source_check;
ALTER TABLE wine_photo_candidates ADD CONSTRAINT wine_photo_candidates_source_check CHECK (source IN ('scan', 'unlisted_scan', 'catalog', 'admin'));
