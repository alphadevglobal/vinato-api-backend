import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { parseJsonContent, requestJsonWithFallback, totalUsage } from "../src/openrouter.js";
import { bottleCheckPrompt, money, normalizeCheck, normalizeItems, OpenRouterWineListAgent, transcriptionPrompt, type WineListItem } from "../src/wine-list.service.js";
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
    expect(prompt).toContain("SEM safra, regiao, volume ou preco");
    expect(transcriptionPrompt({})).not.toContain("Restaurante informado");
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

    await agent.transcribe([{ mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA" }, { mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,BB" }], {});
    const photos = call(1).messages[0].content;
    expect(photos.slice(1)).toEqual([{ type: "image_url", image_url: { url: "data:image/jpeg;base64,AA" } }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,BB" } }]);
    expect(call(1).max_tokens).toBeGreaterThanOrEqual(16000);
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
    for (const name of ["014_unlisted_scan_dedup.sql", "015_wine_photo_pool.sql", "017_wine_lists.sql"]) await db.exec(read(name));
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

  it("creates the default wine list AI model", async () => {
    expect((await db.query(`select model, fallback_model from wine_list_agent_config`)).rows).toEqual([{ model: "google/gemini-3.8-flash", fallback_model: "google/gemini-3.1-flash-lite" }]);
  });
});

describe("wine list routes", () => {
  const user = (plan: "free" | "premium") => ({ id: "user-1", email: "a@b.c", displayName: "A", role: "user", plan, planExpiresAt: null, status: "active", avatarUrl: null });
  const saved = { id: "list-1", status: "transcribed", source: "photo", createdAt: "2026-09-29T00:00:00.000Z", restaurant: { id: "r1", name: "Fasano", city: "São Paulo", address: null }, items: [{ ...item, id: "item-1", position: 0 }] };
  function appFor(plan: "free" | "premium", overrides: { items?: WineListItem[]; checkModel?: string | null } = {}) {
    const transcribe = vi.fn(async () => ({ restaurant: { name: "Fasano", city: null }, items: overrides.items ?? [item], model: "vision", attempts: [], usage: { totalTokens: 1500 } }));
    const checkBottle = vi.fn(async () => ({ verdict: "match" as const, confidence: 0.9, explanation: "Confere.", observed: { producer: "Catena Zapata", wine: "Malbec Argentino", vintage: "2020", region: null, country: null, volume: null }, differences: [], model: overrides.checkModel === undefined ? "vision" : overrides.checkModel, attempts: [], usage: {} }));
    const repository = {
      saveList: vi.fn(async () => saved), findList: vi.fn(async (id: string) => id === "list-1" ? saved : null), listsOf: vi.fn(async () => [{ id: "list-1" }]),
      findItem: vi.fn(async (_list: string, id: string) => id === "item-1" ? saved.items[0] : null), saveCheck: vi.fn(async () => ({ id: "check-1", createdAt: "2026-09-29T00:00:00.000Z" })),
    };
    const accountRepository = { getUser: vi.fn(async () => user(plan)) };
    const app = createApp({ wineRepository: {} as never, wineScanner: {} as never, accountRepository: accountRepository as never, wineLists: { agent: { transcribe, checkBottle }, repository } as never });
    return { app, transcribe, checkBottle, repository };
  }

  it("transcribes the photos of a list for Premium members", async () => {
    const { app, transcribe, repository } = appFor("premium");
    const response = await request(app).post("/wine-lists").set("Authorization", "Bearer t")
      .field("restaurantName", "Fasano").field("city", "São Paulo").field("latitude", "-23,56")
      .attach("files", Buffer.from("page1"), { filename: "p1.jpg", contentType: "image/jpeg" })
      .attach("files", Buffer.from("page2"), { filename: "p2.jpg", contentType: "image/jpeg" })
      .expect(201);
    expect(response.body).toMatchObject({ id: "list-1", items: [{ id: "item-1", name: "Catena Zapata Malbec Argentino" }] });
    expect(transcribe.mock.calls[0][0]).toHaveLength(2);
    expect(transcribe.mock.calls[0][1]).toEqual({ restaurantName: "Fasano", city: "São Paulo" });
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
    expect(response.body.message).toContain("fotos mais nítidas");
    expect(repository.saveList.mock.calls[0][0]).toMatchObject({ status: "failed" });
  });

  it("is a Premium feature and needs a session", async () => {
    await request(appFor("free").app).post("/wine-lists").set("Authorization", "Bearer t").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(403);
    await request(appFor("premium").app).post("/wine-lists").attach("files", Buffer.from("x"), { filename: "a.jpg", contentType: "image/jpeg" }).expect(401);
  });

  it("returns a list and the user's lists", async () => {
    const { app } = appFor("premium");
    expect((await request(app).get("/wine-lists/list-1").set("Authorization", "Bearer t").expect(200)).body.restaurant.name).toBe("Fasano");
    await request(app).get("/wine-lists/other").set("Authorization", "Bearer t").expect(404);
    expect((await request(app).get("/wine-lists").set("Authorization", "Bearer t").expect(200)).body).toEqual([{ id: "list-1" }]);
  });

  it("checks the bottle served against the chosen item", async () => {
    const { app, checkBottle, repository } = appFor("premium");
    const response = await request(app).post("/wine-lists/list-1/items/item-1/check").set("Authorization", "Bearer t")
      .attach("image", Buffer.from("bottle"), { filename: "bottle.jpg", contentType: "image/jpeg" }).expect(200);
    expect(response.body).toMatchObject({ id: "check-1", verdict: "match", explanation: "Confere.", item: { id: "item-1" } });
    expect(checkBottle.mock.calls[0][0]).toMatchObject({ name: "Catena Zapata Malbec Argentino" });
    expect(repository.saveCheck.mock.calls[0][0]).toMatchObject({ listId: "list-1", itemId: "item-1", userId: "user-1", errorMessage: null });
  });

  it("answers 404 for an unknown item and 502 when no model could compare", async () => {
    await request(appFor("premium").app).post("/wine-lists/list-1/items/nope/check").set("Authorization", "Bearer t")
      .attach("image", Buffer.from("b"), { filename: "b.jpg", contentType: "image/jpeg" }).expect(404);
    const failing = appFor("premium", { checkModel: null });
    await request(failing.app).post("/wine-lists/list-1/items/item-1/check").set("Authorization", "Bearer t")
      .attach("image", Buffer.from("b"), { filename: "b.jpg", contentType: "image/jpeg" }).expect(502);
    expect(failing.repository.saveCheck).toHaveBeenCalledOnce();
  });
});
