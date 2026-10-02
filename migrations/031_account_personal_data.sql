-- Cadastro da conta: CPF (one account per CPF), date of birth, phone, the Termos de
-- Uso, the 18+ confirmation and the optional consent to news by phone and e-mail.
-- CPF, date of birth and phone are stored only encrypted (AES-256-GCM, the key lives
-- in the API's environment, never in the database); cpf_hash is a keyed hash
-- (HMAC-SHA256) that keeps one account per CPF without the CPF being readable.
-- Every consent given or withdrawn is kept in user_consents (LGPD evidence).
-- Mirror of vinato-web migration 0029.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS cpf_hash text,
  ADD COLUMN IF NOT EXISTS cpf_encrypted text,
  ADD COLUMN IF NOT EXISTS birth_date_encrypted text,
  ADD COLUMN IF NOT EXISTS phone_country text,
  ADD COLUMN IF NOT EXISTS phone_encrypted text,
  ADD COLUMN IF NOT EXISTS terms_version text,
  ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS adult_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS marketing_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_cpf_hash_key ON app_users (cpf_hash) WHERE cpf_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS user_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('terms', 'adult', 'marketing')),
  granted boolean NOT NULL,
  version text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_consents_user_idx ON user_consents (user_id, created_at DESC);
-- The legal texts shown in the app; the newest version of each kind is the current one.
-- Publishing a new version of the Termos de Uso asks every member to accept it again.
CREATE TABLE IF NOT EXISTS legal_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('terms')),
  version text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  UNIQUE (kind, version)
);
INSERT INTO legal_documents (kind, version, title, body)
VALUES ('terms', '0-provisorio', 'Termos de Uso do VINATO',
  'Os Termos de Uso do VINATO estão sendo finalizados pela nossa equipe jurídica e serão publicados aqui.

Até lá, ao criar sua conta você confirma que tem 18 anos ou mais, que as informações fornecidas são verdadeiras e que usará o VINATO de forma pessoal e responsável. Seus dados (CPF, data de nascimento e telefone) são guardados de forma protegida e usados apenas para identificar sua conta. O consumo de bebidas alcoólicas é proibido para menores de 18 anos. Beba com moderação.

Quando a versão final for publicada, pediremos que você a leia e aceite.')
ON CONFLICT (kind, version) DO NOTHING;
