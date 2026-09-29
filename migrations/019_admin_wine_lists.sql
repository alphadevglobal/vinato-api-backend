-- Wine lists uploaded from the admin "Curadoria Carta de Vinhos" (for a new or an
-- existing restaurant): uploaded_by is the admin (users.id), user_id stays empty.
-- The index serves the app history ("Seus restaurantes") of each user.
-- Mirror of vinato-web migration 0015 (applied in production by the web action).
ALTER TABLE wine_lists ADD COLUMN IF NOT EXISTS uploaded_by uuid;
CREATE INDEX IF NOT EXISTS wine_lists_user_idx ON wine_lists (user_id, created_at DESC);
