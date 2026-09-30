import type pg from "pg";
import { config } from "./config.js";
import { HttpError, internalServerError, notFound } from "./http-error.js";
import { summaryOf, wineListInstructions, type WineListContext, type WineListLookup, type WineListSummary } from "./sommelier-wine-list.js";

export type SommelierConfig = {
  model: string;
  systemPrompt: string;
  reasoningEnabled: boolean;
  temperature: number;
  maxOutputTokens: number;
  historyMessages: number;
  dailyMessageLimit: number;
  /** Answers the messages that carry photos or audio (must read both). */
  mediaModel: string;
  /** Limits the thinking of reasoning models (a long wine list made answers pass the time limit). */
  reasoningEffort?: "low";
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: string } };
export type ChatTurn = { role: "system" | "user" | "assistant"; content: string | ContentPart[]; reasoning_details?: unknown };
export type Completion = { content: string; reasoningDetails: unknown; model: string; promptTokens?: number; completionTokens?: number; costUsd?: number };
export type CompleteChat = (messages: ChatTurn[], settings: SommelierConfig) => Promise<Completion>;

export type AttachmentInfo = { id: string; kind: "image" | "audio"; mimeType: string; durationMs: number | null };
export type SommelierMessage = { id: string; role: "user" | "assistant"; content: string; createdAt: string; attachments?: AttachmentInfo[] };
/** A photo or a voice message sent with the question, as a data URL (base64). */
export type AttachmentInput = { kind: "image" | "audio"; dataUrl: string; durationMs?: number };
export type SommelierConversation = { id: string; title: string; createdAt: string; updatedAt: string; wineListId?: string | null; wineListRestaurant?: string | null };

const DEFAULT_CONFIG: SommelierConfig = {
  model: "deepseek/deepseek-v3.2",
  systemPrompt: "Você é o Sommelier VINATO. Responda em português do Brasil, apenas sobre vinhos, com responsabilidade.",
  reasoningEnabled: true,
  temperature: 0.7,
  maxOutputTokens: 1200,
  historyMessages: 20,
  dailyMessageLimit: 60,
  mediaModel: "google/gemini-3.8-flash",
};
export const MAX_IMAGES = 3;
export const MAX_AUDIO_SECONDS = 90;
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_AUDIO_BYTES = 2_000_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
// OpenRouter input_audio formats (https://openrouter.ai/docs/features/multimodal/audio).
const AUDIO_FORMATS: Record<string, string> = {
  "audio/m4a": "m4a", "audio/x-m4a": "m4a", "audio/mp4": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav", "audio/ogg": "ogg", "audio/webm": "ogg", "audio/flac": "flac",
};
// Added to the instructions when the client sends photos or audio.
const MEDIA_GUIDE = `
Mídia enviada pelo cliente:
- Fotos: descreva o que é relevante para vinho (rótulo, garrafa, carta de vinhos, prato, taça) e use isso na resposta. Se for um rótulo, identifique produtor, vinho, safra e região quando estiverem legíveis; não invente o que não estiver visível.
- Áudio: é a pergunta do cliente falada. Responda ao que foi dito, sem transcrever o áudio, a menos que peçam.
- Se a foto ou o áudio não tiver relação com vinho, diga isso com gentileza e ofereça ajuda com vinhos.`;

