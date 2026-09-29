import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { parseJsonContent, requestJsonWithFallback, totalUsage } from "../src/openrouter.js";
import { bottleCheckPrompt, mergePages, withoutRepeatedProducer, money, normalizeCheck, normalizeItems, OpenRouterWineListAgent, transcriptionPrompt, type WineListItem } from "../src/wine-list.service.js";
import { WineListRepository } from "../src/wine-lists.repository.js";

const item: WineListItem = {
  section: "Tintos", name: "Catena Zapata Malbec Argentino", producer: "Catena Zapata", vintage: 2020, country: "Argentina", region: "Mendoza",
  grapes: "Malbec", style: "tinto", volume: "750 ml", price: 489.9, glassPrice: null, currency: "BRL", notes: null,
};
const reply = (content: unknown, usage = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500, cost: 0.002 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage }), { status: 200 });
const originalKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("openrouter helpers", () => {
  it("parses JSON answers with fences or surrounding text", () => {
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonContent('Aqui está: {"a": [1]} ok')).toEqual({ a: [1] });
    expect(parseJsonContent([{ text: '{"b":2}' }])).toEqual({ b: 2 });
    expect(parseJsonContent("sem json")).toBeNull();
    expect(parseJsonContent("[1,2]")).toBeNull();
  });

  it("falls back when the primary answer is rejected, recording every billed attempt", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reply({ items: [] }))
      .mockResolvedValueOnce(reply({ items: [{ name: "X" }] }, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestJsonWithFallback({ model: "primary", fallbackModel: "fallback" }, [{ type: "text", text: "x" }], { apiKey: "k", accept: (json) => Array.isArray(json.items) && json.items.length > 0 });
    expect(result.model).toBe("fallback");
    expect(result.attempts.map((attempt) => [attempt.model, attempt.ok])).toEqual([["primary", false], ["fallback", true]]);
    expect(totalUsage(result.attempts)).toEqual({ promptTokens: 1010, completionTokens: 505, totalTokens: 1515, costUsd: 0.003 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: "primary", reasoning: { effort: "low" }, response_format: { type: "json_object" }, usage: { include: true } });
  });

  it("reports a timeout while the answer body is still arriving, instead of throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); } })));
    const result = await requestJsonWithFallback({ model: "slow", fallbackModel: "fast" }, [{ type: "text", text: "x" }], { apiKey: "k" });
    expect(result.attempts.map((attempt) => [attempt.model, attempt.status, attempt.error])).toEqual([["slow", 408, "request_timeout"], ["fast", 408, "request_timeout"]]);
  });

  it("reports an answer cut by the token limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"items": [' } }] }))));
    const result = await requestJsonWithFallback({ model: "m", fallbackModel: "m" }, [{ type: "text", text: "x" }], { apiKey: "k" });
    expect(result.json).toBeNull();
    expect(result.attempts).toEqual([expect.objectContaining({ model: "m", ok: false, error: "answer_cut_by_token_limit" })]);
  });
});

