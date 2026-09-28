-- Runtime AI model selection managed by vinato-web/admin. The scanner reads
-- this singleton row for every request, so model changes need no deployment.
CREATE TABLE IF NOT EXISTS scanner_agent_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model text NOT NULL DEFAULT 'google/gemini-3.1-flash-lite',
  fallback_model text NOT NULL DEFAULT 'google/gemini-3.8-flash',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO scanner_agent_config (id, model, fallback_model)
VALUES (1, 'google/gemini-3.1-flash-lite', 'google/gemini-3.8-flash')
ON CONFLICT (id) DO NOTHING;
