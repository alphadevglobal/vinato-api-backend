-- Sommelier VINATO: a Premium-only chat agent served by the API.
-- The agent's behaviour (instructions, model, limits) lives in
-- sommelier_agent_config so it can be tuned without a deploy.
CREATE TABLE IF NOT EXISTS sommelier_agent_config (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  model text NOT NULL DEFAULT 'deepseek/deepseek-v3.2',
  system_prompt text NOT NULL,
  reasoning_enabled boolean NOT NULL DEFAULT true,
  temperature numeric NOT NULL DEFAULT 0.7 CHECK (temperature >= 0 AND temperature <= 2),
  max_output_tokens integer NOT NULL DEFAULT 1200 CHECK (max_output_tokens BETWEEN 100 AND 8000),
  history_messages integer NOT NULL DEFAULT 20 CHECK (history_messages BETWEEN 2 AND 60),
  daily_message_limit integer NOT NULL DEFAULT 60 CHECK (daily_message_limit > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO sommelier_agent_config (id, system_prompt) VALUES (1,
'Você é o Sommelier VINATO, o sommelier virtual do aplicativo VINATO.
Instruções provisórias (serão substituídas pelas regras definidas pela equipe VINATO):
- Responda em português do Brasil, com clareza e cordialidade.
- Fale apenas de vinhos, uvas, regiões, harmonização, serviço e conservação.
- Não invente dados de vinhos; quando não souber, diga que não tem certeza.
- Incentive o consumo responsável e somente por maiores de 18 anos.')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sommelier_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sommelier_conversations_user_idx ON sommelier_conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS sommelier_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES sommelier_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  -- OpenRouter reasoning_details, passed back unmodified on the next turn.
  reasoning_details jsonb,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sommelier_messages_conversation_idx ON sommelier_messages (conversation_id, created_at);