/** Validates the photos and audio of one message; returns them ready to store and to send to the model. */
export function parseAttachments(value: unknown): Array<AttachmentInput & { mimeType: string; base64: string; format?: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "Anexos inválidos.", "Bad Request");
  const parsed = value.map((item) => {
    const kind = (item as AttachmentInput)?.kind;
    const dataUrl = (item as AttachmentInput)?.dataUrl;
    const match = typeof dataUrl === "string" ? /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
    if ((kind !== "image" && kind !== "audio") || !match) throw new HttpError(400, "Anexo inválido: envie a foto ou o áudio novamente.", "Bad Request");
    const mimeType = match[1].toLowerCase();
    const bytes = Math.floor(match[2].length * 3 / 4);
    if (kind === "image") {
      if (!IMAGE_TYPES.has(mimeType)) throw new HttpError(400, "Formato de foto não suportado. Envie JPEG, PNG ou HEIC.", "Bad Request");
      if (bytes > MAX_IMAGE_BYTES) throw new HttpError(413, "A foto ficou grande demais. Tente outra foto.", "Payload Too Large");
      return { kind, dataUrl, mimeType, base64: match[2] };
    }
    const format = AUDIO_FORMATS[mimeType];
    if (!format) throw new HttpError(400, "Formato de áudio não suportado.", "Bad Request");
    if (bytes > MAX_AUDIO_BYTES) throw new HttpError(413, `O áudio ficou longo demais (máximo de ${MAX_AUDIO_SECONDS} segundos).`, "Payload Too Large");
    const rawDuration = Number((item as AttachmentInput).durationMs);
    const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : undefined;
    if (durationMs && durationMs > (MAX_AUDIO_SECONDS + 1) * 1000) throw new HttpError(400, `O áudio pode ter no máximo ${MAX_AUDIO_SECONDS} segundos.`, "Bad Request");
    return { kind, dataUrl, mimeType, base64: match[2], format, durationMs };
  });
  if (parsed.filter((item) => item.kind === "image").length > MAX_IMAGES) throw new HttpError(400, `Envie no máximo ${MAX_IMAGES} fotos por mensagem.`, "Bad Request");
  if (parsed.filter((item) => item.kind === "audio").length > 1) throw new HttpError(400, "Envie um áudio por mensagem.", "Bad Request");
  return parsed;
}

