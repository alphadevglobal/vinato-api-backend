import { defaultWineListModels, type WineListModelSettingsProvider } from "./ai-model-settings.js";
import { requestJsonWithFallback, totalUsage, type ContentPart, type ModelAttempt, type OpenRouterUsage } from "./openrouter.js";

/**
 * "Verificação de carta": the AI transcribes a restaurant wine list (photos or a
 * PDF) and then acts as a critical sommelier, comparing the bottle served at the
 * table with the wine chosen on the list.
 */
export type WineListItem = {
  section: string | null; name: string; producer: string | null; vintage: number | null; country: string | null;
  region: string | null; grapes: string | null; style: string | null; volume: string | null;
  price: number | null; glassPrice: number | null; currency: string; notes: string | null;
};
export type Transcription = {
  restaurant: { name: string | null; city: string | null };
  items: WineListItem[];
  model: string | null; attempts: ModelAttempt[]; usage: OpenRouterUsage;
  // Pages (1-based) no model could read; the other pages are still returned.
  unreadPages: number[]; pages: number;
};
export type Verdict = "match" | "mismatch" | "uncertain";
export type BottleCheck = {
  verdict: Verdict; confidence: number; explanation: string;
  observed: { producer: string | null; wine: string | null; vintage: string | null; region: string | null; country: string | null; volume: string | null };
  differences: { field: string; menu: string | null; bottle: string | null }[];
  model: string | null; attempts: ModelAttempt[]; usage: OpenRouterUsage;
};
export type ListFile = { mimetype: string; dataUrl: string };

export const transcriptionPrompt = (hint: { restaurantName?: string | null; city?: string | null }, page?: { index: number; total: number }) => `
Voce e um sommelier que transcreve cartas de vinho de restaurantes para o app Vinato.
${page && page.total > 1 ? `Esta imagem e a pagina ${page.index} de ${page.total} da carta. Transcreva TODOS os vinhos DESTA pagina, na ordem em que aparecem.` : "Transcreva TODOS os vinhos da carta nas imagens/PDF, na ordem em que aparecem."}
${hint.restaurantName ? `Restaurante informado pelo cliente: ${hint.restaurantName}${hint.city ? ` (${hint.city})` : ""}.` : ""}

Para cada vinho:
- section: a secao da carta em que ele esta; junte os titulos que valem para ele (ex.: "Chile · Tintos", "Espumantes", "Por taca").
- name: o nome do vinho como impresso na linha do item, SEM codigo/numero do item, safra, regiao, volume ou preco
  (esses vao nos proprios campos). Nao repita o produtor no nome se ele nao estiver escrito na linha.
- producer, vintage (ano com 4 digitos), country (tambem pelo titulo ou bandeira da secao), region, grapes, style (tinto, branco, rose, espumante, fortificado, sobremesa).
- volume: ex. "750 ml", "375 ml", "1,5 L" quando indicado.
- price: preco da garrafa como numero (ex.: 289.90); glassPrice: preco da taca como numero, quando houver.
- currency: moeda (BRL, USD, EUR...). notes: observacoes impressas e o codigo do item (ex.: "Cod. 687").
Nao invente vinhos, produtores, safras ou precos. Omita os campos que nao estiverem na carta (nao escreva null),
para a resposta ficar curta. Taxas e servicos (ex.: rolha) nao sao vinhos.
Se a carta mostrar o nome do restaurante ou a cidade, informe em restaurant.

Responda somente JSON valido, sem markdown:
{"restaurant": {"name", "city"}, "items": [ {section, name, producer, vintage, country, region, grapes, style, volume, price, glassPrice, currency, notes} ]}
`;

export const bottleCheckPrompt = (item: Pick<WineListItem, "name" | "producer" | "vintage" | "region" | "country" | "volume" | "style">) => `
Voce e um sommelier critico e independente a servico do cliente de um restaurante.
O cliente pediu este vinho da carta:
${JSON.stringify(item)}
A foto mostra a garrafa que foi servida na mesa. Leia o rotulo e verifique se e
exatamente o vinho pedido: mesmo produtor, mesmo vinho/linha (Reserva, Gran Reserva,
Premium, varietal etc. contam como vinhos diferentes), mesma safra quando a carta
informa a safra, e mesmo volume quando indicado.

verdict:
- "match": o rotulo corresponde ao vinho da carta.
- "mismatch": ha divergencia (produtor, linha, safra, uva ou volume diferentes).
- "uncertain": a foto nao permite ler o rotulo com seguranca.

Responda somente JSON valido, sem markdown:
{"verdict": "match"|"mismatch"|"uncertain", "confidence": 0-1,
 "observed": {"producer", "wine", "vintage", "region", "country", "volume"},
 "differences": [{"field": "producer"|"wine"|"vintage"|"grapes"|"volume"|"country"|"region"|"other", "menu": string|null, "bottle": string|null}],
 "explanation": "1 a 2 frases em portugues do Brasil para o cliente"}
`;

