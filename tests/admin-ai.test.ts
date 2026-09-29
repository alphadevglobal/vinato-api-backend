import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSessions } from "../src/admin-session.js";
import { createApp } from "../src/app.js";

const originalKey = process.env.OPENROUTER_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
});

describe("AdminSessions", () => {
  it("accepts only live sessions of active admins, stored as SHA-256 hashes by vinato-web", async () => {
    const db = new PGlite();
    await db.exec(`create table users (id uuid primary key default gen_random_uuid(), role text not null, status text not null default 'active');
      create table sessions (id uuid primary key default gen_random_uuid(), user_id uuid not null, token_hash text not null, expires_at timestamptz not null, revoked_at timestamptz);`);
    const hash = (token: string) => createHash("sha256").update(token).digest("hex");
    const user = async (role: string, status = "active") => (await db.query<{ id: string }>(`insert into users (role, status) values ($1, $2) returning id`, [role, status])).rows[0].id;
    const session = async (userId: string, token: string, expires = "now() + interval '1 hour'", revoked = "null") =>
      db.query(`insert into sessions (user_id, token_hash, expires_at, revoked_at) values ($1, $2, ${expires}, ${revoked})`, [userId, hash(token)]);
    const admin = await user("super_admin");
    await session(admin, "good");
    await session(admin, "expired", "now() - interval '1 minute'");
    await session(admin, "revoked", "now() + interval '1 hour'", "now()");
    await session(await user("user"), "customer");
    await session(await user("admin", "blocked"), "blocked");
    const sessions = new AdminSessions({ query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as pg.Pool);

    expect(await sessions.adminFor("good")).toEqual({ userId: admin, role: "super_admin" });
    for (const token of ["expired", "revoked", "customer", "blocked", "unknown", ""]) expect(await sessions.adminFor(token)).toBeNull();
  });
});

describe("POST /admin/ai/enrich", () => {
  const appWith = (admin: boolean) => createApp({
    wineRepository: {} as never, wineScanner: {} as never,
    adminSessions: { adminFor: vi.fn(async (token: string) => admin && token === "admin-token" ? { userId: "a", role: "admin" } : null) },
  });

  it("runs the review with the server key for an admin session, with web search", async () => {
    process.env.OPENROUTER_API_KEY = "server-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"displayName":"Almadén Ugni Blanc Suave"}' } }], usage: { prompt_tokens: 700, completion_tokens: 300, total_tokens: 1000, cost: 0.002 } })));
    vi.stubGlobal("fetch", fetchMock);
    const response = await request(appWith(true)).post("/admin/ai/enrich").set("Authorization", "Bearer admin-token").send({ model: "anthropic/claude-sonnet-5.5", web: true, prompt: "Complete a ficha" }).expect(200);
    expect(response.body).toEqual({ answer: { displayName: "Almadén Ugni Blanc Suave" }, usage: { promptTokens: 700, completionTokens: 300, totalTokens: 1000, costUsd: 0.002 } });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer server-key");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "anthropic/claude-sonnet-5.5", plugins: [{ id: "web", max_results: 3 }] });
  });

  it("rejects requests without an admin session", async () => {
    await request(appWith(true)).post("/admin/ai/enrich").send({ model: "m", prompt: "p" }).expect(401);
    await request(appWith(true)).post("/admin/ai/enrich").set("Authorization", "Bearer customer-token").send({ model: "m", prompt: "p" }).expect(401);
    await request(appWith(false)).post("/admin/ai/enrich").set("Authorization", "Bearer admin-token").send({ model: "m", prompt: "p" }).expect(401);
  });

  it("validates the body and reports model failures", async () => {
    process.env.OPENROUTER_API_KEY = "server-key";
    await request(appWith(true)).post("/admin/ai/enrich").set("Authorization", "Bearer admin-token").send({ model: "m" }).expect(400);
    await request(appWith(true)).post("/admin/ai/enrich").set("Authorization", "Bearer admin-token").send({ model: "m", prompt: "x".repeat(20_001) }).expect(400);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"a":' } }] }))));
    const cut = await request(appWith(true)).post("/admin/ai/enrich").set("Authorization", "Bearer admin-token").send({ model: "m", prompt: "p" }).expect(502);
    expect(cut.body.message).toContain("limite de tokens");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const limited = await request(appWith(true)).post("/admin/ai/enrich").set("Authorization", "Bearer admin-token").send({ model: "m", prompt: "p" }).expect(502);
    expect(limited.body.message).toContain("429");
  });
});

describe("GET /admin/finance/openrouter", () => {
  const appWith = () => createApp({
    wineRepository: {} as never, wineScanner: {} as never,
    adminSessions: { adminFor: vi.fn(async (token: string) => token === "admin-token" ? { userId: "a", role: "admin" } : null) },
  });
  const originalSommelier = process.env.SOMMELIER_OPENROUTER_API_KEY;
  afterEach(() => { if (originalSommelier === undefined) delete process.env.SOMMELIER_OPENROUTER_API_KEY; else process.env.SOMMELIER_OPENROUTER_API_KEY = originalSommelier; });

  it("reports the usage of each server key and the balance, without exposing the keys", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-scanner-1111";
    process.env.SOMMELIER_OPENROUTER_API_KEY = "sk-or-sommelier-2222";
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const key = (init.headers as Record<string, string>).Authorization;
      if (url.endsWith("/key")) return new Response(JSON.stringify({ data: { label: "vinato", usage: key.endsWith("1111") ? 12.5 : 3.25, usage_monthly: 1.5, limit: null, limit_remaining: null, is_free_tier: false } }));
      if (key.endsWith("1111")) return new Response(JSON.stringify({ error: { message: "forbidden" } }), { status: 403 });
      return new Response(JSON.stringify({ data: { total_credits: 40, total_usage: 15.75 } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const response = await request(appWith()).get("/admin/finance/openrouter").set("Authorization", "Bearer admin-token").expect(200);
    expect(response.body.keys).toEqual([
      expect.objectContaining({ purpose: "Scanner, cartas e curadoria", keyHint: "…1111", ok: true, usageUsd: 12.5, usageMonthlyUsd: 1.5 }),
      expect.objectContaining({ purpose: "Sommelier", keyHint: "…2222", ok: true, usageUsd: 3.25 }),
    ]);
    expect(response.body.credits).toEqual({ totalCreditsUsd: 40, totalUsageUsd: 15.75, balanceUsd: 24.25 });
    expect(JSON.stringify(response.body)).not.toContain("sk-or-");
  });

  it("requires an admin session", async () => {
    await request(appWith()).get("/admin/finance/openrouter").expect(401);
    await request(appWith()).get("/admin/finance/openrouter").set("Authorization", "Bearer customer").expect(401);
  });
});
