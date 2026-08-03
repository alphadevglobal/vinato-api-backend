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
      throw internalServerError("OPENROUTER_API_KEY não configurada.");
    }

    const imageDataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost",
        "X-Title": "Wine API",
      },
      body: JSON.stringify({
        model: config.openRouterModel,
        response_format: { type: "json_object" },
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

    if (!response.ok) {
      throw internalServerError("Falha na comunicação com a API OpenRouter.");
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    const parsed = parseModelJson(content);

    return {
      data: normalizeScannedWineData(parsed),
      success: true,
    };
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

  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();

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
