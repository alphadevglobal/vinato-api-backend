import type pg from "pg";
import { config } from "./config.js";
import { HttpError, internalServerError, notFound } from "./http-error.js";

export type SommelierConfig = {
  model: string;
  systemPrompt: string;
  reasoningEnabled: boolean;
  temperature: number;
  maxOutputTokens: number;
  historyMessages: number;
  dailyMessageLimit: number;
};

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string; reasoning_details?: unknown };
export type Completion = { content: string; reasoningDetails: unknown; model: string; promptTokens?: number; completionTokens?: number; costUsd?: number };
export type CompleteChat = (messages: ChatTurn[], settings: SommelierConfig) => Promise<Completion>;

export type SommelierMessage = { id: string; role: "user" | "assistant"; content: string; createdAt: string };
export type SommelierConversation = { id: string; title: string; createdAt: string; updatedAt: string };

const DEFAULT_CONFIG: SommelierConfig = {
  model: "deepseek/deepseek-v3.2",
  systemPrompt: "Você é o Sommelier VINATO. Responda em português do Brasil, apenas sobre vinhos, com responsabilidade.",
  reasoningEnabled: true,
  temperature: 0.7,
  maxOutputTokens: 1200,
  historyMessages: 20,
  dailyMessageLimit: 60,
};
const MAX_MESSAGE_LENGTH = 2000;
const BURST_LIMIT_PER_MINUTE = 6;
export const GUARDED_REPLY = "Esse não é o meu trabalho: sou o sommelier do VINATO e só converso sobre vinhos. Posso te ajudar a escolher um vinho ou uma harmonização?";

// Secret-shaped text that must never reach the user, whatever the model says.
const SECRET_PATTERNS = [
  /\bsk-(or-v1-|ant-|proj-)?[A-Za-z0-9_-]{16,}/i,                 // API keys (OpenRouter, OpenAI, Anthropic...)
  /\b(postgres(ql)?|mysql|mongodb(\+srv)?|redis):\/\/\S+/i,         // database URLs
  /\bnpg_[A-Za-z0-9]{8,}/,                                          // Neon passwords
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWTs
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\b(OPENROUTER|SOMMELIER_OPENROUTER|DATABASE|GOOGLE_CLIENT|APPLE)_[A-Z_]*\s*[=:]/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Last line of defence after the model: blocks replies that contain secrets
 * or reproduce the agent's instructions (prompt extraction), and strips the
 * markdown the app cannot render. The model never receives secrets or user
 * data, so this should never trigger; if it does, the reply is replaced.
 */
export function guardReply(reply: string, systemPrompt: string): { content: string; blocked: boolean } {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(reply))) return { content: GUARDED_REPLY, blocked: true };
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const replyText = normalize(reply);
  const leakedLines = systemPrompt.split("\n").map(normalize).filter((line) => line.length >= 40 && replyText.includes(line));
  if (leakedLines.length >= 2) return { content: GUARDED_REPLY, blocked: true };
  const content = reply.replace(/```[\s\S]*?```/g, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/^#{1,6}\s+/gm, "").trim();
  return { content: content || GUARDED_REPLY, blocked: !content };
}
const REQUEST_TIMEOUT_MS = 50_000; // below Vercel's 60 s function limit

