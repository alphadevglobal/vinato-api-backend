import type pg from "pg";

export type WineReview = {
  id: string;
  author: string;
  rating: number;
  comment: string | null;
  createdAt: string;
  updatedAt: string;
  edited: boolean;
};
export type WineReviews = { average: number | null; count: number; reviews: WineReview[]; myReview: WineReview | null };

/** "Gabriel Lopes Ferreira" -> "Gabriel L.": reviews are public, full names are not. */
export function publicAuthorName(displayName: string | null | undefined) {
  const parts = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "Membro VINATO";
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** Ratings go from 1 to 5 in steps of 0.5. */
export function validRating(value: unknown): number | null {
  const rating = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5 || Math.round(rating * 2) !== rating * 2) return null;
  return rating;
}

const SELECT_REVIEW = `
  SELECT r.id, r.user_id, u.display_name, r.rating::float AS rating, r.comment, r.created_at, r.updated_at, r.edit_count
  FROM wine_reviews r JOIN app_users u ON u.id = r.user_id`;

function mapReview(row: Record<string, unknown>): WineReview {
  return {
    id: String(row.id), author: publicAuthorName(row.display_name as string | null), rating: Number(row.rating),
    comment: (row.comment as string | null) ?? null, createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    edited: Number(row.edit_count) > 0,
  };
}

export class ReviewRepository {
  constructor(private readonly pool: pg.Pool) {}

  async list(wineId: string, viewerId?: string, limit = 100): Promise<WineReviews> {
    const [stats, reviews, mine] = await Promise.all([
      this.pool.query(`SELECT review_count, round(rating_sum / NULLIF(review_count, 0), 1)::float AS average FROM wine_review_stats WHERE wine_id = $1`, [wineId]),
      this.pool.query(`${SELECT_REVIEW} WHERE r.wine_id = $1 ORDER BY r.updated_at DESC LIMIT $2`, [wineId, limit]),
      viewerId ? this.pool.query(`${SELECT_REVIEW} WHERE r.wine_id = $1 AND r.user_id = $2`, [wineId, viewerId]) : Promise.resolve({ rows: [] }),
    ]);
    const count = Number(stats.rows[0]?.review_count ?? 0);
    return {
      average: count ? Number(stats.rows[0].average) : null,
      count,
      reviews: reviews.rows.map(mapReview),
      myReview: mine.rows[0] ? mapReview(mine.rows[0]) : null,
    };
  }

  /**
   * One review per user and wine. Editing keeps the previous version:
   * the wine_reviews_archive trigger copies it to wine_review_history.
   */
  async upsert(wineId: string, userId: string, rating: number, comment: string | null): Promise<WineReview> {
    const saved = await this.pool.query(
      `INSERT INTO wine_reviews (wine_id, user_id, rating, comment) VALUES ($1, $2, $3, $4)
       ON CONFLICT (wine_id, user_id) DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment
       RETURNING id`,
      [wineId, userId, rating, comment],
    );
    const row = (await this.pool.query(`${SELECT_REVIEW} WHERE r.id = $1`, [saved.rows[0].id])).rows[0];
    return mapReview(row);
  }

  async history(reviewId: string) {
    const result = await this.pool.query(
      `SELECT rating::float AS rating, comment, rated_at AS "ratedAt", replaced_at AS "replacedAt" FROM wine_review_history WHERE review_id = $1 ORDER BY replaced_at DESC`,
      [reviewId],
    );
    return result.rows;
  }
}
