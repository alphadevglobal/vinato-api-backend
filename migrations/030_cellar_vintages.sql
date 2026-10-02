-- Adega: the vintages the user has of each wine of the cellar, with the bottles of
-- each. The wine stays the same whatever the vintage (a Ciro 2016 and a Ciro 2020
-- are one catalog wine); the vintage only tells where each bottle is in the wine's
-- janela de uso. Removing the wine from the cellar removes its vintages.
-- Mirror of vinato-web migration 0028.
CREATE TABLE IF NOT EXISTS user_cellar_vintages (
  user_id uuid NOT NULL,
  wine_id uuid NOT NULL,
  vintage integer NOT NULL CHECK (vintage BETWEEN 1800 AND 2200),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity BETWEEN 1 AND 9999),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, wine_id, vintage),
  FOREIGN KEY (user_id, wine_id) REFERENCES user_cellars (user_id, wine_id) ON DELETE CASCADE
);
