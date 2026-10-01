-- Cardápios: the dishes of the partner restaurants, uploaded in the admin like the
-- wine lists (photos or a PDF transcribed by the AI). The Sommelier reads the menu
-- with the wine list of the same restaurant to pair a dish with a wine of the list.
-- Mirror of vinato-web migration 0024.
CREATE TABLE IF NOT EXISTS restaurant_menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid REFERENCES restaurants(id) ON DELETE SET NULL,
  user_id uuid,
  uploaded_by uuid,
  restaurant_name text,
  city text,
  address text,
  source text NOT NULL CHECK (source IN ('photo', 'pdf')),
  status text NOT NULL DEFAULT 'transcribed' CHECK (status IN ('transcribed', 'failed')),
  curation_status text NOT NULL DEFAULT 'pending' CHECK (curation_status IN ('pending', 'approved', 'rejected')),
  model text,
  models_tried jsonb NOT NULL DEFAULT '[]'::jsonb,
  usage jsonb,
  error_message text,
  duration_ms integer,
  item_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  deleted_at timestamptz,
  deleted_by uuid
);
CREATE INDEX IF NOT EXISTS restaurant_menus_restaurant_idx ON restaurant_menus (restaurant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS restaurant_menus_current_idx ON restaurant_menus (restaurant_id, created_at DESC)
  WHERE deleted_at IS NULL AND status = 'transcribed' AND curation_status <> 'rejected';
CREATE TABLE IF NOT EXISTS restaurant_menu_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id uuid NOT NULL REFERENCES restaurant_menus(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  mime text NOT NULL,
  file_data_url text NOT NULL,
  file_bytes bigint GENERATED ALWAYS AS (vinato_image_ref_bytes(file_data_url)) STORED
);
CREATE INDEX IF NOT EXISTS restaurant_menu_files_menu_idx ON restaurant_menu_files (menu_id, position);
CREATE TABLE IF NOT EXISTS restaurant_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id uuid NOT NULL REFERENCES restaurant_menus(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  section text,
  name text NOT NULL,
  description text,
  price numeric,
  currency text NOT NULL DEFAULT 'BRL',
  notes text
);
CREATE INDEX IF NOT EXISTS restaurant_menu_items_menu_idx ON restaurant_menu_items (menu_id, position);
-- The Sommelier answer records the menu it read (Logs Sommelier).
ALTER TABLE sommelier_messages ADD COLUMN IF NOT EXISTS menu_id uuid;
