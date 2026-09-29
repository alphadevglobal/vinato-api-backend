import { config } from "./config.js";
import { defaultScannerModels, type ScannerModelSettingsProvider } from "./ai-model-settings.js";
import { internalServerError } from "./http-error.js";
import type { ScanTrace } from "./scan-audit.repository.js";
import type { ScanWineLabelResult, ScannedWineData, WineScanner } from "./types.js";

const scannerPrompt = `
Voce le rotulos de vinho para localizar o vinho no catalogo Vinato.
Transcreva com fidelidade o texto impresso: produtor, nome do vinho (cuvee/linha),
safra, pais, regiao, classificacao, uvas, volume e teor alcoolico. Preserve acentos
e a grafia do rotulo. Diferencie produtor, nome do vinho e classificacao.

Rotulos artisticos (ilustracao/gravura, nome pequeno ou curvado): NAO tente
adivinhar o vinho pela arte. Transcreva os trechos de texto que estiverem legiveis
(ex.: "MALBEC ARGENTINO", "BODEGA ...") nos campos correspondentes e deixe o
produtor como null se o nome dele nao estiver escrito. Um nome inventado impede
que o vinho seja encontrado no catalogo; um campo vazio nao.

Regras:
- Ignore marcacoes feitas a mao, etiquetas de preco ou de loja: numeros escritos a
  mao NAO sao a safra.
- vintage: somente o ano de 4 digitos impresso no rotulo, ou null.
- displayName: "Produtor + Nome do vinho", sem safra e sem volume.
- colour: tinto, branco, rose ou espumante, quando indicado.
- Use null quando nao estiver visivel. Nunca invente produtor, vinho ou safra.

Alem da transcricao, para a ficha do vinho no app:
- description: 2 a 3 frases em portugues do Brasil sobre o estilo do vinho (uvas,
  regiao, perfil de aromas e paladar), usando conhecimento enologico geral
  coerente com o rotulo. null se voce nao reconhecer o vinho nem o estilo.
- foodPairings: lista com ate 5 pratos que harmonizam com este vinho, em portugues.
Esses dois campos nunca alteram a transcricao: produtor, vinho e safra continuam
sendo apenas o que esta impresso.

Responda somente JSON valido, sem markdown, com estas chaves:
displayName, producerTitle, producerName, wine, country, region, subRegion,
colour, type, subType, designation, classification, vintage, alcoholContent,
grapes, volume, description, foodPairings, confidence, notes. confidence e um numero de 0 a 1.
`;

export class OpenRouterWineScanner implements WineScanner {
  constructor(private readonly settings?: ScannerModelSettingsProvider) {}

  async scanWineLabel(file: Express.Multer.File, trace?: ScanTrace): Promise<ScanWineLabelResult> {
    if (!config.openRouterApiKey) {
      throw internalServerError("Serviço de reconhecimento temporariamente indisponível.");
    }

    const imageDataUrl = `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
    const models = this.settings ? await this.settings.getScannerModels() : defaultScannerModels();
    // Primary model first; the stronger fallback only reads the label when the
    // primary fails or returns a weak reading. (Racing both returned whichever
    // answered first, not whichever read better.)
    const startedAt = Date.now();
    let data: ScannedWineData | undefined;
    let modelUsed: string | undefined;
    try {
      data = await identifyWithModel(models.model, imageDataUrl, trace);
      modelUsed = models.model;
    } catch {
      data = undefined;
    }
    if ((!data || isWeakReading(data)) && models.fallbackModel !== models.model) {
      try {
        const second = await identifyWithModel(models.fallbackModel, imageDataUrl, trace);
        if (!data || readingScore(second) > readingScore(data)) { data = second; modelUsed = models.fallbackModel; }
      } catch {
        // Keep the primary reading, if any.
      }
    }
    if (trace) { trace.modelUsed = modelUsed; trace.recognitionMs = Date.now() - startedAt; }
    if (!data) throw internalServerError("Não foi possível concluir a leitura do rótulo agora.");
    return { data, success: true };
  }
}

async function identifyWithModel(model: string, imageDataUrl: string, trace?: ScanTrace) {
  const startedAt = Date.now();
  const attempt = (ok: boolean, extra: { status?: number; error?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number } = {}) =>
    trace?.modelsTried.push({ model, ok, ms: Date.now() - startedAt, ...extra });
  try {
    const response = await callOpenRouter(model, imageDataUrl);
    if (!response.ok) throw Object.assign(new Error(`MODEL_${response.status}: ${response.body.slice(0, 200)}`), { status: response.status });
    const parsed = parseModelJson(response.payload.choices?.[0]?.message?.content);
    const data = normalizeScannedWineData(parsed);
    if (!hasWineIdentity(data)) throw new Error("EMPTY_WINE_IDENTITY: o modelo não identificou produtor nem vinho");
    attempt(true, {
      status: 200,
      promptTokens: response.payload.usage?.prompt_tokens,
      completionTokens: response.payload.usage?.completion_tokens,
      totalTokens: response.payload.usage?.total_tokens,
    });
    return data;
  } catch (error) {
    attempt(false, { status: (error as { status?: number }).status, error: (error as Error).message });
    throw error;
  }
}

type OpenRouterPayload = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
};

type OpenRouterResult =
  | { ok: true; payload: OpenRouterPayload }
  | { ok: false; status: number; body: string };

async function callOpenRouter(
  model: string,
  imageDataUrl: string,
): Promise<OpenRouterResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18_000);
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
    vintage: printedVintage(data.vintage),
    alcoholContent: nullableString(data.alcoholContent),
    grapes: nullableString(data.grapes),
    volume: nullableString(data.volume),
    description: nullableString(data.description),
    foodPairings: stringList(data.foodPairings),
    confidence: confidence(data.confidence),
    notes: typeof data.notes === "string" ? data.notes : "",
  };
}

// Models sometimes write missing values as text ("null", "N/A") or glue them
// into a name ("null MALBEC ARGENTINO"), which breaks the catalog match.
const EMPTY_WORDS = /\b(null|undefined|none|n\/a|n\/d|nao informado|não informado|desconhecido|unknown)\b/gi;

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const cleaned = value.replace(EMPTY_WORDS, " ").replace(/\s+/g, " ").trim();
  return cleaned && !/^[-–—.]+$/.test(cleaned) ? cleaned : null;
}

function stringList(value: unknown): string[] | null {
  const items = (Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : [])
    .map((item) => nullableString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 5);
  return items.length ? items : null;
}

function confidence(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

function isWeakReading(data: ScannedWineData) {
  return data.confidence < 0.6 || !(data.displayName || (data.producerName && data.wine));
}

function readingScore(data: ScannedWineData) {
  return (data.displayName ? 1 : data.producerName && data.wine ? 0.8 : 0) + data.confidence;
}

// Handwritten store/cellar marks (e.g. "2.040" on the glass) are often read as the
// vintage, which then breaks the catalog match. Keep only plausible years.
function printedVintage(value: unknown): string | null {
  const year = nullableString(value)?.match(/\b(1[89]\d{2}|20\d{2})\b/)?.[1];
  if (!year) return null;
  return Number(year) <= new Date().getFullYear() ? year : null;
}

function hasWineIdentity(data: ScannedWineData) {
  return Boolean(data.displayName || data.producerName || data.producerTitle || data.wine);
}
