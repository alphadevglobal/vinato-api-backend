-- Verificação de carta: the app lists the restaurants that already have a wine list,
-- and the admin manages them (web "Curadoria Carta de Vinhos").
-- network_note: how a restaurant chain is described in the app (e.g. "Rede com
-- unidades em São Paulo, Lisboa e Miami"). Local mirror of vinato-web migration 0018, which applies it in production.
ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS network_note text;
-- A deleted list keeps only this row (model attempts and usage: its AI cost stays in
-- the Financeiro); its photos, items and bottle checks are removed.
ALTER TABLE wine_lists ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE wine_lists ADD COLUMN IF NOT EXISTS deleted_by uuid;
-- The current list of each restaurant, read by the app for every user.
CREATE INDEX IF NOT EXISTS wine_lists_current_idx ON wine_lists (restaurant_id, created_at DESC)
  WHERE deleted_at IS NULL AND status = 'transcribed' AND curation_status <> 'rejected';