/** How a message with media appears in the history sent to the model (the media itself is sent only once). */
export function mediaNote(attachments: Array<{ kind: string }>) {
  const images = attachments.filter((item) => item.kind === "image").length;
  const audio = attachments.some((item) => item.kind === "audio");
  const parts = [images ? (images === 1 ? "uma foto" : `${images} fotos`) : "", audio ? "uma mensagem de voz" : ""].filter(Boolean);
  return parts.length ? `[O cliente enviou ${parts.join(" e ")}.]` : "";
}
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
        ...(settings.reasoningEnabled ? { reasoning: settings.reasoningEffort ? { effort: settings.reasoningEffort } : { enabled: true } } : {}),
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
  constructor(
    private readonly pool: pg.Pool,
    private readonly complete: CompleteChat = openRouterChat,
    // The wine lists the Sommelier may consult (Verificação de carta).
    private readonly wineLists?: WineListLookup,
  ) {}

  async getConfig(): Promise<SommelierConfig> {
    const row = (await this.pool.query(`SELECT * FROM sommelier_agent_config WHERE id = 1`)).rows[0];
    if (!row) return DEFAULT_CONFIG;
    return {
      model: row.model, systemPrompt: row.system_prompt, reasoningEnabled: row.reasoning_enabled, temperature: Number(row.temperature),
      maxOutputTokens: row.max_output_tokens, historyMessages: row.history_messages, dailyMessageLimit: row.daily_message_limit,
      mediaModel: row.media_model || DEFAULT_CONFIG.mediaModel,
    };
  }

  async listConversations(userId: string): Promise<SommelierConversation[]> {
    const result = await this.pool.query(
      `SELECT c.id, c.title, c.created_at AS "createdAt", c.updated_at AS "updatedAt", c.wine_list_id AS "wineListId",
              coalesce(r.name, l.restaurant_name) AS "wineListRestaurant"
       FROM sommelier_conversations c
       LEFT JOIN wine_lists l ON l.id = c.wine_list_id LEFT JOIN restaurants r ON r.id = l.restaurant_id
       WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 50`,
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
    const attachments = await this.attachmentsOf(result.rows.map((row) => row.id));
    return result.rows.map((row) => (attachments.has(row.id) ? { ...row, attachments: attachments.get(row.id) } : row));
  }

  /** A photo or audio of the user's own conversation, for the app to show or play. */
  async getAttachment(userId: string, attachmentId: string): Promise<{ mimeType: string; data: Buffer } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) return null;
    const row = (await this.pool.query(
      `SELECT a.mime_type, a.data_url FROM sommelier_attachments a
       JOIN sommelier_messages m ON m.id = a.message_id
       JOIN sommelier_conversations c ON c.id = m.conversation_id
       WHERE a.id = $1 AND c.user_id = $2`,
      [attachmentId, userId],
    )).rows[0];
    if (!row) return null;
    const base64 = String(row.data_url).slice(String(row.data_url).indexOf(",") + 1);
    return { mimeType: row.mime_type, data: Buffer.from(base64, "base64") };
  }

  private async attachmentsOf(messageIds: string[]) {
    const byMessage = new Map<string, AttachmentInfo[]>();
    if (!messageIds.length) return byMessage;
    const rows = (await this.pool.query(
      `SELECT id, message_id, kind, mime_type, duration_ms FROM sommelier_attachments WHERE message_id = ANY($1::uuid[]) ORDER BY created_at ASC`,
      [messageIds],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows;
    for (const row of rows) {
      const list = byMessage.get(String(row.message_id)) ?? [];
      list.push({ id: String(row.id), kind: row.kind as "image" | "audio", mimeType: String(row.mime_type), durationMs: row.duration_ms == null ? null : Number(row.duration_ms) });
      byMessage.set(String(row.message_id), list);
    }
    return byMessage;
  }

  async deleteConversation(userId: string, conversationId: string) {
    await this.ownedConversation(userId, conversationId);
    await this.pool.query(`DELETE FROM sommelier_conversations WHERE id = $1`, [conversationId]);
  }

  /**
   * The wine list of this turn: the one the app sent (wineListId), the one of the
   * restaurant the question names, or the one the conversation already consults.
   */
  private async wineListFor(userId: string, text: string, requested: string | undefined, current: string | null | undefined): Promise<WineListContext | null> {
    if (!this.wineLists) {
      if (requested) throw new HttpError(503, "A consulta de cartas está indisponível agora.", "Service Unavailable");
      return null;
    }
    if (requested) {
      const list = await this.wineLists.forUser(userId, requested);
      if (!list) throw notFound("Carta não encontrada.");
      return list;
    }
    const named = text ? await this.wineLists.mentioned(userId, text) : null;
    if (named) return named;
    return current ? this.wineLists.forUser(userId, current) : null;
  }

  async chat(userId: string, input: { conversationId?: string; message: string; attachments?: unknown; wineListId?: string }) {
    const text = input.message.trim();
    const media = parseAttachments(input.attachments);
    if (!text && !media.length) throw new HttpError(400, "Escreva sua pergunta, envie uma foto ou grave um áudio para o Sommelier.", "Bad Request");
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
    const wineList = await this.wineListFor(userId, text, input.wineListId, existing?.wineListId);
    const history = existing ? (await this.pool.query(
      `SELECT id, role, content, reasoning_details FROM (
         SELECT id, role, content, reasoning_details, created_at FROM sommelier_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2
       ) recent ORDER BY created_at ASC`,
      [existing.id, settings.historyMessages],
    )).rows as Array<{ id?: string; role: "user" | "assistant"; content: string; reasoning_details: unknown }> : [];
    const pastMedia = await this.attachmentsOf(history.map((turn) => turn.id).filter((id): id is string => Boolean(id)));

    // Photos and audio go to the media model; reasoning_details only return to the model that wrote them.
    const withMedia = media.length > 0;
    // With a wine list in the prompt, reasoning models think with low effort: unbounded
    // reasoning over 100+ wines passed the 50 s limit in tests with the real lists.
    const turnSettings: SommelierConfig = withMedia ? { ...settings, model: settings.mediaModel, reasoningEnabled: false }
      : wineList ? { ...settings, reasoningEffort: "low" } : settings;
    const userContent: string | ContentPart[] = withMedia ? [
      { type: "text", text: text || (media.some((item) => item.kind === "audio") ? "Responda à minha mensagem de voz." : "O que você me diz sobre esta foto?") },
      ...media.map((item): ContentPart => (item.kind === "image"
        ? { type: "image_url", image_url: { url: item.dataUrl } }
        : { type: "input_audio", input_audio: { data: item.base64, format: item.format! } })),
    ] : text;
    const messages: ChatTurn[] = [
      { role: "system", content: [settings.systemPrompt, withMedia ? MEDIA_GUIDE : null, wineList ? wineListInstructions(wineList) : null].filter(Boolean).join("\n") },
      ...history.map((turn): ChatTurn => {
        const note = turn.id ? mediaNote(pastMedia.get(turn.id) ?? []) : "";
        const content = [note, turn.content].filter(Boolean).join(" ") || "(mensagem sem texto)";
        return turn.role === "assistant" && turn.reasoning_details && !withMedia ? { role: turn.role, content, reasoning_details: turn.reasoning_details } : { role: turn.role, content };
      }),
      { role: "user", content: userContent },
    ];

    // Ask the model first: nothing is stored (and nothing counts toward the
    // daily limit) when the model fails.
    const startedAt = Date.now();
    const completion = await this.complete(messages, turnSettings);
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
        `INSERT INTO sommelier_conversations (user_id, title, wine_list_id) VALUES ($1, $2, $3) RETURNING id, title, created_at AS "createdAt", updated_at AS "updatedAt", wine_list_id AS "wineListId"`,
        [userId, conversationTitle(text, media, wineList), wineList?.id ?? null],
      )).rows[0];
      userMessage = (await client.query(
        `INSERT INTO sommelier_messages (conversation_id, role, content, created_at) VALUES ($1, 'user', $2, now() - interval '1 millisecond') RETURNING id, role, content, created_at AS "createdAt"`,
        [conversation.id, text],
      )).rows[0];
      const stored: AttachmentInfo[] = [];
      for (const item of media) {
        const saved = (await client.query(
          `INSERT INTO sommelier_attachments (message_id, kind, mime_type, data_url, duration_ms) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [userMessage.id, item.kind, item.mimeType, item.dataUrl, item.durationMs ?? null],
        )).rows[0];
        stored.push({ id: String(saved.id), kind: item.kind, mimeType: item.mimeType, durationMs: item.durationMs ?? null });
      }
      if (stored.length) userMessage = { ...userMessage, attachments: stored };
      reply = (await client.query(
        `INSERT INTO sommelier_messages (conversation_id, role, content, reasoning_details, model, prompt_tokens, completion_tokens, cost_usd, duration_ms, wine_list_id)
         VALUES ($1, 'assistant', $2, $3::jsonb, $4, $5, $6, $7, $8, $9) RETURNING id, role, content, created_at AS "createdAt"`,
        [conversation.id, guarded.content, guarded.blocked || withMedia || completion.reasoningDetails == null ? null : JSON.stringify(completion.reasoningDetails), completion.model, completion.promptTokens ?? null, completion.completionTokens ?? null, completion.costUsd ?? null, durationMs, wineList?.id ?? null],
      )).rows[0];
      // The conversation keeps consulting the list of this turn in the next questions.
      await client.query(`UPDATE sommelier_conversations SET updated_at = now(), wine_list_id = coalesce($2, wine_list_id) WHERE id = $1`, [conversation.id, wineList?.id ?? null]);
      if (wineList) conversation = { ...conversation, wineListId: wineList.id };
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const consulted: WineListSummary | null = wineList ? summaryOf(wineList) : null;
    return { conversation, userMessage, reply, remainingToday: Math.max(0, settings.dailyMessageLimit - sentToday - 1), wineList: consulted };
  }

  private async ownedConversation(userId: string, conversationId: string): Promise<SommelierConversation> {
    if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw notFound("Conversa não encontrada.");
    const row = (await this.pool.query(
      `SELECT id, title, created_at AS "createdAt", updated_at AS "updatedAt", wine_list_id AS "wineListId" FROM sommelier_conversations WHERE id = $1 AND user_id = $2`,
      [conversationId, userId],
    )).rows[0];
    if (!row) throw notFound("Conversa não encontrada.");
    return row;
  }
}

function conversationTitle(text: string, media: Array<{ kind: string }>, wineList?: WineListContext | null) {
  if (!text && wineList?.restaurantName) return `Carta de ${wineList.restaurantName}`;
  if (text) return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  return media.some((item) => item.kind === "audio") ? "Mensagem de voz" : "Foto para o Sommelier";
}
