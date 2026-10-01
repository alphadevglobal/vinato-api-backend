import { describe, expect, it } from "vitest";
import { MenuRepository } from "../src/menus.repository.js";
import { PgSommelierKnowledge } from "../src/sommelier-knowledge.js";
import { fullDatabase } from "./helpers/full-db.js";

async function seed() {
  const { db, pool } = await fullDatabase();
  const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
  const user = await one<{ id: string }>(`insert into app_users (email, display_name, plan, password_hash) values ('ana@v.t', 'Ana', 'premium', 'x') returning id`);
  const wine = async (name: string, extra: Record<string, unknown> = {}) => (await one<{ id: string }>(
    `insert into catalog_wines (display_name, producer_manufacturer, vintage, color, region, country, grapes, aging_potential, curation_status)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9) returning id`,
    [name, extra.producer ?? null, extra.vintage ?? null, extra.color ?? "Red", extra.region ?? null, extra.country ?? null, JSON.stringify(extra.grapes ?? []), extra.aging ?? null, extra.status ?? "approved"]))!.id;
  const almaviva = await wine("Almaviva", { producer: "Viña Almaviva", vintage: 2017, region: "Puente Alto", country: "Chile", grapes: [{ name: "Cabernet Sauvignon" }], aging: "Até 2040" });
  const soalheiro = await wine("Soalheiro Alvarinho", { producer: "Soalheiro", vintage: 2023, color: "White", region: "Vinho Verde", country: "Portugal", aging: "3 a 5 anos" });
  await wine("Soalheiro Primeiras Vinhas", { producer: "Soalheiro", status: "pending" });
  await db.query(`insert into user_cellars (user_id, wine_id, quantity) values ($1, $2, 2)`, [user!.id, almaviva]);
  await db.query(`insert into user_favorites (user_id, wine_id) values ($1, $2)`, [user!.id, soalheiro]);
  await db.query(`insert into wine_reviews (wine_id, user_id, rating, comment) values ($1, $2, 4.5, 'Mineral e fresco')`, [soalheiro, user!.id]);
  await db.query(`insert into user_scan_history (user_id, wine_id, status, result) values ($1, $2, 'success', '{}')`, [user!.id, almaviva]);
  const merchant = await one<{ id: string }>(`insert into wine_merchants (name, website_url, active) values ('Mistral', 'https://mistral.com.br', true) returning id`);
  await db.query(`insert into wine_offers (wine_id, merchant_id, product_name, product_url, price, currency, in_stock, hidden, last_seen_at) values ($1, $2, 'Soalheiro', 'https://x', 159.9, 'BRL', true, false, now())`, [soalheiro, merchant!.id]);
  return { db, pool, userId: user!.id, one };
}

describe("PgSommelierKnowledge", () => {
  it("gives the Sommelier the customer's cellar, favourites, reviews, scans and the catalog wines the question names", async () => {
    const { pool, userId } = await seed();
    const text = await new PgSommelierKnowledge(pool).forUser(userId, "O Soalheiro Alvarinho vai bem com polvo?");
    expect(text).toContain("Cliente: Ana (membro VINATO Premium).");
    expect(text).toContain("- Almaviva 2017 | Red | Puente Alto, Chile | guarda: Até 2040 | 2 garrafa(s)");
    expect(text).toContain("Vinhos favoritos do cliente: Soalheiro Alvarinho 2023.");
    expect(text).toContain('- Soalheiro Alvarinho: 4.5 — "Mineral e fresco"');
    expect(text).toContain("Últimos rótulos que o cliente escaneou: Almaviva (");
    expect(text).toContain("- Soalheiro Alvarinho 2023 | produtor Soalheiro | Vinho Verde, Portugal | White | tempo de guarda: 3 a 5 anos | nota dos usuários 4.5/5 (1 avaliações) | a partir de R$ 159,90 em Mistral");
    // Only approved catalog wines are offered as facts.
    expect(text).not.toContain("Primeiras Vinhas");
  });

  it("lists the partner restaurants and reads the menu of the restaurant", async () => {
    const { pool, userId, one } = await seed();
    const menus = new MenuRepository(pool);
    const saved = await menus.saveMenu({
      uploadedBy: null, restaurant: { name: "Café Viriato", city: "Lisboa" }, source: "photo", files: [{ mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,AAAA" }],
      items: [
        { section: "Peixes", name: "Tilápia grelhada", description: "manteiga de limão", price: 92, currency: "BRL", notes: null },
        { section: "Sobremesas", name: "Pastel de nata", description: null, price: 18, currency: "BRL", notes: null },
      ],
      status: "transcribed", model: "m", attempts: [], usage: {}, durationMs: 10,
    });
    expect(saved.items.map((item) => item.name)).toEqual(["Tilápia grelhada", "Pastel de nata"]);
    expect(saved.restaurant.name).toBe("Café Viriato");

    const knowledge = new PgSommelierKnowledge(pool);
    expect(await knowledge.forUser(userId, "oi")).toContain("- Café Viriato | Lisboa | cardápio");
    const named = await knowledge.menuMentioned("estou no restaurante Viriato, o que peço com a tilápia?");
    expect(named).toMatchObject({ id: saved.id, restaurantName: "Café Viriato", city: "Lisboa", items: [{ name: "Tilápia grelhada", description: "manteiga de limão", price: 92 }, { name: "Pastel de nata" }] });
    expect((await knowledge.menuOfRestaurant(saved.restaurant.id, null))?.id).toBe(saved.id);
    expect(await knowledge.menuMentioned("o que combina com pizza?")).toBeNull();

    // A deleted or rejected menu is never read.
    await one(`update restaurant_menus set curation_status = 'rejected' where id = $1`, [saved.id]);
    expect(await knowledge.menuById(saved.id)).toBeNull();
  });

  it("replaces the dishes when the admin transcribes the menu again", async () => {
    const { pool } = await seed();
    const menus = new MenuRepository(pool);
    const saved = await menus.saveMenu({ uploadedBy: "00000000-0000-4000-8000-000000000001", restaurant: { name: "Fasano" }, source: "pdf", files: [{ mimetype: "application/pdf", dataUrl: "data:application/pdf;base64,AAAA" }],
      items: [], status: "failed", model: null, attempts: [], usage: { totalTokens: 10 }, durationMs: 5 });
    const source = await menus.retranscriptionSource(saved.id);
    expect(source).toMatchObject({ restaurantName: "Fasano", files: [{ mimetype: "application/pdf" }], usage: { totalTokens: 10 } });
    const again = await menus.replaceTranscription(saved.id, { items: [{ section: null, name: "Risoto", description: null, price: 120, currency: "BRL", notes: null }], status: "transcribed", model: "m", attempts: [], usage: { totalTokens: 30 }, errorMessage: null, durationMs: 9 });
    expect(again).toMatchObject({ status: "transcribed", items: [{ name: "Risoto", price: 120 }] });
  });
});
