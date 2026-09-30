-- The Sommelier consults a transcribed wine list ("Harmonizar com o Sommelier"):
-- the conversation keeps the list for the next questions, and each answer records
-- the list it used (admin "Logs Sommelier"). Mirror of vinato-web migration 0021.
ALTER TABLE sommelier_conversations ADD COLUMN IF NOT EXISTS wine_list_id uuid REFERENCES wine_lists(id) ON DELETE SET NULL;
ALTER TABLE sommelier_messages ADD COLUMN IF NOT EXISTS wine_list_id uuid REFERENCES wine_lists(id) ON DELETE SET NULL;
