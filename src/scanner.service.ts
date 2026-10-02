import { config } from "./config.js";
import { defaultScannerModels, type ScannerModelSettingsProvider } from "./ai-model-settings.js";
import { internalServerError } from "./http-error.js";
import type { ScanTrace } from "./scan-audit.repository.js";
import type { ScanWineLabelResult, ScannedWineData, WineScanner } from "./types.js";
import { requestJson } from "./openrouter.js";

export const scannerPrompt = `
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

- agingPotential: somente se o rotulo imprimir o tempo de guarda (ex.: "Guardar ate 2032"); senao null.
- notes: no maximo 10 palavras, ou "".

Responda somente JSON valido, sem markdown e sem espacos extras, com estas chaves:
displayName, producerTitle, producerName, wine, country, region, subRegion,
colour, type, subType, designation, classification, vintage, alcoholContent,
grapes, volume, agingPotential, confidence, notes. confidence e um numero de 0 a 1.
`;

/**
 * The wine sheet of a wine the scan created (description, pairings, tempo de guarda,
 * janela de uso). Written after the app already got its answer: the label reading
 * the user waits for stays short (scannerPrompt), and this call reads no image.
 */
export const wineSheetPrompt = (reading: ScannedWineData) => `
Voce e um sommelier escrevendo a ficha de um vinho para o app Vinato.
Vinho lido no rotulo: ${JSON.stringify(Object.fromEntries(Object.entries(reading).filter(([key, value]) => value !== null && value !== "" && !["confidence", "notes", "description", "foodPairings"].includes(key))))}

Responda somente JSON valido, sem markdown, com as chaves:
- description: 2 a 3 frases em portugues do Brasil sobre o estilo do vinho (uvas, regiao, aromas e paladar). null se nao reconhecer o estilo.
- foodPairings: ate 5 pratos que harmonizam, em portugues.
- agingPotential: tempo de guarda conhecido deste vinho ou produtor, em portugues (ex.: "5 a 8 anos a partir da safra"); null se nao souber.
- drinkingWindow: como o vinho evolui em anos apos a safra, 2 a 4 fases [{"from":1,"to":3,"note":"..."}], com "plus": true na ultima fase se continuar; null se nao souber.
Nunca invente produtor, nome ou safra.
`;

export type WineSheet = { description: string | null; foodPairings: string[] | null; agingPotential: string | null; drinkingWindow: { from: number; to: number | null; plus?: boolean; note: string }[] | null };

/** The model's sheet answer → the fields to fill (invalid parts dropped). */
export function normalizeWineSheet(json: Record<string, unknown>): WineSheet {
  const window = Array.isArray(json.drinkingWindow) ? json.drinkingWindow.flatMap((item) => {
    const phase = (item ?? {}) as Record<string, unknown>;
    const from = Number(phase.from);
    const to = phase.to === null || phase.to === undefined ? null : Number(phase.to);
    const note = typeof phase.note === "string" ? phase.note.trim() : "";
    if (!Number.isInteger(from) || from < 0 || !note || (to !== null && (!Number.isInteger(to) || to < from))) return [];
    return [{ from, to, ...(phase.plus === true ? { plus: true } : {}), note }];
  }).sort((a, b) => a.from - b.from).slice(0, 8) : [];
  return {
    description: nullableString(json.description), foodPairings: stringList(json.foodPairings),
    agingPotential: nullableString(json.agingPotential), drinkingWindow: window.length ? window : null,
  };
}

export class OpenRouterWineScanner implements WineScanner {
  constructor(private readonly settings?: ScannerModelSettingsProvider) {}

  /** The sheet of a wine the scan created, from the reading only (no image). Null when the model fails. */
  async describeWine(reading: ScannedWineData): Promise<WineSheet | null> {
    if (!config.openRouterApiKey) return null;
    const models = this.settings ? await this.settings.getScannerModels() : defaultScannerModels();
    const reply = await requestJson(models.model, [{ type: "text", text: wineSheetPrompt(reading) }], { maxTokens: 1500, timeoutMs: 30_000, title: "Wine API ficha" });
    return reply.ok ? normalizeWineSheet(reply.json) : null;
  }

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
    // A fallback equal to the primary would never run: use the default one instead
    // (a slow or broken primary must still get a second chance).
    const fallbackModel = models.fallbackModel !== models.model ? models.fallbackModel : defaultScannerModels().fallbackModel;
    if ((!data || isWeakReading(data)) && fallbackModel !== models.model) {
      try {
        const second = await identifyWithModel(fallbackModel, imageDataUrl, trace);
        if (!data || readingScore(second) > readingScore(data)) { data = second; modelUsed = fallbackModel; }
      } catch {
        // Keep the primary reading, if any.
      }
    }
    if (trace) { trace.modelUsed = modelUsed; trace.recognitionMs = Date.now() - startedAt; }
    if (!data) throw internalServerError("Não foi possível concluir a leitura do rótulo agora.");
    return { data, success: true };
  }
}

// Each attempt gets 22 s: primary + fallback fit in the 60 s of the function and
// of the app. Thinking models answer with low reasoning effort and a JSON object.
const ATTEMPT_TIMEOUT_MS = 22_000;

async function identifyWithModel(model: string, imageDataUrl: string, trace?: ScanTrace) {
  const startedAt = Date.now();
  const attempt = (ok: boolean, extra: { status?: number; error?: string; promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number } = {}) =>
    trace?.modelsTried.push({ model, ok, ms: Date.now() - startedAt, ...extra });
  const reply = await requestJson(model, [
    { type: "text", text: scannerPrompt },
    { type: "image_url", image_url: { url: imageDataUrl } },
  ], { maxTokens: 4000, timeoutMs: ATTEMPT_TIMEOUT_MS, title: "Wine API" });
  // An answer that fails validation is billed too, so its usage is kept on the failed attempt.
  const usage = reply.usage ?? {};
  if (!reply.ok) {
    const message = reply.status === 408 ? "MODEL_TIMEOUT: o modelo não respondeu a tempo"
      : reply.error === "answer_cut_by_token_limit" ? "MODEL_CUT: resposta cortada pelo limite de tokens"
      : reply.error === "invalid_json_answer" ? "MODEL_INVALID_JSON: resposta sem JSON válido"
      : `MODEL_${reply.status}: ${reply.error.slice(0, 200)}`;
    attempt(false, { status: reply.status, error: message, ...usage });
    throw Object.assign(new Error(message), { status: reply.status });
  }
  const data = normalizeScannedWineData(reply.json);
  if (!hasWineIdentity(data)) {
    attempt(false, { status: 200, error: "EMPTY_WINE_IDENTITY: o modelo não identificou produtor nem vinho", ...usage });
    throw new Error("EMPTY_WINE_IDENTITY: o modelo não identificou produtor nem vinho");
  }
  attempt(true, { status: 200, ...usage });
  return data;
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
    agingPotential: nullableString(data.agingPotential),
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
