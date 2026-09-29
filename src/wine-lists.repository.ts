import type pg from "pg";
import { normalizeText } from "./catalog-matcher.js";
import type { ModelAttempt, OpenRouterUsage } from "./openrouter.js";
import type { BottleCheck, ListFile, WineListItem } from "./wine-list.service.js";

export type RestaurantInput = { id?: string | null; name?: string | null; city?: string | null; address?: string | null; latitude?: number | null; longitude?: number | null };
export type SavedItem = WineListItem & { id: string; position: number };
export type RestaurantWithList = {
  id: string; name: string; city: string | null; address: string | null; networkNote: string | null; otherCities: string[];
  listId: string; updatedAt: string; itemCount: number; approved: boolean; mine: boolean;
};
export type SavedList = {
  id: string; status: "transcribed" | "failed"; source: "photo" | "pdf"; createdAt: string;
  restaurant: { id: string | null; name: string | null; city: string | null; address: string | null };
  items: SavedItem[];
};
type ListRecord = {
  // userId: the app user who sent the list; uploadedBy: the admin who uploaded it in the panel.
  userId?: string | null; uploadedBy?: string | null; restaurant: RestaurantInput; source: "photo" | "pdf"; files: ListFile[]; items: WineListItem[];
  status: "transcribed" | "failed"; model: string | null; attempts: ModelAttempt[]; usage: OpenRouterUsage; errorMessage?: string | null; durationMs: number;
};

const clean = (value: string | null | undefined) => value?.trim() ? value.trim().slice(0, 200) : null;
const coordinate = (value: number | null | undefined, limit: number) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit ? value : null;

const ITEM_SELECT = `id, position, section, name, producer, vintage, country, region, grapes, style, volume,
  price::float8 AS price, glass_price::float8 AS "glassPrice", currency, notes`;