describe("wine list transcription", () => {
  it("reads prices the way restaurants print them", () => {
    expect(money("R$ 1.289,90")).toBe(1289.9);
    expect(money("289,5")).toBe(289.5);
    expect(money("1,289.90")).toBe(1289.9);
    expect(money(95)).toBe(95);
    expect(money("sob consulta")).toBeNull();
    expect(money(-3)).toBeNull();
  });

  it("normalizes the transcribed items and drops entries without a name", () => {
    expect(normalizeItems([
      { section: "Tintos", name: "Catena Zapata Malbec Argentino", producer: "Catena Zapata", vintage: "Safra 2020", price: "R$ 489,90", glassPrice: "null", currency: "brl", grapes: ["Malbec"] },
      { name: "  ", producer: null },
      { producer: "Miolo", wine: "Lote 43", vintage: 2099, price: 250 },
      "texto solto",
    ])).toEqual([
      { section: "Tintos", name: "Catena Zapata Malbec Argentino", producer: "Catena Zapata", vintage: 2020, country: null, region: null, grapes: "Malbec", style: null, volume: null, price: 489.9, glassPrice: null, currency: "BRL", notes: null },
      { section: null, name: "Miolo Lote 43", producer: "Miolo", vintage: null, country: null, region: null, grapes: null, style: null, volume: null, price: 250, glassPrice: null, currency: "BRL", notes: null },
    ]);
  });

  it("asks for every wine with section and prices, and uses the restaurant the user typed", () => {
    const prompt = transcriptionPrompt({ restaurantName: "Fasano", city: "São Paulo" });
    expect(prompt).toContain("Transcreva TODOS os vinhos");
    expect(prompt).toContain("Restaurante informado pelo cliente: Fasano (São Paulo)");
    expect(prompt).toContain("glassPrice");
    expect(prompt).toContain("SEM codigo/numero do item, safra, regiao, volume ou preco");
    expect(prompt).toContain("Nao repita o produtor no nome");
    expect(prompt).toContain("Omita os campos que nao estiverem na carta");
    expect(transcriptionPrompt({})).not.toContain("Restaurante informado");
    expect(transcriptionPrompt({}, { index: 3, total: 8 })).toContain("Esta imagem e a pagina 3 de 8 da carta. Transcreva TODOS os vinhos DESTA pagina");
  });

  it("sends photos as images and a PDF as a file, and returns the items", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    const fetchMock = vi.fn(async () => reply({ restaurant: { name: "Bistrô", city: "Recife" }, items: [{ name: "Casa Valduga Terroir", price: "180" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const agent = new OpenRouterWineListAgent({ getWineListModels: async () => ({ model: "vision", fallbackModel: "vision" }) });

    const fromPdf = await agent.transcribe([{ mimetype: "application/pdf", dataUrl: "data:application/pdf;base64,JVBE" }], {});
    const call = (index: number) => JSON.parse(String((fetchMock.mock.calls[index] as unknown as [string, RequestInit])[1].body));
    const content = call(0).messages[0].content;
    expect(content[1]).toEqual({ type: "file", file: { filename: "carta-1.pdf", file_data: "data:application/pdf;base64,JVBE" } });
    expect(fromPdf).toMatchObject({ restaurant: { name: "Bistrô", city: "Recife" }, model: "vision", items: [{ name: "Casa Valduga Terroir", price: 180 }], usage: { totalTokens: 1500 } });

    expect(call(0).max_tokens).toBeGreaterThanOrEqual(16000);

    // Photos: one call per page, each with its own image.
    await agent.transcribe([{ mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA" }, { mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,BB" }], {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(call(1).messages[0].content.slice(1)).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } }]);
    expect(call(2).messages[0].content.slice(1)).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BB" } }]);
    expect(call(1).messages[0].content[0].text).toContain("pagina 1 de 2");
  });

  it("reads a long list page by page in parallel, keeps the page order and drops overlaps between pages", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    const pages: Record<string, unknown> = {
      AA: { restaurant: { name: "Bistrô" }, items: [{ section: "Espumantes", name: "Chandon Réserve Brut", price: "179,00" }, { name: "Valduga Arte Brut", price: 159 }] },
      BB: { items: [{ name: "Valduga Arte Brut", price: 159 }, { section: "Chile · Tintos", name: "La Joya Gran Reserva Cabernet Sauvignon", price: 235, notes: "Cod. 661" }] },
      CC: { items: [] },
    };
    let inFlight = 0; let maxInFlight = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      const url: string = JSON.parse(String(init.body)).messages[0].content[1].image_url.url;
      return reply(pages[url.split(",")[1]]);
    }));
    const agent = new OpenRouterWineListAgent({ getWineListModels: async () => ({ model: "vision", fallbackModel: "backup" }) });
    const result = await agent.transcribe(["AA", "BB", "CC"].map((page) => ({ mimetype: "image/jpeg", dataUrl: `data:image/jpeg;base64,${page}` })), {});
    expect(maxInFlight).toBe(3);
    expect(result.items.map((wine) => wine.name)).toEqual(["Chandon Réserve Brut", "Valduga Arte Brut", "La Joya Gran Reserva Cabernet Sauvignon"]);
    expect(result).toMatchObject({ restaurant: { name: "Bistrô" }, unreadPages: [], pages: 3, usage: { totalTokens: 4500 } });
    // A page without wines (cover, corkage) is a valid answer, not a reason for the fallback.
    expect(result.attempts.map((attempt) => [attempt.page, attempt.model, attempt.ok])).toEqual([[1, "vision", true], [2, "vision", true], [3, "vision", true]]);
  });

  it("returns the pages it could read and reports the others", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const url: string = JSON.parse(String(init.body)).messages[0].content[1].image_url.url;
      return url.endsWith("BB") ? new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"items": [' } }] })) : reply({ items: [{ name: "Casa Valduga Terroir", price: 180 }] });
    }));
    const agent = new OpenRouterWineListAgent({ getWineListModels: async () => ({ model: "vision", fallbackModel: "backup" }) });
    const result = await agent.transcribe(["AA", "BB"].map((page) => ({ mimetype: "image/jpeg", dataUrl: `data:image/jpeg;base64,${page}` })), {});
    expect(result.items).toHaveLength(1);
    expect(result.unreadPages).toEqual([2]);
    expect(result.attempts.filter((attempt) => attempt.page === 2).map((attempt) => [attempt.model, attempt.error])).toEqual([["vision", "answer_cut_by_token_limit"], ["backup", "answer_cut_by_token_limit"]]);
  });

  it("never runs past the deadline: the fallback is skipped when there is no time left", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    const fetchMock = vi.fn(async () => new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await requestJsonWithFallback({ model: "vision", fallbackModel: "backup" }, [{ type: "text", text: "x" }], { deadline: Date.now() + 5_000, page: 4 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.attempts).toEqual([{ model: "vision", ok: false, ms: 0, status: 408, error: "no_time_left", page: 4 }]);
  });

  it("drops a producer the model repeated in front of the printed name", () => {
    expect(withoutRepeatedProducer("Casa Valduga Casa Valduga Origem Chardonnay", "Casa Valduga")).toBe("Casa Valduga Origem Chardonnay");
    expect(withoutRepeatedProducer("Viña Morandé Morandé Pionero Reserva Chardonnay", "Viña Morandé")).toBe("Morandé Pionero Reserva Chardonnay");
    expect(withoutRepeatedProducer("Los Vascos ( Rothschild - Lafite ) Los Vascos Albariño", "Los Vascos ( Rothschild - Lafite )")).toBe("Los Vascos Albariño");
    // A producer written once is part of the name.
    expect(withoutRepeatedProducer("Casa Valduga Arte Brut Tradicional", "Casa Valduga")).toBe("Casa Valduga Arte Brut Tradicional");
    expect(withoutRepeatedProducer("Bisquertt Family Vineyards La Joya Gran Reserva", "Bisquertt Family Vineyards")).toBe("Bisquertt Family Vineyards La Joya Gran Reserva");
  });

  it("keeps a wine repeated inside a page and removes only the overlap with the previous page", () => {
    const wine = (name: string, price: number | null = null) => ({ ...item, name, price, vintage: null, volume: null });
    // Page 3 repeats a wine of page 1 but not of page 2: it is a new entry, not an overlap.
    expect(mergePages([[wine("Taça A", 30), wine("Taça A", 30)], [wine("Taça A", 30), wine("Tinto B", 90)], [wine("Tinto B", 90), wine("Rosé C", 70)], [wine("Taça A", 30)]]).map((entry) => entry.name))
      .toEqual(["Taça A", "Taça A", "Tinto B", "Rosé C", "Taça A"]);
  });
});

