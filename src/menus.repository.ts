import type pg from "pg";
import type { ModelAttempt, OpenRouterUsage } from "./openrouter.js";
import type { MenuItem } from "./menu.service.js";
import type { ListFile } from "./wine-list.service.js";
import { resolveRestaurant, type RestaurantInput } from "./wine-lists.repository.js";

/** "Cardápios" (migration 026): the menus uploaded in the admin, with their files and dishes. */
export type SavedMenu = {
  id: string; status: "transcribed" | "failed"; source: "photo" | "pdf"; createdAt: string;
  restaurant: { id: string | null; name: string | null; city: string | null };
  items: (MenuItem & { id: string; position: number })[];
};
type MenuRecord = {
  uploadedBy?: string | null; restaurant: RestaurantInput; source: "photo" | "pdf"; files: ListFile[]; items: MenuItem[];
  status: "transcribed" | "failed"; model: string | null; attempts: ModelAttempt[]; usage: OpenRouterUsage; errorMessage?: string | null; durationMs: number;
};

const clean = (value: string | null | undefined) => value?.trim() ? value.trim().slice(0, 200) : null;

export class MenuRepository {
  constructor(private readonly pool: pg.Pool) {}

  async saveMenu(record: MenuRecord): Promise<SavedMenu> {
    const restaurantId = await resolveRestaurant(this.pool, record.restaurant);
    // A menu the admin uploads is already curated.
    const curation = record.uploadedBy && record.status === "transcribed" ? "approved" : "pending";
    const menu = await this.pool.query<{ id: string }>(
      `INSERT INTO restaurant_menus (restaurant_id, uploaded_by, restaurant_name, city, address, source, status, model, models_tried, usage,
                                     error_message, duration_ms, item_count, curation_status, reviewed_at, reviewed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13, $14,
               CASE WHEN $14 = 'approved' THEN now() END, CASE WHEN $14 = 'approved' THEN $2::uuid END)
       RETURNING id`,
      [
        restaurantId, record.uploadedBy ?? null, clean(record.restaurant.name), clean(record.restaurant.city), clean(record.restaurant.address),
        record.source, record.status, record.model, JSON.stringify(record.attempts), JSON.stringify(record.usage),
        record.errorMessage?.slice(0, 1000) ?? null, record.durationMs, record.items.length, curation,
      ],
    );
    const menuId = menu.rows[0].id;
    for (const [position, file] of record.files.entries()) {
      await this.pool.query(`INSERT INTO restaurant_menu_files (menu_id, position, mime, file_data_url) VALUES ($1, $2, $3, $4)`, [menuId, position, file.mimetype, file.dataUrl]);
    }
    await this.insertItems(menuId, record.items);
    return (await this.findMenu(menuId))!;
  }

  private async insertItems(menuId: string, items: MenuItem[]) {
    if (!items.length) return;
    const values: unknown[] = [];
    const rows = items.map((item, position) => {
      const row = [menuId, position, item.section, item.name, item.description, item.price, item.currency, item.notes];
      values.push(...row);
      const offset = position * row.length;
      return `(${row.map((_, index) => `$${offset + index + 1}`).join(", ")})`;
    });
    await this.pool.query(
      `INSERT INTO restaurant_menu_items (menu_id, position, section, name, description, price, currency, notes) VALUES ${rows.join(", ")}`,
      values,
    );
  }

  /** The files of a saved menu in page order, its restaurant and the usage so far ("Transcrever novamente"). */
  async retranscriptionSource(menuId: string) {
    const menu = await this.pool.query<{ restaurantName: string | null; city: string | null; usage: OpenRouterUsage | null }>(
      `SELECT coalesce(r.name, m.restaurant_name) AS "restaurantName", coalesce(r.city, m.city) AS city, m.usage
       FROM restaurant_menus m LEFT JOIN restaurants r ON r.id = m.restaurant_id WHERE m.id = $1 AND m.deleted_at IS NULL`,
      [menuId],
    );
    if (!menu.rows[0]) return null;
    const files = await this.pool.query<ListFile>(`SELECT mime AS mimetype, file_data_url AS "dataUrl" FROM restaurant_menu_files WHERE menu_id = $1 ORDER BY position`, [menuId]);
    return { ...menu.rows[0], files: files.rows };
  }

  async replaceTranscription(menuId: string, record: Pick<MenuRecord, "items" | "status" | "model" | "attempts" | "usage" | "errorMessage" | "durationMs">) {
    await this.pool.query(`DELETE FROM restaurant_menu_items WHERE menu_id = $1`, [menuId]);
    await this.insertItems(menuId, record.items);
    await this.pool.query(
      `UPDATE restaurant_menus SET status = $2, model = $3, models_tried = models_tried || $4::jsonb, usage = $5::jsonb, error_message = $6,
              duration_ms = $7, item_count = $8 WHERE id = $1`,
      [menuId, record.status, record.model, JSON.stringify(record.attempts), JSON.stringify(record.usage), record.errorMessage?.slice(0, 1000) ?? null, record.durationMs, record.items.length],
    );
    return (await this.findMenu(menuId))!;
  }

  async findMenu(id: string): Promise<SavedMenu | null> {
    const menu = (await this.pool.query<{ id: string; status: SavedMenu["status"]; source: SavedMenu["source"]; created_at: Date | string; restaurant_id: string | null; name: string | null; city: string | null }>(
      `SELECT m.id, m.status, m.source, m.created_at, m.restaurant_id, coalesce(r.name, m.restaurant_name) AS name, coalesce(r.city, m.city) AS city
       FROM restaurant_menus m LEFT JOIN restaurants r ON r.id = m.restaurant_id WHERE m.id = $1`,
      [id],
    )).rows[0];
    if (!menu) return null;
    const items = await this.pool.query<MenuItem & { id: string; position: number }>(
      `SELECT id, position, section, name, description, price::float8 AS price, currency, notes FROM restaurant_menu_items WHERE menu_id = $1 ORDER BY position`,
      [id],
    );
    return {
      id: menu.id, status: menu.status, source: menu.source, createdAt: new Date(menu.created_at).toISOString(),
      restaurant: { id: menu.restaurant_id, name: menu.name, city: menu.city }, items: items.rows,
    };
  }
}