export class WineListRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** The restaurant chosen (id), the one with the same name (accents and case ignored) in the same city, or a new one. */
  private async restaurantId(input: RestaurantInput) {
    if (input.id) {
      const chosen = await this.pool.query<{ id: string }>(`SELECT id FROM restaurants WHERE id = $1`, [input.id]);
      if (chosen.rows[0]) return chosen.rows[0].id;
    }
    const name = clean(input.name);
    if (!name) return null;
    const city = clean(input.city);
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO restaurants (name, name_key, city, address, latitude, longitude)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name_key, (coalesce(lower(btrim(city)), ''))) DO UPDATE SET
         address = coalesce(restaurants.address, EXCLUDED.address),
         latitude = coalesce(restaurants.latitude, EXCLUDED.latitude),
         longitude = coalesce(restaurants.longitude, EXCLUDED.longitude),
         updated_at = now()
       RETURNING id`,
      [name, normalizeText(name), city, clean(input.address), coordinate(input.latitude, 90), coordinate(input.longitude, 180)],
    );
    return result.rows[0].id;
  }

  /** Whether the restaurant exists (the admin uploads a list for an existing one). */
  async restaurantExists(id: string) {
    return Boolean((await this.pool.query(`SELECT 1 FROM restaurants WHERE id = $1`, [id])).rowCount);
  }

  async saveList(record: ListRecord): Promise<SavedList> {
    const restaurantId = await this.restaurantId(record.restaurant);
    // A list the admin uploads is already curated.
    const curation = record.uploadedBy && record.status === "transcribed" ? "approved" : "pending";
    const list = await this.pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO wine_lists (restaurant_id, user_id, restaurant_name, city, address, latitude, longitude, source, status, model,
                               models_tried, usage, error_message, duration_ms, item_count, uploaded_by, curation_status,
                               reviewed_at, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17,
               CASE WHEN $17 = 'approved' THEN now() END, CASE WHEN $17 = 'approved' THEN $16::uuid END)
       RETURNING id, created_at`,
      [
        restaurantId, record.userId ?? null, clean(record.restaurant.name), clean(record.restaurant.city), clean(record.restaurant.address),
        coordinate(record.restaurant.latitude, 90), coordinate(record.restaurant.longitude, 180), record.source, record.status, record.model,
        JSON.stringify(record.attempts), JSON.stringify(record.usage), record.errorMessage?.slice(0, 1000) ?? null, record.durationMs, record.items.length,
        record.uploadedBy ?? null, curation,
      ],
    );
    const listId = list.rows[0].id;
    for (const [position, file] of record.files.entries()) {
      await this.pool.query(`INSERT INTO wine_list_files (wine_list_id, position, mime, file_data_url) VALUES ($1, $2, $3, $4)`, [listId, position, file.mimetype, file.dataUrl]);
    }
    await this.insertItems(listId, record.items);
    return (await this.findList(listId))!;
  }

  private async insertItems(listId: string, items: WineListItem[]) {
    if (!items.length) return;
    const values: unknown[] = [];
    const rows = items.map((item, position) => {
      const row = [listId, position, item.section, item.name, item.producer, item.vintage, item.country, item.region, item.grapes, item.style, item.volume, item.price, item.glassPrice, item.currency, item.notes];
      values.push(...row);
      const offset = position * row.length;
      return `(${row.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    await this.pool.query(
      `INSERT INTO wine_list_items (wine_list_id, position, section, name, producer, vintage, country, region, grapes, style, volume, price, glass_price, currency, notes)
       VALUES ${rows.join(", ")}`,
      values,
    );
  }

  /**
   * What a new transcription of a saved list needs: its files in page order, the
   * restaurant, the attempts and usage so far, and how many bottle checks it has
   * (checks point at its items, which a new transcription replaces).
   */
  async retranscriptionSource(listId: string) {
    const list = await this.pool.query<{ restaurantName: string | null; city: string | null; usage: OpenRouterUsage | null; checks: number }>(
      `SELECT coalesce(r.name, l.restaurant_name) AS "restaurantName", coalesce(r.city, l.city) AS city, l.usage,
              (SELECT count(*)::int FROM wine_list_checks c WHERE c.wine_list_id = l.id) AS checks
       FROM wine_lists l LEFT JOIN restaurants r ON r.id = l.restaurant_id WHERE l.id = $1 AND l.deleted_at IS NULL`,
      [listId],
    );
    if (!list.rows[0]) return null;
    const files = await this.pool.query<ListFile>(`SELECT mime AS mimetype, file_data_url AS "dataUrl" FROM wine_list_files WHERE wine_list_id = $1 ORDER BY position`, [listId]);
    return { ...list.rows[0], files: files.rows };
  }

  /**
   * Replaces the transcription of a saved list (admin "Transcrever novamente"):
   * same list, files, restaurant and sender. The new attempts are appended to the
   * old ones, so every billed attempt still counts in the AI costs.
   */
  async replaceTranscription(listId: string, record: Pick<ListRecord, "items" | "status" | "model" | "attempts" | "usage" | "errorMessage" | "durationMs">) {
    await this.pool.query(`DELETE FROM wine_list_items WHERE wine_list_id = $1`, [listId]);
    await this.insertItems(listId, record.items);
    await this.pool.query(
      `UPDATE wine_lists SET status = $2, model = $3, models_tried = models_tried || $4::jsonb, usage = $5::jsonb,
              error_message = $6, duration_ms = $7, item_count = $8
       WHERE id = $1`,
      [listId, record.status, record.model, JSON.stringify(record.attempts), JSON.stringify(record.usage), record.errorMessage?.slice(0, 1000) ?? null, record.durationMs, record.items.length],
    );
    return (await this.findList(listId))!;
  }

  async findList(id: string): Promise<SavedList | null> {
    const list = await this.pool.query<{ id: string; status: SavedList["status"]; source: SavedList["source"]; created_at: Date | string; restaurant_id: string | null; name: string | null; city: string | null; address: string | null }>(
      `SELECT l.id, l.status, l.source, l.created_at, r.id AS restaurant_id,
              coalesce(r.name, l.restaurant_name) AS name, coalesce(r.city, l.city) AS city, coalesce(r.address, l.address) AS address
       FROM wine_lists l LEFT JOIN restaurants r ON r.id = l.restaurant_id WHERE l.id = $1`,
      [id],
    );
    const row = list.rows[0];
    if (!row) return null;
    const items = await this.pool.query<SavedItem>(`SELECT ${ITEM_SELECT} FROM wine_list_items WHERE wine_list_id = $1 ORDER BY position`, [id]);
    return {
      id: row.id, status: row.status, source: row.source, createdAt: new Date(row.created_at).toISOString(),
      restaurant: { id: row.restaurant_id, name: row.name, city: row.city, address: row.address },
      items: items.rows,
    };
  }

  /** The user's latest wine lists, for the app history ("Seus restaurantes"). */
  async listsOf(userId: string) {
    const result = await this.pool.query(
      `SELECT l.id, l.created_at AS "createdAt", l.item_count AS "itemCount", l.status, r.id AS "restaurantId",
              coalesce(r.name, l.restaurant_name) AS "restaurantName", coalesce(r.city, l.city) AS city
       FROM wine_lists l LEFT JOIN restaurants r ON r.id = l.restaurant_id
       WHERE l.user_id = $1 AND l.status = 'transcribed' AND l.deleted_at IS NULL ORDER BY l.created_at DESC LIMIT 30`,
      [userId],
    );
    return result.rows;
  }

  /**
   * Whether the user may open the list and check bottles against it: the lists they
   * sent, and every published list (transcribed, not rejected by the curators) —
   * the lists the app offers for each restaurant. Deleted lists never open.
   */
  async canUse(listId: string, userId: string) {
    const result = await this.pool.query(
      `SELECT 1 FROM wine_lists WHERE id = $1 AND deleted_at IS NULL
         AND (user_id = $2 OR (status = 'transcribed' AND curation_status <> 'rejected'))`,
      [listId, userId],
    );
    return Boolean(result.rowCount);
  }

  /**
   * The restaurants that already have a wine list, for the first screen of the
   * app: each with its current list (the newest approved one, or else the newest
   * published), when it was sent, how many wines it has, the chain description
   * and the other cities of a restaurant with the same name. The user's own lists
   * count even before curation.
   */
  async restaurantsWithLists(userId: string, query = "") {
    const term = normalizeText(query);
    const result = await this.pool.query<RestaurantWithList>(
      `WITH visible AS (
         SELECT l.id, l.restaurant_id, l.created_at, l.item_count, l.curation_status = 'approved' AS approved, coalesce(l.user_id = $1, false) AS mine
         FROM wine_lists l
         WHERE l.deleted_at IS NULL AND l.status = 'transcribed' AND l.restaurant_id IS NOT NULL
           AND (l.curation_status <> 'rejected' OR l.user_id = $1)
       ), current AS (
         SELECT DISTINCT ON (restaurant_id) restaurant_id, id, created_at, item_count, approved, mine
         FROM visible ORDER BY restaurant_id, approved DESC, created_at DESC
       )
       SELECT r.id, r.name, r.city, r.address, r.network_note AS "networkNote",
              c.id AS "listId", c.created_at AS "updatedAt", c.item_count AS "itemCount", c.approved, c.mine,
              coalesce((SELECT array_agg(DISTINCT o.city ORDER BY o.city) FROM restaurants o
                        WHERE o.name_key = r.name_key AND o.id <> r.id AND o.city IS NOT NULL), '{}') AS "otherCities"
       FROM current c JOIN restaurants r ON r.id = c.restaurant_id
       WHERE $2 = '' OR r.name_key LIKE '%' || $2 || '%' OR lower(coalesce(r.city, '')) LIKE '%' || lower($3) || '%'
       ORDER BY r.name, r.city NULLS LAST
       LIMIT 100`,
      [userId, term, query.trim()],
    );
    return result.rows.map((row) => ({ ...row, updatedAt: new Date(row.updatedAt).toISOString() }));
  }

  async findItem(listId: string, itemId: string): Promise<SavedItem | null> {
    const result = await this.pool.query<SavedItem>(`SELECT ${ITEM_SELECT} FROM wine_list_items WHERE wine_list_id = $1 AND id = $2`, [listId, itemId]);
    return result.rows[0] ?? null;
  }

  async saveCheck(record: { listId: string; itemId: string; userId?: string | null; imageDataUrl: string; check: BottleCheck; errorMessage?: string | null; durationMs: number }) {
    const { check } = record;
    const result = await this.pool.query<{ id: string; created_at: Date }>(
      `INSERT INTO wine_list_checks (wine_list_id, item_id, user_id, image_data_url, verdict, confidence, observed, differences, explanation, model,
                                     models_tried, usage, error_message, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11::jsonb, $12::jsonb, $13, $14)
       RETURNING id, created_at`,
      [
        record.listId, record.itemId, record.userId ?? null, record.imageDataUrl, check.model ? check.verdict : null, check.confidence,
        JSON.stringify(check.observed), JSON.stringify(check.differences), check.explanation || null, check.model,
        JSON.stringify(check.attempts), JSON.stringify(check.usage), record.errorMessage ?? null, record.durationMs,
      ],
    );
    return { id: result.rows[0].id, createdAt: new Date(result.rows[0].created_at).toISOString() };
  }
}