/** OpenRouter chat completion, preserving reasoning_details between turns. */
export const openRouterChat: CompleteChat = async (messages, settings) => {
  if (!config.sommelierApiKey) throw internalServerError("Sommelier temporariamente indisponível.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${config.sommelierApiKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://vinatoapp.com", "X-Title": "VINATO Sommelier" },
      body: JSON.stringify({
        model: settings.model,
        messages,
        temperature: settings.temperature,
        max_tokens: settings.maxOutputTokens,
        usage: { include: true },
        ...(settings.reasoningEnabled ? { reasoning: { enabled: true } } : {}),
      }),
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") throw new HttpError(504, "O Sommelier demorou para responder. Tente novamente.", "Gateway Timeout");
    throw internalServerError("Não foi possível falar com o Sommelier agora.");
  } finally {
    clearTimeout(timeout);
  }
  const body = await response.text();
  if (!response.ok) {
    console.error("[sommelier] OpenRouter error", response.status, body.slice(0, 300));
    throw internalServerError("Não foi possível falar com o Sommelier agora.");
  }
  const payload = JSON.parse(body) as {
    model?: string;
    choices?: Array<{ message?: { content?: string | null; reasoning_details?: unknown } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const message = payload.choices?.[0]?.message;
  const content = message?.content?.trim();
  if (!content) throw internalServerError("O Sommelier não conseguiu responder agora.");
  return { content, reasoningDetails: message?.reasoning_details ?? null, model: payload.model ?? settings.model, promptTokens: payload.usage?.prompt_tokens, completionTokens: payload.usage?.completion_tokens, costUsd: payload.usage?.cost };
};

export class SommelierAgent {
  constructor(private readonly pool: pg.Pool, private readonly complete: CompleteChat = openRouterChat) {}

  async getConfig(): Promise<SommelierConfig> {
    const row = (await this.pool.query(`SELECT * FROM sommelier_agent_config WHERE id = 1`)).rows[0];
    if (!row) return DEFAULT_CONFIG;
    return {
      model: row.model, systemPrompt: row.system_prompt, reasoningEnabled: row.reasoning_enabled, temperature: Number(row.temperature),
      maxOutputTokens: row.max_output_tokens, historyMessages: row.history_messages, dailyMessageLimit: row.daily_message_limit,
    };
  }

  async listConversations(userId: string): Promise<SommelierConversation[]> {
    const result = await this.pool.query(
      `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM sommelier_conversations WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 50`,
      [userId],
    );
    return result.rows;
  }

  async getMessages(userId: string, conversationId: string): Promise<SommelierMessage[]> {
    await this.ownedConversation(userId, conversationId);
    const result = await this.pool.query(
      `SELECT id, role, content, created_at AS "createdAt" FROM sommelier_messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
      [conversationId],
    );
    return result.rows;
  }

  async deleteConversation(userId: string, conversationId: string) {
    await this.ownedConversation(userId, conversationId);
    await this.pool.query(`DELETE FROM sommelier_conversations WHERE id = $1`, [conversationId]);
  }

  async chat(userId: string, input: { conversationId?: string; message: string }) {
    const text = input.message.trim();
    if (!text) throw new HttpError(400, "Escreva sua pergunta para o Sommelier.", "Bad Request");
    if (text.length > MAX_MESSAGE_LENGTH) throw new HttpError(400, `Mensagem muito longa (máximo de ${MAX_MESSAGE_LENGTH} caracteres).`, "Bad Request");
    const settings = await this.getConfig();

    const sentToday = (await this.pool.query(
      `SELECT count(*)::int AS n FROM sommelier_messages m JOIN sommelier_conversations c ON c.id = m.conversation_id
       WHERE c.user_id = $1 AND m.role = 'user' AND m.created_at >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'`,
      [userId],
    )).rows[0]?.n ?? 0;
    const lastMinute = (await this.pool.query(
      `SELECT count(*)::int AS n FROM sommelier_messages m JOIN sommelier_conversations c ON c.id = m.conversation_id
       WHERE c.user_id = $1 AND m.role = 'user' AND m.created_at >= now() - interval '1 minute'`,
      [userId],
    )).rows[0]?.n ?? 0;
    if (lastMinute >= BURST_LIMIT_PER_MINUTE) {
      throw new HttpError(429, "Muitas mensagens em sequência. Aguarde um minuto e tente novamente.", "Too Many Requests");
    }
    if (sentToday >= settings.dailyMessageLimit) {
      throw new HttpError(429, `Você atingiu o limite de ${settings.dailyMessageLimit} mensagens por dia com o Sommelier. Volte amanhã.`, "Too Many Requests");
    }

    const existing = input.conversationId ? await this.ownedConversation(userId, input.conversationId) : null;
    const history = existing ? (await this.pool.query(
      `SELECT role, content, reasoning_details FROM (
         SELECT role, content, reasoning_details, created_at FROM sommelier_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [existing.id, settings.historyMessages],
    )).rows as Array<{ role: "user" | "assistant"; content: string; reasoning_details: unknown }> : [];

    const messages: ChatTurn[] = [
      { role: "system", content: settings.systemPrompt },
      ...history.map((turn) => (turn.role === "assistant" && turn.reasoning_details ? { role: turn.role, content: turn.content, reasoning_details: turn.reasoning_details } : { role: turn.role, content: turn.content })),
      { role: "user", content: text },
    ];

    // Ask the model first: nothing is stored (and nothing counts toward the
    // daily limit) when the model fails.
    const startedAt = Date.now();
    const completion = await this.complete(messages, settings);
    const durationMs = Date.now() - startedAt;
    const guarded = guardReply(completion.content, settings.systemPrompt);
    if (guarded.blocked) console.warn("[sommelier] reply blocked by the output guard");

    const client = await this.pool.connect();
    let conversation: SommelierConversation;
    let userMessage: SommelierMessage;
    let reply: SommelierMessage;
    try {
      await client.query("BEGIN");
      conversation = existing ?? (await client.query(
        `INSERT INTO sommelier_conversations (user_id, title) VALUES ($1, $2) RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt"`,
        [userId, text.length > 60 ? `${text.slice(0, 57)}...` : text],
      )).rows[0];
      userMessage = (await client.query(
        `INSERT INTO sommelier_messages (conversation_id, role, content, created_at) VALUES ($1, 'user', $2, now() - interval '1 millisecond') RETURNING id, role, content, created_at AS "createdAt"`,
        [conversation.id, text],
      )).rows[0];
      reply = (await client.query(
        `INSERT INTO sommelier_messages (conversation_id, role, content, reasoning_details, model, prompt_tokens, completion_tokens, cost_usd, duration_ms)
         VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5, $6, $7, $8) RETURNING id, role, content, created_at AS "createdAt"`,
        [conversation.id, guarded.content, guarded.blocked || completion.reasoningDetails == null ? null : JSON.stringify(completion.reasoningDetails), completion.model, completion.promptTokens ?? null, completion.completionTokens ?? null, completion.costUsd ?? null, durationMs],
      )).rows[0];
      await client.query(`UPDATE sommelier_conversations SET updated_at = now() WHERE id = $1`, [conversation.id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    return { conversation, userMessage, reply, remainingToday: Math.max(0, settings.dailyMessageLimit - sentToday - 1) };
  }

  private async ownedConversation(userId: string, conversationId: string): Promise<SommelierConversation> {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw notFound("Conversa não encontrada.");
    const row = (await this.pool.query(
      `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt" FROM sommelier_conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId],
    )).rows[0];
    if (!row) throw notFound("Conversa não encontrada.");
    return row;
  }
}
