import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { SommelierAgent } from "../src/sommelier.service.js";
import { MAX_CONTEXT_ITEMS, SommelierWineLists, namesRestaurant, wineListInstructions, wineListLine, type WineListItemContext } from "../src/sommelier-wine-list.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";

const item = (overrides: Partial<WineListItemContext> = {}): WineListItemContext => ({
  section: "Tintos", name: "Catena Zapata Malbec Argentino", producer: "Catena Zapata", vintage: 2020, country: "Argentina", region: "Mendoza",
  grapes: "Malbec", style: null, volume: "750 ml", price: 489.9, glassPrice: null, currency: "BRL", notes: null, ...overrides,
});

describe("wine list lookup for the Sommelier (migrations 017 and 019)", () => {
  let db: PGlite;
  let lookup: SommelierWineLists;
  const read = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`create table catalog_wines (id uuid primary key default gen_random_uuid(), display_name text not null, images jsonb not null default '[]', updated_at timestamptz not null default now());
      create table unlisted_wine_scans (id uuid primary key default gen_random_uuid(), unlisted_code text not null unique, status text not null default 'needs_registration', image_data_url text not null, extracted_data jsonb not null default '{}', user_id uuid, registered_wine_id uuid references catalog_wines(id), created_at timestamptz not null default now());`);
    for (const name of ["014_unlisted_scan_dedup.sql", "015_wine_photo_pool.sql", "017_wine_lists.sql", "019_admin_wine_lists.sql", "020_wine_list_management.sql"]) await db.exec(read(name));
    lookup = new SommelierWineLists({ query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as pg.Pool);
  });

  async function restaurant(name: string, city = "São Paulo") {
    return (await db.query<{ id: string }>(`insert into restaurants (name, name_key, city) values ($1, lower($1), $2) returning id`, [name, city])).rows[0].id;
  }
  async function list(options: { restaurantId?: string | null; name?: string | null; user?: string | null; admin?: string | null; status?: string; createdAt?: string; items?: string[]; curation?: string; deleted?: boolean }) {
    const id = (await db.query<{ id: string }>(
      `insert into wine_lists (restaurant_id, user_id, uploaded_by, restaurant_name, source, status, item_count, created_at, curation_status, deleted_at)
       values ($1, $2, $3, $4, 'photo', $5, $6, coalesce($7::timestamptz, now()), $8, case when $9 then now() end) returning id`,
      [options.restaurantId ?? null, options.user === undefined ? USER : options.user, options.admin ?? null, options.name ?? null, options.status ?? "transcribed", options.items?.length ?? 0, options.createdAt ?? null, options.curation ?? "pending", options.deleted ?? false],
    )).rows[0].id;
    for (const [position, name] of (options.items ?? []).entries()) {
      await db.query(`insert into wine_list_items (wine_list_id, position, section, name, price, glass_price) values ($1, $2, 'Tintos', $3, $4, 45)`, [id, position, name, 100 + position]);
    }
    return id;
  }

  it("links conversations and answers to the list (migration 023, can run again)", async () => {
    await db.exec(`create table app_users (id uuid primary key);`);
    await db.exec(read("009_sommelier_agent.sql"));
    await db.exec(read("023_sommelier_wine_list.sql"));
    await db.exec(read("023_sommelier_wine_list.sql"));
    await db.query(`insert into app_users values ($1)`, [USER]);
    const id = await list({ name: "Fasano" });
    const conversation = (await db.query<{ id: string }>(`insert into sommelier_conversations (user_id, title, wine_list_id) values ($1, 'x', $2) returning id`, [USER, id])).rows[0].id;
    await db.query(`insert into sommelier_messages (conversation_id, role, content, wine_list_id) values ($1, 'assistant', 'ok', $2)`, [conversation, id]);
    const agent = new SommelierAgent({ query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as pg.Pool);
    expect(await agent.listConversations(USER)).toEqual([expect.objectContaining({ id: conversation, wineListId: id, wineListRestaurant: "Fasano" })]);
    await db.query(`delete from wine_lists where id = $1`, [id]);
    expect((await db.query(`select wine_list_id from sommelier_conversations`)).rows).toEqual([{ wine_list_id: null }]);
    expect((await db.query(`select wine_list_id from sommelier_messages`)).rows).toEqual([{ wine_list_id: null }]);
  });

  it("opens the user's own list with its wines in the order of the menu", async () => {
    const fasano = await restaurant("Fasano");
    const id = await list({ restaurantId: fasano, name: "fasano", items: ["Catena Malbec", "Chandon Brut"] });
    const found = await lookup.forUser(USER, id);
    expect(found).toMatchObject({ id, restaurantName: "Fasano", city: "São Paulo" });
    expect(found!.items.map((entry) => [entry.name, entry.price, entry.glassPrice, entry.currency])).toEqual([["Catena Malbec", 100, 45, "BRL"], ["Chandon Brut", 101, 45, "BRL"]]);
  });

  it("opens every published list (also sent by other users or the admin), never a rejected, deleted or failed one", async () => {
    const theirs = await list({ user: OTHER, name: "Tasca", items: ["Alamos"] });
    const approved = await list({ user: OTHER, name: "Tasca", items: ["Alamos"], curation: "approved" });
    const official = await list({ user: null, admin: ADMIN, name: "Tasca", items: ["Alamos"], curation: "approved" });
    const rejected = await list({ user: OTHER, name: "Tasca", curation: "rejected" });
    const deleted = await list({ user: OTHER, name: "Tasca", deleted: true });
    const failed = await list({ name: "Tasca", status: "failed" });
    for (const id of [theirs, approved, official]) expect(await lookup.forUser(USER, id)).toMatchObject({ id });
    for (const id of [rejected, deleted, failed]) expect(await lookup.forUser(USER, id)).toBeNull();
    // The user's own list opens even when the curators rejected it.
    expect(await lookup.forUser(USER, await list({ name: "Tasca", curation: "rejected" }))).not.toBeNull();
    expect(await lookup.forUser(USER, "not-a-uuid")).toBeNull();
  });

  it("finds the Café Viriato list another user sent when the customer says where they are (report of 30/09)", async () => {
    // Production: the approved list was sent by another user, and "Viriato Sul" was rejected.
    const cafe = await list({ user: OTHER, name: "Café Viriato", curation: "approved", items: ["Monte Paschoal Reserva Chardonnay", "Arte Malbec Rosé"] });
    await list({ user: OTHER, name: "Viriato Sul", curation: "rejected", items: ["Outro"] });
    const found = await lookup.mentioned(USER, "Estou aqui no café Viriato");
    expect(found?.id).toBe(cafe);
    expect((await lookup.mentioned(USER, "Ô meu sommelier, eu tô aqui no restaurante Viriato e eu pedi uma tilápia"))?.id).toBe(cafe);
    expect(found?.items.map((entry) => entry.name)).toEqual(["Monte Paschoal Reserva Chardonnay", "Arte Malbec Rosé"]);
  });

  it("finds the newest list of the restaurant named in the question", async () => {
    const fasano = await restaurant("Fasano");
    await list({ restaurantId: fasano, name: "Fasano", createdAt: "2026-09-01T20:00:00Z", items: ["Antigo"] });
    const newest = await list({ restaurantId: fasano, name: "Fasano", createdAt: "2026-09-20T20:00:00Z", items: ["Novo"] });
    await list({ name: "Bar do Zé", items: ["Outro"] });
    expect((await lookup.mentioned(USER, "Vou jantar no FASANO hoje, o que peço com risoto de funghi?"))?.id).toBe(newest);
    expect((await lookup.mentioned(USER, "no bar do ze tem vinho bom?"))?.items[0].name).toBe("Outro");
    expect(await lookup.mentioned(USER, "O que combina com risoto?")).toBeNull();
  });

  it("prefers the longest name and ignores rejected lists of other users", async () => {
    await list({ name: "Fasano", items: ["A"] });
    const rio = await list({ name: "Fasano Rio", items: ["B"] });
    await list({ user: OTHER, name: "Tasca Nova", items: ["C"], curation: "rejected" });
    expect((await lookup.mentioned(USER, "estou no fasano rio"))?.id).toBe(rio);
    expect(await lookup.mentioned(USER, "estou na Tasca Nova")).toBeNull();
  });
});

