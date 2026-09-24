import { config } from "./config.js";
import { internalServerError } from "./http-error.js";
import type { ScanWineLabelResult, ScannedWineData, WineScanner } from "./types.js";

const scannerPrompt = `
Extraia dados estruturados de um rotulo de vinho.
Responda somente JSON valido, sem markdown, com estas chaves:
displayName, producerTitle, producerName, wine, country, region, subRegion,
colour, type, subType, designation, classification, vintage, alcoholContent,
grapes, volume, confidence, notes.
Use null quando uma informacao nao estiver visivel. confidence deve ser numero de 0 a 1.
`;

export class OpenRouterWineScanner implements WineScanner {
  async scanWineLabel(file: Express.Multer.File): Promise<ScanWineLabelResult> {
    if (!config.openRouterApiKey) {
      throw internalServerError("Serviço de reconhecimento temporariamente indisponível.");
    }

    const imageDataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
    // Free vision providers can be temporarily rate-limited. Try independent
    // providers and only accept a response that actually identifies a label.
    const preferredModels = [...new Set([config.openRouterModel, config.openRouterFallbackModel])];
    try {
      const data = await Promise.any(preferredModels.map((model) => identifyWithModel(model, imageDataUrl)));
      return { data, success: true };
    } catch {
      // Keep the endpoint responsive. The route records the label for manual
      // review when both independent providers are unavailable.
      throw internalServerError("Não foi possível concluir a leitura do rótulo agora.");
    }
  }
}

async function identifyWithModel(model: string, imageDataUrl: string) {
  const response = await callOpenRouter(model, imageDataUrl);
  if (!response.ok) throw new Error(`MODEL_${response.status}`);
  const parsed = parseModelJson(response.payload.choices?.[0]?.message?.content);
  const data = normalizeScannedWineData(parsed);
  if (!hasWineIdentity(data)) throw new Error("EMPTY_WINE_IDENTITY");
  return data;
}

type OpenRouterPayload = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

type OpenRouterResult =
  | { ok: true; payload: OpenRouterPayload }
  | { ok: false; status: number; body: string };

async function callOpenRouter(
  model: string,
  imageDataUrl: string,
): Promise<OpenRouterResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost",
      "X-Title": "Wine API",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2500,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: scannerPrompt },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
    }),
    });
  } catch {
    return { ok: false, status: 408, body: "request_timeout" };
  } finally {
    clearTimeout(timeout);
  }

  const body = await response.text();
  if (!response.ok) {
    return { ok: false, status: response.status, body };
  }

  try {
    return { ok: true, payload: JSON.parse(body) as OpenRouterPayload };
  } catch {
    throw internalServerError("Resposta inválida da API OpenRouter.");
  }
}

function parseModelJson(content: unknown): Record<string, unknown> {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((item) =>
              typeof item === "string"
                ? item
                : typeof item?.text === "string"
                  ? item.text
                  : "",
            )
            .join("")
        : "";

  let cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

  const objectStart = cleaned.indexOf("{");
  const objectEnd = cleaned.lastIndexOf("}");
  if (objectStart >= 0 && objectEnd > objectStart) {
    cleaned = cleaned.slice(objectStart, objectEnd + 1);
  }

  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw internalServerError("Resposta inválida da API OpenRouter.");
  }
}

function normalizeScannedWineData(data: Record<string, unknown>): ScannedWineData {
  return {
    displayName: nullableString(data.displayName),
    producerTitle: nullableString(data.producerTitle),
    producerName: nullableString(data.producerName),
    wine: nullableString(data.wine),
    country: nullableString(data.country),
    region: nullableString(data.region),
    subRegion: nullableString(data.subRegion),
    colour: nullableString(data.colour),
    type: nullableString(data.type),
    subType: nullableString(data.subType),
    designation: nullableString(data.designation),
    classification: nullableString(data.classification),
    vintage: nullableString(data.vintage),
    alcoholContent: nullableString(data.alcoholContent),
    grapes: nullableString(data.grapes),
    volume: nullableString(data.volume),
    confidence: confidence(data.confidence),
    notes: typeof data.notes === "string" ? data.notes : "",
  };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return null;
}

function confidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

function hasWineIdentity(data: ScannedWineData) {
  return Boolean(data.displayName || data.producerName || data.producerTitle || data.wine);
}
