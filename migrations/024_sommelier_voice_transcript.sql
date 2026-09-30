-- Transcript of each voice message sent to the Sommelier: finds the restaurant named
-- out loud (its wine list), keeps the question in the history and shows in the admin
-- "Logs Sommelier". Mirror of vinato-web migration 0022.
ALTER TABLE sommelier_attachments ADD COLUMN IF NOT EXISTS transcript text;
