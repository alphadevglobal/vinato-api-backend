-- User reviews of catalog wines.
-- One review per user and wine (edits keep every previous version in
-- wine_review_history). wine_review_stats keeps count and sum per wine,
-- maintained by triggers, so the "Nota Crítica" average is one indexed read.
CREATE TABLE IF NOT EXISTS wine_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wine_id uuid NOT NULL REFERENCES catalog_wines(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  rating numeric(2,1) NOT NULL CHECK (rating >= 1 AND rating <= 5 AND rating * 2 = trunc(rating * 2)),
  comment text CHECK (comment IS NULL OR length(comment) <= 500),
  edit_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wine_reviews_one_per_user UNIQUE (wine_id, user_id)
);
CREATE INDEX IF NOT EXISTS wine_reviews_wine_idx ON wine_reviews (wine_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS wine_reviews_user_idx ON wine_reviews (user_id, updated_at DESC);

-- Every version a review had before being edited.
CREATE TABLE IF NOT EXISTS wine_review_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL REFERENCES wine_reviews(id) ON DELETE CASCADE,
  wine_id uuid NOT NULL,
  user_id uuid NOT NULL,
  rating numeric(2,1) NOT NULL,
  comment text,
  rated_at timestamptz NOT NULL,
  replaced_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wine_review_history_review_idx ON wine_review_history (review_id, replaced_at DESC);

CREATE TABLE IF NOT EXISTS wine_review_stats (
  wine_id uuid PRIMARY KEY REFERENCES catalog_wines(id) ON DELETE CASCADE,
  review_count integer NOT NULL DEFAULT 0 CHECK (review_count >= 0),
  rating_sum numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Before an edit: archive the previous version and count the edit.
CREATE OR REPLACE FUNCTION wine_reviews_archive() RETURNS trigger AS $$
BEGIN
  IF NEW.rating IS DISTINCT FROM OLD.rating OR NEW.comment IS DISTINCT FROM OLD.comment THEN
    INSERT INTO wine_review_history (review_id, wine_id, user_id, rating, comment, rated_at)
    VALUES (OLD.id, OLD.wine_id, OLD.user_id, OLD.rating, OLD.comment, OLD.updated_at);
    NEW.edit_count := OLD.edit_count + 1;
    NEW.updated_at := now();
  END IF;
  NEW.wine_id := OLD.wine_id;
  NEW.user_id := OLD.user_id;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wine_reviews_archive ON wine_reviews;
CREATE TRIGGER wine_reviews_archive BEFORE UPDATE ON wine_reviews FOR EACH ROW EXECUTE FUNCTION wine_reviews_archive();

-- After any change: keep count and sum per wine up to date.
CREATE OR REPLACE FUNCTION wine_reviews_stats() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO wine_review_stats (wine_id, review_count, rating_sum) VALUES (NEW.wine_id, 1, NEW.rating)
    ON CONFLICT (wine_id) DO UPDATE SET review_count = wine_review_stats.review_count + 1, rating_sum = wine_review_stats.rating_sum + EXCLUDED.rating_sum, updated_at = now();
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE wine_review_stats SET rating_sum = rating_sum - OLD.rating + NEW.rating, updated_at = now() WHERE wine_id = NEW.wine_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE wine_review_stats SET review_count = greatest(review_count - 1, 0), rating_sum = rating_sum - OLD.rating, updated_at = now() WHERE wine_id = OLD.wine_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS wine_reviews_stats ON wine_reviews;
CREATE TRIGGER wine_reviews_stats AFTER INSERT OR UPDATE OR DELETE ON wine_reviews FOR EACH ROW EXECUTE FUNCTION wine_reviews_stats();
