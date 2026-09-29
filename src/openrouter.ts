import { config } from "./config.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | { type: "file"; file: { filename: string; file_data: string } };

export type OpenRouterUsage = { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number };
export type ModelAttempt = { model: string; ok: boolean; ms: number; status?: number; error?: string } & OpenRouterUsage;

export type JsonReply =
  | { ok: true; json: Record<string, unknown>; usage: OpenRouterUsage }
  | { ok: false; status: number; error: string; usage?: OpenRouterUsage };

type Payload = {
  choices?: { finish_reason?: string; message?: { content?: unknown } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
};

/** Model answer → JSON object (tolerates ```json fences and text around the object). */
export function parseJsonContent(content: unknown): Record<string, unknown> | null {
  const text = typeof content === "string"
    ? content
    : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("") : "";
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  try {
    const parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * One OpenRouter chat call that must answer a JSON object. Thinking models count
 * their reasoning in max_tokens, so reasoning is kept low and the budget generous.
 */
export async function requestJson(
  model: string,
  content: ContentPart[],
  options: { apiKey?: string; maxTokens?: number; timeoutMs?: number; title?: string; webSearch?: boolean } = {},
): Promise<JsonReply> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? config.openRouterApiKey;
  if (!apiKey) return { ok: false, status: 503, error: "OPENROUTER_API_KEY não configurada" };
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? 50_000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Title": options.title ?? "Vinato" },
      body: JSON.stringify({
        model,
        max_tokens: options.maxTokens ?? 6000,
        temperature: 0.1,
        reasoning: { effort: "low" },
        response_format: { type: "json_object" },
        usage: { include: true },
        messages: [{ role: "user", content }],
        ...(options.webSearch ? { plugins: [{ id: "web", max_results: 3 }] } : {}),
      }),
    });
  } catch (error) {
    return { ok: false, status: 408, error: (error as Error).name === "TimeoutError" ? "request_timeout" : (error as Error).message };
  }
  const body = await response.text();
  if (!response.ok) return { ok: false, status: response.status, error: body.slice(0, 300) };
  let payload: Payload;
  try {
    payload = JSON.parse(body) as Payload;
  } catch {
    return { ok: false, status: 502, error: "invalid_openrouter_response" };
  }
  const usage: OpenRouterUsage = {
    promptTokens: payload.usage?.prompt_tokens,
    completionTokens: payload.usage?.completion_tokens,
    totalTokens: payload.usage?.total_tokens,
    costUsd: payload.usage?.cost,
  };
  const json = parseJsonContent(payload.choices?.[0]?.message?.content);
  if (!json) {
    return { ok: false, status: 502, usage, error: payload.choices?.[0]?.finish_reason === "length" ? "answer_cut_by_token_limit" : "invalid_json_answer" };
  }
  return { ok: true, json, usage };
}

/** Tries the primary model, then the fallback; every attempt is recorded (and billed). */
export async function requestJsonWithFallback(
  models: { model: string; fallbackModel: string },
  content: ContentPart[],
  options: Parameters<typeof requestJson>[2] & { accept?: (json: Record<string, unknown>) => boolean } = {},
) {
  const attempts: ModelAttempt[] = [];
  const order = models.fallbackModel && models.fallbackModel !== models.model ? [models.model, models.fallbackModel] : [models.model];
  for (const model of order) {
    const startedAt = Date.now();
    const reply = await requestJson(model, content, options);
    const ok = reply.ok && (options.accept ? options.accept(reply.json) : true);
    attempts.push({ model, ok, ms: Date.now() - startedAt, ...(reply.ok ? { status: 200 } : { status: reply.status, error: reply.error }), ...(reply.usage ?? {}) });
    if (reply.ok && ok) return { json: reply.json, model, attempts };
  }
  return { json: null, model: null, attempts };
}

/** Total usage of a list of attempts. */
export function totalUsage(attempts: ModelAttempt[]): OpenRouterUsage {
  const sum = (key: keyof OpenRouterUsage) => attempts.reduce((total, attempt) => total + (attempt[key] ?? 0), 0);
  const costs = attempts.filter((attempt) => typeof attempt.costUsd === "number");
  return { promptTokens: sum("promptTokens"), completionTokens: sum("completionTokens"), totalTokens: sum("totalTokens"), costUsd: costs.length ? sum("costUsd") : undefined };
}