describe("bottle check", () => {
  it("asks for a strict comparison of producer, line, vintage and volume", () => {
    const prompt = bottleCheckPrompt(item);
    expect(prompt).toContain('"name":"Catena Zapata Malbec Argentino"');
    expect(prompt).toContain("Reserva, Gran Reserva");
    expect(prompt).toContain('"mismatch"');
  });

  it("treats a match that lists differences as a mismatch and unknown verdicts as uncertain", () => {
    expect(normalizeCheck({ verdict: "match", confidence: 0.9, differences: [{ field: "vintage", menu: "2020", bottle: "2021" }], explanation: "Safra diferente." }))
      .toMatchObject({ verdict: "mismatch", differences: [{ field: "vintage", menu: "2020", bottle: "2021" }] });
    expect(normalizeCheck({ verdict: "talvez" })).toMatchObject({ verdict: "uncertain", confidence: 0, explanation: "Não foi possível ler o rótulo com segurança." });
    expect(normalizeCheck({ verdict: "match", confidence: 3, observed: { producer: "Catena Zapata", vintage: 2020 } }))
      .toMatchObject({ verdict: "match", confidence: 1, observed: { producer: "Catena Zapata", vintage: "2020", wine: null } });
  });

  it("compares the bottle photo with the chosen item", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ verdict: "mismatch", confidence: 0.85, observed: { producer: "Catena", wine: "Malbec", vintage: "2021" }, differences: [{ field: "vintage", menu: "2020", bottle: "2021" }], explanation: "A safra servida é 2021." })));
    const agent = new OpenRouterWineListAgent({ getWineListModels: async () => ({ model: "vision", fallbackModel: "vision" }) });
    expect(await agent.checkBottle(item, "data:image/jpeg;base64,AA")).toMatchObject({ verdict: "mismatch", model: "vision", explanation: "A safra servida é 2021.", usage: { totalTokens: 1500 } });
  });

  it("returns an uncertain check without a model when every attempt fails", async () => {
    process.env.OPENROUTER_API_KEY = "k";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const agent = new OpenRouterWineListAgent({ getWineListModels: async () => ({ model: "a", fallbackModel: "b" }) });
    const check = await agent.checkBottle(item, "data:x");
    expect(check).toMatchObject({ verdict: "uncertain", model: null });
    expect(check?.attempts).toHaveLength(2);
  });
});