describe("namesRestaurant", () => {
  it("matches whole words, ignoring accents, case and punctuation", () => {
    expect(namesRestaurant("Jantar no D.O.M. hoje", "DOM")).toBe(false); // too short to be told from a word
    expect(namesRestaurant("Vou ao Mocotó!", "Mocoto")).toBe(true);
    expect(namesRestaurant("Vou ao Mocotozinho", "Mocotó")).toBe(false);
    expect(namesRestaurant("vou comer em casa", "Casa")).toBe(false);
    expect(namesRestaurant("Estou na Casa do Porco", "Casa do Porco")).toBe(true);
    // Customers leave out the kind of place (the Café Viriato voice message of 30/09).
    expect(namesRestaurant("eu tô aqui no restaurante Viriato e eu pedi uma tilápia", "Café Viriato")).toBe(true);
    expect(namesRestaurant("Jantar no Fasano", "Restaurante Fasano")).toBe(true);
    expect(namesRestaurant("quero um café depois do almoço", "Café Viriato")).toBe(false);
    expect(namesRestaurant("tem vinho no bar?", "Bar Brahma")).toBe(false);
    expect(namesRestaurant("quero carne de porco", "Casa do Porco")).toBe(false);
    expect(namesRestaurant("fui no dos", "Bar Dos")).toBe(false); // too short without the kind
  });
});