const EMPTY = /^(null|undefined|none|n\/a|n\/d|-+|desconhecido|unknown)$/i;
const text = (value: unknown) => {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() && !EMPTY.test(value.trim()) ? value.trim() : null;
};
/** "R$ 1.289,90", "289.9", 289.9 → 289.9 */
export function money(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
  const raw = text(value)?.replace(/[^\d.,]/g, "");
  if (!raw) return null;
  const normalized = /,\d{1,2}$/.test(raw) ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null;
}
const year = (value: unknown) => {
  const match = text(value)?.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return match && Number(match[1]) <= new Date().getFullYear() ? Number(match[1]) : null;
};

const words = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);

/**
 * Models sometimes prefix the producer to a name that already has it:
 * "Casa Valduga Casa Valduga Origem" or "Viña Morandé Morandé Pionero" → the
 * printed name ("Casa Valduga Origem", "Morandé Pionero").
 */
export function withoutRepeatedProducer(name: string, producer: string | null) {
  if (!producer || !name.toLowerCase().startsWith(`${producer.toLowerCase()} `)) return name;
  const rest = name.slice(producer.length).replace(/^[\s\-–·,]+/, "");
  const restWords = new Set(words(rest));
  return rest && words(producer).some((word) => restWords.has(word)) ? rest : name;
}

export function normalizeItems(value: unknown): WineListItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): WineListItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const producer = text(item.producer);
    const name = withoutRepeatedProducer(text(item.name) ?? [producer, text(item.wine)].filter(Boolean).join(" "), producer);
    if (!name) return [];
    return [{
      section: text(item.section), name, producer: text(item.producer), vintage: year(item.vintage), country: text(item.country),
      region: text(item.region), grapes: Array.isArray(item.grapes) ? item.grapes.map(text).filter(Boolean).join(", ") || null : text(item.grapes),
      style: text(item.style), volume: text(item.volume), price: money(item.price), glassPrice: money(item.glassPrice),
      currency: text(item.currency)?.toUpperCase().slice(0, 3) ?? "BRL", notes: text(item.notes),
    }];
  }).slice(0, 400);
}

const VERDICTS: Verdict[] = ["match", "mismatch", "uncertain"];
export function normalizeCheck(json: Record<string, unknown>): Omit<BottleCheck, "model" | "attempts" | "usage"> {
  const observed = (json.observed && typeof json.observed === "object" ? json.observed : {}) as Record<string, unknown>;
  const confidence = Number(json.confidence);
  const differences = Array.isArray(json.differences) ? json.differences.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const difference = raw as Record<string, unknown>;
    return [{ field: text(difference.field) ?? "other", menu: text(difference.menu), bottle: text(difference.bottle) }];
  }) : [];
  const verdict = VERDICTS.includes(json.verdict as Verdict) ? json.verdict as Verdict : "uncertain";
  return {
    // A "match" that still lists differences is not a match.
    verdict: verdict === "match" && differences.length ? "mismatch" : verdict,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    explanation: text(json.explanation) ?? (verdict === "uncertain" ? "Não foi possível ler o rótulo com segurança." : ""),
    observed: {
      producer: text(observed.producer), wine: text(observed.wine), vintage: text(observed.vintage), region: text(observed.region),
      country: text(observed.country), volume: text(observed.volume),
    },
    differences,
  };
}

// Vercel stops the function at 60 s (vercel.json) and the iPhone gives up on a silent
// request at about 60 s: the models get 45 s, leaving time to save the list and answer.
export const TRANSCRIPTION_BUDGET_MS = 45_000;
export const CHECK_BUDGET_MS = 45_000;