describe("WineListRepository (migration 017)", () => {
  let db: PGlite;
  let repository: WineListRepository;
  const read = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`create table catalog_wines (id uuid primary key default gen_random_uuid(), display_name text not null, images jsonb not null default '[]', updated_at timestamptz not null default now());
      create table unlisted_wine_scans (id uuid primary key default gen_random_uuid(), unlisted_code text not null unique, status text not null default 'needs_registration', image_data_url text not null, extracted_data jsonb not null default '{}', user_id uuid, registered_wine_id uuid references catalog_wines(id), created_at timestamptz not null default now());`);
    for (const name of ["014_unlisted_scan_dedup.sql", "015_wine_photo_pool.sql", "017_wine_lists.sql", "019_admin_wine_lists.sql"]) await db.exec(read(name));
    // node-pg style adapter over PGlite.
    const pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as pg.Pool;
    repository = new WineListRepository(pool);
  });

  const record = (overrides: Partial<Parameters<WineListRepository["saveList"]>[0]> = {}) => ({
    userId: "11111111-1111-4111-8111-111111111111", restaurant: { name: "Fasano ", city: "São Paulo", latitude: -23.56, longitude: -46.67 },
    source: "photo" as const, files: [{ mimetype: "image/jpeg", dataUrl: `data:image/jpeg;base64,${Buffer.alloc(300, 1).toString("base64")}` }],
    items: [item, { ...item, name: "Salentein Reserve Malbec", producer: "Salentein", vintage: null, price: null, glassPrice: 55 }],
    status: "transcribed" as const, model: "vision", attempts: [{ model: "vision", ok: true, ms: 1200, totalTokens: 1500 }], usage: { totalTokens: 1500 }, durationMs: 1300,
    ...overrides,
  });

  it("saves the list with its restaurant, files and items in the order of the menu", async () => {
    const saved = await repository.saveList(record());
    expect(saved).toMatchObject({ status: "transcribed", source: "photo", restaurant: { name: "Fasano", city: "São Paulo" } });
    expect(saved.items.map((entry) => [entry.position, entry.name, entry.price, entry.glassPrice])).toEqual([[0, "Catena Zapata Malbec Argentino", 489.9, null], [1, "Salentein Reserve Malbec", null, 55]]);
    const file = (await db.query<{ file_bytes: number }>(`select file_bytes::float8 as file_bytes from wine_list_files`)).rows[0];
    expect(file.file_bytes).toBe(300);
    const list = (await db.query<{ item_count: number; usage: unknown; latitude: string }>(`select item_count, usage, latitude::text from wine_lists`)).rows[0];
    expect(list).toEqual({ item_count: 2, usage: { totalTokens: 1500 }, latitude: "-23.56" });
  });

  it("reuses the restaurant with the same name and city, ignoring accents and case", async () => {
    await repository.saveList(record());
    await repository.saveList(record({ restaurant: { name: "FASANO", city: "são paulo ", address: "Rua Vittorio Fasano, 88" } }));
    await repository.saveList(record({ restaurant: { name: "Fasano", city: "Rio de Janeiro" } }));
    const restaurants = (await db.query<{ name: string; city: string; address: string | null }>(`select name, city, address from restaurants order by city`)).rows;
    expect(restaurants).toEqual([{ name: "Fasano", city: "Rio de Janeiro", address: null }, { name: "Fasano", city: "São Paulo", address: "Rua Vittorio Fasano, 88" }]);
  });

  it("keeps lists without a restaurant name, and failed transcriptions for the audit", async () => {
    const saved = await repository.saveList(record({ restaurant: {}, items: [], status: "failed", errorMessage: "vision: invalid_json_answer" }));
    expect(saved).toMatchObject({ status: "failed", restaurant: { id: null, name: null }, items: [] });
    expect((await repository.listsOf("11111111-1111-4111-8111-111111111111"))).toEqual([]);
  });

  it("lists the user's transcribed lists and finds items only inside their list", async () => {
    const saved = await repository.saveList(record());
    const [first] = await repository.listsOf("11111111-1111-4111-8111-111111111111");
    expect(first).toMatchObject({ id: saved.id, itemCount: 2, restaurantName: "Fasano", city: "São Paulo" });
    expect(await repository.findItem(saved.id, saved.items[0].id)).toMatchObject({ name: "Catena Zapata Malbec Argentino" });
    const other = await repository.saveList(record());
    expect(await repository.findItem(other.id, saved.items[0].id)).toBeNull();
  });

  it("saves the bottle check with verdict, differences and usage", async () => {
    const saved = await repository.saveList(record());
    await repository.saveCheck({
      listId: saved.id, itemId: saved.items[0].id, userId: null, imageDataUrl: "data:image/jpeg;base64,AA", durationMs: 900,
      check: { verdict: "mismatch", confidence: 0.8, explanation: "Safra 2021.", observed: { producer: "Catena", wine: null, vintage: "2021", region: null, country: null, volume: null }, differences: [{ field: "vintage", menu: "2020", bottle: "2021" }], model: "vision", attempts: [], usage: { totalTokens: 700 } },
    });
    const check = (await db.query(`select verdict, differences, usage, explanation from wine_list_checks`)).rows[0];
    expect(check).toEqual({ verdict: "mismatch", differences: [{ field: "vintage", menu: "2020", bottle: "2021" }], usage: { totalTokens: 700 }, explanation: "Safra 2021." });
  });

  it("keeps the admin's list apart from the users' and lets every user open it", async () => {
    const owner = "11111111-1111-4111-8111-111111111111", stranger = "22222222-2222-4222-8222-222222222222", admin = "33333333-3333-4333-8333-333333333333";
    const mine = await repository.saveList(record());
    const official = await repository.saveList(record({ userId: null, uploadedBy: admin, restaurant: { id: mine.restaurant.id, name: "Outro nome" } }));
    expect(official.restaurant).toMatchObject({ id: mine.restaurant.id, name: "Fasano" });
    const row = (await db.query(`select user_id, uploaded_by, curation_status, reviewed_by from wine_lists where id = $1`, [official.id])).rows[0];
    expect(row).toEqual({ user_id: null, uploaded_by: admin, curation_status: "approved", reviewed_by: admin });
    expect(await repository.canUse(mine.id, owner)).toBe(true);
    expect(await repository.canUse(mine.id, stranger)).toBe(false);
    expect(await repository.canUse(official.id, stranger)).toBe(true);
    expect(await repository.restaurantExists(mine.restaurant.id!)).toBe(true);
    expect(await repository.restaurantExists(stranger)).toBe(false);
    expect((await repository.listsOf(owner)).map((list) => list.restaurantId)).toEqual([mine.restaurant.id]);
  });

  it("creates the default wine list AI model", async () => {
    expect((await db.query(`select model, fallback_model from wine_list_agent_config`)).rows).toEqual([{ model: "google/gemini-3.8-flash", fallback_model: "google/gemini-3.1-flash-lite" }]);
  });
});

