import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { mergeMenuPages, menuPrompt, normalizeMenuItems, OpenRouterMenuAgent } from "../src/menu.service.js";

describe("menu transcription", () => {
  it("keeps the dishes with their description and price, and leaves drinks to the prompt", () => {
    expect(normalizeMenuItems([
      { section: "Peixes", name: "Tilápia grelhada", description: "manteiga de limão", price: "R$ 92,00", currency: "brl" },
      { name: "  ", price: 10 }, { name: "Pastel de nata", notes: "null" }, "lixo",
    ])).toEqual([
      { section: "Peixes", name: "Tilápia grelhada", description: "manteiga de limão", price: 92, currency: "BRL", notes: null },
      { section: null, name: "Pastel de nata", description: null, price: null, currency: "BRL", notes: null },
    ]);
    expect(menuPrompt({ restaurantName: "Café Viriato", city: "Lisboa" })).toContain("Nao inclua bebidas");
    expect(menuPrompt({}, { index: 2, total: 3 })).toContain("pagina 2 de 3");
  });

  it("keeps once a dish repeated where two photos overlap", () => {
    const dish = (name: string, price: number) => ({ section: null, name, description: null, price, currency: "BRL", notes: null });
    expect(mergeMenuPages([[dish("Risoto", 90), dish("Polvo", 120)], [dish("Polvo", 120), dish("Pudim", 30)]]).map((item) => item.name)).toEqual(["Risoto", "Polvo", "Pudim"]);
  });

  it("reads each photo as one page with the wine list models", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ restaurant: { name: "Viriato" }, items: [{ name: "Polvo", price: 120 }] }) } }], usage: { total_tokens: 100 } })));
    vi.stubGlobal("fetch", fetchMock);
    process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "test";
    const agent = new OpenRouterMenuAgent({ getWineListModels: async () => ({ model: "google/gemini-3.8-flash", fallbackModel: "google/gemini-3.1-flash-lite" }) } as never);
    const result = await agent.transcribe([{ mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,AA" }, { mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,BB" }], {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.items.map((item) => item.name)).toEqual(["Polvo"]);
    expect(result.restaurant.name).toBe("Viriato");
    vi.unstubAllGlobals();
  });
});

describe("POST /admin/menus", () => {
  const saved = { id: "m1", status: "transcribed", source: "photo", createdAt: "2026-10-01T12:00:00Z", restaurant: { id: "r1", name: "Café Viriato", city: "Lisboa" }, items: [{ id: "i1", position: 0, section: "Peixes", name: "Tilápia", description: null, price: 92, currency: "BRL", notes: null }] };
  const build = (items = saved.items) => {
    const transcribe = vi.fn(async () => ({ restaurant: { name: null, city: null }, items, model: "m", attempts: [], usage: {}, unreadPages: [], pages: 1 }));
    const saveMenu = vi.fn(async () => saved);
    const app = createApp({
      wineRepository: {} as never, wineScanner: {} as never,
      adminSessions: { adminFor: vi.fn(async (token: string) => token === "admin" ? { userId: "a1", role: "admin" } : null) },
      wineLists: { agent: {} as never, repository: { restaurantExists: vi.fn(async () => true) } as never },
      menus: { agent: { transcribe }, repository: { saveMenu, retranscriptionSource: vi.fn(), replaceTranscription: vi.fn() } },
    });
    return { app, transcribe, saveMenu };
  };

  it("transcribes the menu an admin uploads for a new restaurant and saves it as approved", async () => {
    const { app, transcribe, saveMenu } = build();
    const response = await request(app).post("/admin/menus").set("Authorization", "Bearer admin")
      .field("restaurantName", "Café Viriato").field("city", "Lisboa").attach("files", Buffer.from("x"), { filename: "p1.jpg", contentType: "image/jpeg" }).expect(201);
    expect(response.body).toMatchObject({ id: "m1", pages: 1, unreadPages: [] });
    expect(transcribe).toHaveBeenCalledWith([{ mimetype: "image/jpeg", dataUrl: "data:image/jpeg;base64,eA==" }], { restaurantName: "Café Viriato", city: "Lisboa" }, expect.anything());
    expect(saveMenu).toHaveBeenCalledWith(expect.objectContaining({ uploadedBy: "a1", status: "transcribed", source: "photo", restaurant: expect.objectContaining({ name: "Café Viriato", city: "Lisboa" }) }));
  });

  it("logs a menu with no dishes as failed and tells the admin", async () => {
    const { app, saveMenu } = build([]);
    const response = await request(app).post("/admin/menus").set("Authorization", "Bearer admin")
      .field("restaurantName", "X").attach("files", Buffer.from("x"), { filename: "p1.jpg", contentType: "image/jpeg" }).expect(422);
    expect(response.body.message).toContain("Não conseguimos ler os pratos");
    expect(saveMenu).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorMessage: "nenhum prato encontrado" }));
  });

  it("requires an admin session, a restaurant and the files", async () => {
    const { app } = build();
    await request(app).post("/admin/menus").field("restaurantName", "X").expect(401);
    await request(app).post("/admin/menus").set("Authorization", "Bearer admin").attach("files", Buffer.from("x"), { filename: "p1.jpg", contentType: "image/jpeg" }).expect(400);
    await request(app).post("/admin/menus").set("Authorization", "Bearer admin").field("restaurantName", "X").expect(400);
  });
});
