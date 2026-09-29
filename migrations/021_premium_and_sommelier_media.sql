-- Premium in the app, app-update notices and photos/audio for the Sommelier.
-- Local mirror of vinato-web migration 0019, which applies it in production.
-- news_articles and finance_settings belong to vinato-web: only touched when present.
DO $$ BEGIN
  IF to_regclass('public.news_articles') IS NOT NULL THEN
    ALTER TABLE news_articles ADD COLUMN IF NOT EXISTS audience text NOT NULL DEFAULT 'feed';
  END IF;
  IF to_regclass('public.finance_settings') IS NOT NULL THEN
    ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS premium_monthly_cents integer NOT NULL DEFAULT 2990;
    ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS premium_yearly_cents integer NOT NULL DEFAULT 23990;
  END IF;
END $$;

-- When the current Premium started ("Assinante desde" in the app).
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS plan_started_at timestamptz;

-- Sommelier: messages with photos or audio are answered by a model that reads both.
ALTER TABLE sommelier_agent_config ADD COLUMN IF NOT EXISTS media_model text NOT NULL DEFAULT 'google/gemini-3.8-flash';
CREATE TABLE IF NOT EXISTS sommelier_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES sommelier_messages(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('image', 'audio')),
  mime_type text NOT NULL,
  data_url text NOT NULL,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sommelier_attachments_message_idx ON sommelier_attachments (message_id);