const itemKey = (item: WineListItem) => `${normalizeKey(item.name)}|${item.vintage ?? ""}|${item.price ?? ""}|${item.volume ?? ""}`;
const normalizeKey = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The pages in order. Photos of consecutive pages often overlap: a wine that ends
 * one page and starts the next (same name, vintage, price and volume) is kept once.
 */
export function mergePages(pages: WineListItem[][]) {
  const merged: WineListItem[] = [];
  let previous = new Set<string>();
  for (const items of pages) {
    const current = new Set<string>();
    for (const item of items) {
      const key = itemKey(item);
      current.add(key);
      if (!previous.has(key)) merged.push(item);
    }
    previous = current;
  }
  return merged.slice(0, 400);
}

const filePart = (file: ListFile, index: number): ContentPart => file.mimetype === "application/pdf"
  ? { type: "file", file: { filename: `carta-${index + 1}.pdf`, file_data: file.dataUrl } }
  : { type: "image_url", image_url: { url: file.dataUrl } };

export class OpenRouterWineListAgent {
  constructor(private readonly settings?: WineListModelSettingsProvider) {}

  private models() {
    return this.settings ? this.settings.getWineListModels() : Promise.resolve(defaultWineListModels());
  }

  /**
   * Each photo is one page, read by its own model call in parallel: a long list in
   * a single call overflows the output limit and the function time. A PDF is read
   * in one call. Everything shares one deadline, so the route always answers (and
   * logs) before Vercel stops the function; pages left unread are reported.
   */
  async transcribe(files: ListFile[], hint: { restaurantName?: string | null; city?: string | null }, options: { deadline?: number } = {}): Promise<Transcription> {
    const models = await this.models();
    const deadline = options.deadline ?? Date.now() + TRANSCRIPTION_BUDGET_MS;
    const pages = files.some((file) => file.mimetype === "application/pdf") || files.length === 1 ? [files] : files.map((file) => [file]);
    const replies = await Promise.all(pages.map((pageFiles, index) => {
      const page = pages.length > 1 ? { index: index + 1, total: pages.length } : undefined;
      const content: ContentPart[] = [{ type: "text", text: transcriptionPrompt(hint, page) }, ...pageFiles.map(filePart)];
      return requestJsonWithFallback(models, content, {
        maxTokens: pages.length > 1 ? 8_000 : 16_000, title: "Vinato cartas", deadline, page: page?.index,
        // A page may legitimately have no wine (cover, corkage); a whole list may not.
        accept: (json) => pages.length > 1 ? Array.isArray(json.items) : normalizeItems(json.items).length > 0,
      });
    }));
    const attempts = replies.flatMap((reply) => reply.attempts);
    const restaurants = replies.map((reply) => (reply.json?.restaurant && typeof reply.json.restaurant === "object" ? reply.json.restaurant : {}) as Record<string, unknown>);
    return {
      restaurant: { name: restaurants.map((item) => text(item.name)).find(Boolean) ?? null, city: restaurants.map((item) => text(item.city)).find(Boolean) ?? null },
      items: mergePages(replies.map((reply) => normalizeItems(reply.json?.items))),
      model: replies.find((reply) => reply.model)?.model ?? null, attempts, usage: totalUsage(attempts),
      unreadPages: pages.length > 1 ? replies.flatMap((reply, index) => reply.json ? [] : [index + 1]) : [],
      pages: pages.length,
    };
  }

  async checkBottle(item: WineListItem, imageDataUrl: string, options: { deadline?: number } = {}): Promise<BottleCheck | null> {
    const content: ContentPart[] = [
      { type: "text", text: bottleCheckPrompt(item) },
      { type: "image_url", image_url: { url: imageDataUrl } },
    ];
    const reply = await requestJsonWithFallback(await this.models(), content, { maxTokens: 4000, timeoutMs: 40_000, title: "Vinato cartas", deadline: options.deadline ?? Date.now() + CHECK_BUDGET_MS });
    if (!reply.json) return { verdict: "uncertain", confidence: 0, explanation: "", observed: { producer: null, wine: null, vintage: null, region: null, country: null, volume: null }, differences: [], model: null, attempts: reply.attempts, usage: totalUsage(reply.attempts) };
    return { ...normalizeCheck(reply.json), model: reply.model, attempts: reply.attempts, usage: totalUsage(reply.attempts) };
  }
}