describe("wine list routes", () => {
  const user = (plan: "free" | "premium") => ({ id: "user-1", email: "a@b.c", displayName: "A", role: "user", plan, planExpiresAt: null, status: "active", avatarUrl: null });
  const LIST = "aaaaaaaa-0000-4000-8000-000000000001", ITEM = "aaaaaaaa-0000-4000-8000-000000000002", OTHER = "aaaaaaaa-0000-4000-8000-000000000099";
  const RESTAURANT = "aaaaaaaa-0000-4000-8000-000000000003";
  const saved = { id: LIST, status: "transcribed", source: "photo", createdAt: "2026-09-29T00:00:00.000Z", restaurant: { id: "r1", name: "Fasano", city: "São Paulo", address: null }, items: [{ ...item, id: ITEM, position: 0 }] };
  function appFor(plan: "free" | "premium", overrides: { items?: WineListItem[]; checkModel?: string | null; unreadPages?: number[]; attempts?: object[] } = {}) {
    const transcribe = vi.fn(async () => ({ restaurant: { name: "Fasano", city: null }, items: overrides.items ?? [item], model: "vision", attempts: overrides.attempts ?? [], usage: { totalTokens: 1500 }, unreadPages: overrides.unreadPages ?? [], pages: 2 }));
    const checkBottle = vi.fn(async () => ({ verdict: "match" as const, confidence: 0.9, explanation: "Confere.", observed: { producer: "Catena Zapata", wine: "Malbec Argentino", vintage: "2020", region: null, country: null, volume: null }, differences: [], model: overrides.checkModel === undefined ? "vision" : overrides.checkModel, attempts: [], usage: {} }));
    const repository = {
      saveList: vi.fn(async () => saved), findList: vi.fn(async (id: string) => id === LIST ? saved : null), listsOf: vi.fn(async () => [{ id: LIST }]),
      findItem: vi.fn(async (_list: string, id: string) => id === ITEM ? saved.items[0] : null), saveCheck: vi.fn(async () => ({ id: "check-1", createdAt: "2026-09-29T00:00:00.000Z" })),
      canUse: vi.fn(async (id: string) => id === LIST), restaurantExists: vi.fn(async (id: string) => id === RESTAURANT),
    };
    const adminSessions = { adminFor: vi.fn(async (token: string) => token === "admin-token" ? { userId: "admin-1", role: "admin" } : null) };
    const accountRepository = { getUser: vi.fn(async () => user(plan)) };
    const app = createApp({ wineRepository: {} as never, wineScanner: {} as never, accountRepository: accountRepository as never, adminSessions: adminSessions as never, wineLists: { agent: { transcribe, checkBottle }, repository } as never });
    return { app, transcribe, checkBottle, repository };
  }

  it("transcribes the photos of a list for Premium members", async () => {
    const { app, transcribe, repository } = appFor("premium");
    const response = await request(app).post("/wine-lists").set("Authorization", "Bearer t")
      .field("restaurantName", "Fasano").field("city", "São Paulo").field("latitude", "-23,56")
      .attach("files", Buffer.from("page1"), { filename: "p1.jpg", contentType: "image/jpeg" })
      .attach("files", Buffer.from("page2"), { filename: "p2.jpg", contentType: "image/jpeg" })
      .expect(201);
    expect(response.body).toMatchObject({ id: LIST, items: [{ id: ITEM, name: "Catena Zapata Malbec Argentino" }] });
    expect(transcribe.mock.calls[0][0]).toHaveLength(2);
    expect(transcribe.mock.calls[0][1]).toEqual({ restaurantName: "Fasano", city: "São Paulo" });
    // One deadline for the whole request, well before Vercel's 60 s limit.
    const deadline = (transcribe.mock.calls[0] as unknown as [unknown, unknown, { deadline: number }])[2].deadline;
    expect(deadline - Date.now()).toBeGreaterThan(40_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(45_000);
    expect(response.body).toMatchObject({ pages: 2, unreadPages: [] });
    expect(repository.saveList.mock.calls[0][0]).toMatchObject({ userId: "user-1", source: "photo", status: "transcribed", restaurant: { name: "Fasano", city: "São Paulo", latitude: -23.56 } });
  });

  it("accepts a single PDF and uses the restaurant read from the list when none was typed", async () => {
    const { app, repository } = appFor("premium");
    await request(app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("%PDF"), { filename: "carta.pdf", contentType: "application/pdf" }).expect(201);
    expect(repository.saveList.mock.calls[0][0]).toMatchObject({ source: "pdf", restaurant: { name: "Fasano" } });
  });

  it("rejects mixing a PDF with photos, other file types and empty requests", async () => {
    const { app } = appFor("premium");
    await request(app).post("/wine-lists").set("Authorization", "Bearer t")
      .attach("files", Buffer.from("%PDF"), { filename: "a.pdf", contentType: "application/pdf" })
      .attach("files", Buffer.from("x"), { filename: "b.jpg", contentType: "image/jpeg" }).expect(400);
    await request(app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("x"), { filename: "a.txt", contentType: "text/plain" }).expect(400);
    await request(app).post("/wine-lists").set("Authorization", "Bearer t").expect(400);
  });

  it("saves a failed transcription and tells the user to retake the photos", async () => {
    const { app, repository } = appFor("premium", { items: [] });
    const response = await request(app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(422);
    expect(response.body.message).toContain("Não conseguimos ler os vinhos desta carta");
    expect(repository.saveList.mock.calls[0][0]).toMatchObject({ status: "failed" });
  });

  it("tells the user to send fewer pages when the models ran out of time", async () => {
    const { app } = appFor("premium", { items: [], attempts: [{ model: "vision", ok: false, ms: 44000, error: "request_timeout", page: 1 }] });
    const response = await request(app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(422);
    expect(response.body.message).toContain("Envie menos páginas");
  });

  it("logs the pages it could not read on a partial transcription", async () => {
    const { app, repository } = appFor("premium", { unreadPages: [3], attempts: [{ model: "vision", ok: true, ms: 9000, page: 1 }, { model: "vision", ok: false, ms: 9000, error: "answer_cut_by_token_limit", page: 3 }] });
    const response = await request(app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(201);
    expect(response.body.unreadPages).toEqual([3]);
    expect(repository.saveList.mock.calls[0][0]).toMatchObject({ status: "transcribed", errorMessage: "página 3 · vision: answer_cut_by_token_limit" });
  });

  it("logs an unexpected failure before answering, so no attempt disappears", async () => {
    const { app, transcribe, repository } = appFor("premium");
    transcribe.mockRejectedValueOnce(new Error("connection terminated"));
    await request(app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(500);
    expect(repository.saveList.mock.calls[0][0]).toMatchObject({ status: "failed", items: [], errorMessage: "erro interno: connection terminated" });
  });

  it("is a Premium feature and needs a session", async () => {
    await request(appFor("free").app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(403);
    await request(appFor("premium").app).post("/wine-lists").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(401);
  });

  it("returns a list and the user's lists", async () => {
    const { app } = appFor("premium");
    expect((await request(app).get(`/wine-lists/${LIST}`).set("Authorization", "Bearer t").expect(200)).body.restaurant.name).toBe("Fasano");
    await request(app).get(`/wine-lists/${OTHER}`).set("Authorization", "Bearer t").expect(404);
    expect((await request(app).get("/wine-lists").set("Authorization", "Bearer t").expect(200)).body).toEqual([{ id: LIST }]);
  });

  it("checks the bottle served against the chosen item", async () => {
    const { app, checkBottle, repository } = appFor("premium");
    const response = await request(app).post(`/wine-lists/${LIST}/items/${ITEM}/check`).set("Authorization", "Bearer t")
      .attach("image", Buffer.from("bottle"), { filename: "bottle.jpg", contentType: "image/jpeg" }).expect(200);
    expect(response.body).toMatchObject({ id: "check-1", verdict: "match", explanation: "Confere.", item: { id: ITEM } });
    expect(checkBottle.mock.calls[0][0]).toMatchObject({ name: "Catena Zapata Malbec Argentino" });
    expect(repository.saveCheck.mock.calls[0][0]).toMatchObject({ listId: LIST, itemId: ITEM, userId: "user-1", errorMessage: null });
  });

  it("answers 404 for an unknown item and 502 when no model could compare", async () => {
    await request(appFor("premium").app).post(`/wine-lists/${LIST}/items/${OTHER}/check`).set("Authorization", "Bearer t")
      .attach("image", Buffer.from("b"), { filename: "b.jpg", contentType: "image/jpeg" }).expect(404);
    const failing = appFor("premium", { checkModel: null });
    await request(failing.app).post(`/wine-lists/${LIST}/items/${ITEM}/check`).set("Authorization", "Bearer t")
      .attach("image", Buffer.from("b"), { filename: "b.jpg", contentType: "image/jpeg" }).expect(502);
    expect(failing.repository.saveCheck).toHaveBeenCalledOnce();
  });

  it("does not open another user's list nor check a bottle against it", async () => {
    const { app, repository } = appFor("premium");
    repository.canUse.mockResolvedValue(false);
    await request(app).get(`/wine-lists/${LIST}`).set("Authorization", "Bearer t").expect(404);
    await request(app).post(`/wine-lists/${LIST}/items/${ITEM}/check`).set("Authorization", "Bearer t")
      .attach("image", Buffer.from("b"), { filename: "b.jpg", contentType: "image/jpeg" }).expect(404);
    expect(repository.canUse).toHaveBeenCalledWith(LIST, "user-1");
    expect(repository.findList).not.toHaveBeenCalled();
    await request(app).get("/wine-lists/not-a-uuid").set("Authorization", "Bearer t").expect(404);
  });

  describe("admin upload (Curadoria Carta de Vinhos)", () => {
    const upload = (app: ReturnType<typeof appFor>["app"], token?: string) => {
      const call = request(app).post("/admin/wine-lists");
      return (token ? call.set("Authorization", `Bearer ${token}`) : call);
    };

    it("transcribes a list for an existing restaurant, as the admin", async () => {
      const { app, repository, transcribe } = appFor("free");
      await upload(app, "admin-token").field("restaurantId", RESTAURANT)
        .attach("files", Buffer.from("p1"), { filename: "p1.jpg", contentType: "image/jpeg" }).expect(201);
      expect(transcribe).toHaveBeenCalledOnce();
      expect(repository.saveList.mock.calls[0][0]).toMatchObject({ uploadedBy: "admin-1", restaurant: { id: RESTAURANT } });
      expect(repository.saveList.mock.calls[0][0]).not.toHaveProperty("userId");
    });

    it("creates the list of a new restaurant from its name, city and address", async () => {
      const { app, repository } = appFor("free");
      await upload(app, "admin-token").field("restaurantName", "Tasca Nova").field("city", "Recife").field("address", "Rua da Aurora, 10")
        .attach("files", Buffer.from("%PDF"), { filename: "carta.pdf", contentType: "application/pdf" }).expect(201);
      expect(repository.saveList.mock.calls[0][0]).toMatchObject({ uploadedBy: "admin-1", source: "pdf", restaurant: { id: null, name: "Tasca Nova", city: "Recife", address: "Rua da Aurora, 10" } });
    });

    it("needs an admin session and a restaurant", async () => {
      const { app, transcribe } = appFor("premium");
      const file = [Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }] as const;
      await upload(app).field("restaurantName", "X").attach("files", ...file).expect(401);
      await upload(app, "t").field("restaurantName", "X").attach("files", ...file).expect(401);
      await upload(app, "admin-token").attach("files", ...file).expect(400);
      await upload(app, "admin-token").field("restaurantId", OTHER).attach("files", ...file).expect(404);
      await upload(app, "admin-token").field("restaurantId", "nope").attach("files", ...file).expect(404);
      expect(transcribe).not.toHaveBeenCalled();
    });
  });
});
