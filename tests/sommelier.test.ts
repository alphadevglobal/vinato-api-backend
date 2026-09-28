import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { SommelierAgent, type ChatTurn, type CompleteChat } from "../src/sommelier.service.js";

// Minimal in-memory stand-in for the three sommelier tables.
function fakeDb(sentToday = 0) {
  const conversations: Array<{ id: string; user_id: string; title: string }> = [];
  const messages: Array<{ id: string; conversation_id: string; role: string; content: string; reasoning_details: unknown; created_at: number }> = [];
  let clock = 0;
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM sommelier_agent_config")) return { rows: [{ model: "deepseek/deepseek-v3.2", system_prompt: "REGRAS", reasoning_enabled: true, temperature: "0.7", max_output_tokens: 1200, history_messages: 20, daily_message_limit: 2 }] };
    if (sql.includes("count(*)::int AS n")) return { rows: [{ n: sentToday }] };
    if (sql.startsWith("INSERT INTO sommelier_conversations")) { const row = { id: `00000000-0000-0000-0000-00000000000${conversations.length + 1}`, user_id: String(params[0]), title: String(params[1]) }; conversations.push(row); return { rows: [row] }; }
    if (sql.includes("FROM sommelier_conversations WHERE id = $1 AND user_id = $2")) return { rows: conversations.filter((c) => c.id === params[0] && c.user_id === params[1]) };
    if (sql.trim().startsWith("INSERT INTO sommelier_messages")) {
      const assistant = sql.includes("'assistant'");
      const row = { id: `m${messages.length + 1}`, conversation_id: String(params[0]), role: assistant ? "assistant" : "user", content: String(params[1]), reasoning_details: assistant && params[2] ? JSON.parse(String(params[2])) : null, created_at: ++clock };
      messages.push(row); return { rows: [row] };
    }
    if (sql.includes("SELECT role, content, reasoning_details FROM")) return { rows: messages.filter((m) => m.conversation_id === params[0]).sort((a, b) => a.created_at - b.created_at) };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  return { pool: { query, connect: vi.fn(async () => client) } as unknown as pg.Pool, conversations, messages };
}

describe("SommelierAgent", () => {
  it("sends the configured instructions and passes reasoning_details back on the next turn", async () => {
    const db = fakeDb();
    const complete = vi.fn<CompleteChat>()
      .mockResolvedValueOnce({ content: "Um Malbec vai bem.", reasoningDetails: [{ type: "reasoning.text", text: "pensando" }], model: "deepseek/deepseek-v3.2" })
      .mockResolvedValueOnce({ content: "Tenho certeza.", reasoningDetails: null, model: "deepseek/deepseek-v3.2" });
    const agent = new SommelierAgent(db.pool, complete);

    const first = await agent.chat("user-1", { message: "O que combina com churrasco?" });
    await agent.chat("user-1", { conversationId: first.conversation.id, message: "Tem certeza?" });

    const firstCall = complete.mock.calls[0][0] as ChatTurn[];
    expect(firstCall[0]).toEqual({ role: "system", content: "REGRAS" });
    const secondCall = complete.mock.calls[1][0] as ChatTurn[];
    expect(secondCall.map((turn) => turn.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(secondCall[2].reasoning_details).toEqual([{ type: "reasoning.text", text: "pensando" }]);
    expect(first.reply.content).toBe("Um Malbec vai bem.");
  });

  it("stores nothing when the model fails", async () => {
    const db = fakeDb();
    const agent = new SommelierAgent(db.pool, async () => { throw new Error("model down"); });
    await expect(agent.chat("user-1", { message: "Oi" })).rejects.toThrow("model down");
    expect(db.conversations).toHaveLength(0);
    expect(db.messages).toHaveLength(0);
  });

  it("enforces the daily message limit", async () => {
    const agent = new SommelierAgent(fakeDb(2).pool, vi.fn());
    await expect(agent.chat("user-1", { message: "Oi" })).rejects.toMatchObject({ statusCode: 429 });
  });

  it("does not open another user's conversation", async () => {
    const agent = new SommelierAgent(fakeDb().pool, vi.fn());
    await expect(agent.getMessages("user-2", "00000000-0000-0000-0000-000000000001")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("Sommelier routes", () => {
  const appFor = (plan: "free" | "premium") => {
    const chat = vi.fn(async () => ({ conversation: { id: "c1" }, reply: { content: "Olá" } }));
    const accountRepository = { getUser: vi.fn(async () => ({ id: "user-1", email: "a@b.c", displayName: "A", role: "user", plan, planExpiresAt: null, status: "active", avatarUrl: null })) };
    const app = createApp({ wineRepository: {} as never, wineScanner: {} as never, accountRepository: accountRepository as never, sommelier: { chat } as never });
    return { app, chat };
  };

  it("is exclusive to Premium members", async () => {
    const { app, chat } = appFor("free");
    const response = await request(app).post("/sommelier/chat").set("Authorization", "Bearer token").send({ message: "Oi" }).expect(403);
    expect(response.body.message).toBe("Recurso exclusivo do VINATO Premium.");
    expect(chat).not.toHaveBeenCalled();
  });

  it("requires a session", async () => {
    await request(appFor("premium").app).post("/sommelier/chat").send({ message: "Oi" }).expect(401);
  });

  it("answers Premium members", async () => {
    const { app, chat } = appFor("premium");
    const response = await request(app).post("/sommelier/chat").set("Authorization", "Bearer token").send({ message: "Oi", conversationId: "" }).expect(200);
    expect(chat).toHaveBeenCalledWith("user-1", { conversationId: undefined, message: "Oi" });
    expect(response.body.reply.content).toBe("Olá");
  });
});
