ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';

UPDATE app_users SET status = 'blocked' WHERE status <> 'active';
ALTER TABLE app_users DROP CONSTRAINT IF EXISTS app_users_status_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_status_check CHECK (status IN ('active', 'blocked'));

DO $$ BEGIN
  ALTER TABLE app_users ADD CONSTRAINT app_users_plan_check
    CHECK (plan IN ('free', 'premium'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS user_identities (
  provider text NOT NULL CHECK (provider IN ('apple', 'google')),
  provider_subject text NOT NULL,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  provider_email citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_subject)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

-- The website's administrative users table and the app share access state.
-- Any ban/suspension made by the website is reflected immediately in the app.
CREATE OR REPLACE FUNCTION sync_admin_user_to_app_user() RETURNS trigger AS $$
BEGIN
  UPDATE app_users
     SET email = NEW.email,
         display_name = COALESCE(NEW.display_name, app_users.display_name),
         avatar_url = COALESCE(NEW.avatar_url, app_users.avatar_url),
         role = CASE
           WHEN NEW.role IN ('super_admin', 'admin', 'owner') THEN 'owner'
           WHEN NEW.role = 'editor' THEN 'editor'
           ELSE 'user'
         END,
         status = CASE WHEN NEW.status = 'active' THEN 'active' ELSE 'blocked' END,
         updated_at = now()
   WHERE id = NEW.id OR lower(email::text) = lower(NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_sync_app_access ON users;
CREATE TRIGGER users_sync_app_access
AFTER INSERT OR UPDATE OF email, display_name, avatar_url, role, status ON users
FOR EACH ROW EXECUTE FUNCTION sync_admin_user_to_app_user();

UPDATE app_users app
SET status = CASE WHEN admin.status = 'active' THEN 'active' ELSE 'blocked' END,
    role = CASE WHEN admin.role IN ('super_admin', 'admin', 'owner') THEN 'owner' WHEN admin.role = 'editor' THEN 'editor' ELSE 'user' END,
    updated_at = now()
FROM users admin
WHERE app.id = admin.id OR lower(app.email::text) = lower(admin.email);

UPDATE app_users
SET plan = 'premium', role = 'owner', status = 'active', updated_at = now()
WHERE lower(email::text) = 'contato@vinatoapp.com';