describe("wineListInstructions", () => {
  const context = (items: WineListItemContext[]) => ({ id: "l1", restaurantName: "Fasano", city: "São Paulo", createdAt: "2026-09-29T20:00:00Z", items });

  it("lists every wine by section with vintage, origin, grapes and prices, and the rules to recommend only from it", () => {
    const text = wineListInstructions(context([item(), item({ section: "Espumantes", name: "Chandon Brut", producer: "Chandon", vintage: null, country: "Brasil", region: null, grapes: null, price: null, glassPrice: 45, volume: null })]));
    expect(text).toContain("Carta de vinhos consultada: Fasano, São Paulo (transcrita em 29/09/2026, 2 vinho(s)).");
    expect(text).toContain("Recomende somente vinhos desta carta");
    expect(text).toContain("Nunca invente vinhos, safras ou preços");
    expect(text).toContain("## Tintos\n1. Catena Zapata Malbec Argentino 2020 | Mendoza, Argentina | Malbec | 750 ml | garrafa R$ 489,90");
    expect(text).toContain("## Espumantes\n2. Chandon Brut | Brasil | taça R$ 45,00");
  });

  it("names the producer only when the printed name does not have it, and keeps the item code", () => {
    expect(wineListLine(item({ name: "Malbec Argentino", notes: "Cod. 687", currency: "USD" }), 0)).toBe("1. Malbec Argentino 2020 | produtor Catena Zapata | Mendoza, Argentina | Malbec | 750 ml | garrafa US$ 489,90 | Cod. 687");
  });

  it("keeps long menus within the limit and says so", () => {
    const text = wineListInstructions(context(Array.from({ length: MAX_CONTEXT_ITEMS + 1 }, (_, index) => item({ name: `Vinho ${index + 1}` }))));
    expect(text).toContain(`abaixo estão os ${MAX_CONTEXT_ITEMS} primeiros`);
    expect(text).toContain(`${MAX_CONTEXT_ITEMS}. Vinho ${MAX_CONTEXT_ITEMS}`);
    expect(text).not.toContain(`Vinho ${MAX_CONTEXT_ITEMS + 1} `);
  });
});
