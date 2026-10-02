-- Janela de uso: how the wine evolves over the years after the vintage, phase by
-- phase, e.g. [{"from":1,"to":3,"note":"Perfil floral"},{"from":4,"to":7,"note":"Notas terrosas"},
-- {"from":8,"to":10,"plus":true,"note":"Em declínio"}]. Edited in the admin wine detail
-- and shown to Premium members with the tempo de guarda. Mirror of vinato-web migration 0026.
ALTER TABLE catalog_wines ADD COLUMN IF NOT EXISTS drinking_window jsonb;
