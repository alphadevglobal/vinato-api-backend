import { defaultWineListModels, type WineListModelSettingsProvider } from "./ai-model-settings.js";
import { requestJsonWithFallback, totalUsage, type ContentPart, type ModelAttempt, type OpenRouterUsage } from "./openrouter.js";
import { money, TRANSCRIPTION_BUDGET_MS, type ListFile } from "./wine-list.service.js";

/**
 * "Cardápios": the AI transcribes the dishes of a partner restaurant's menu
 * (photos or a PDF), the same way as its wine list. The Sommelier reads both to
 * pair a dish of the menu with a wine of the list. Uses the wine list AI models.
 */
export type MenuItem = { section: string | null; name: string; description: string | null; price: number | null; currency: string; notes: string | null };
export type MenuTranscription = {
  restaurant: { name: string | null; city: string | null };
  items: MenuItem[];
  model: string | null; attempts: ModelAttempt[]; usage: OpenRouterUsage;
  unreadPages: number[]; pages: number;
};
export const MAX_MENU_ITEMS = 400;

export const menuPrompt = (hint: { restaurantName?: string | null; city?: string | null }, page?: { index: number; total: number }) => `
Voce transcreve cardapios de restaurantes (pratos e comidas) para o sommelier do app Vinato.
${page && page.total > 1 ? `Esta imagem e a pagina ${page.index} de ${page.total} do cardapio. Transcreva TODOS os pratos DESTA pagina, na ordem em que aparecem.` : "Transcreva TODOS os pratos do cardapio nas imagens/PDF, na ordem em que aparecem."}
${hint.restaurantName ? `Restaurante: ${hint.restaurantName}${hint.city ? ` (${hint.city})` : ""}.` : ""}

Para cada prato:
- section: a secao do cardapio (ex.: "Entradas", "Massas", "Peixes", "Sobremesas").
- name: o nome do prato como impresso, sem preco.
- description: ingredientes, molho e modo de preparo impressos (importante para harmonizar com vinho).
- price: preco como numero (ex.: 89.90). currency: moeda (BRL, USD, EUR...).
- notes: porcao, tamanho, se e vegetariano/vegano/sem gluten, quando impresso.
Inclua pratos, petiscos e sobremesas. Nao inclua bebidas (vinhos, drinks, sucos), taxas nem couvert.
Nao invente pratos, ingredientes ou precos. Omita os campos que nao estiverem no cardapio (nao escreva null).
Se o cardapio mostrar o nome do restaurante ou a cidade, informe em restaurant.

Responda somente JSON valido, sem markdown:
{"restaurant": {"name", "city"}, "items": [ {section, name, description, price, currency, notes} ]}
`;

const EMPTY = /^(null|undefined|none|n\/a|n\/d|-+|desconhecido|unknown)$/i;
const text = (value: unknown, max = 600) => {
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() && !EMPTY.test(value.trim()) ? value.trim().slice(0, max) : null;
};

export function normalizeMenuItems(value: unknown): MenuItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): MenuItem[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    const name = text(item.name, 200);
    if (!name) return [];
    return [{
      section: text(item.section, 120), name, description: text(item.description), price: money(item.price),
      currency: text(item.currency)?.toUpperCase().slice(0, 3) ?? "BRL", notes: text(item.notes, 300),
    }];
  }).slice(0, MAX_MENU_ITEMS);
}

const key = (item: MenuItem) => `${item.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${item.price ?? ""}`;

/** The pages in order; a dish repeated at the end of one photo and the start of the next is kept once. */
export function mergeMenuPages(pages: MenuItem[][]) {
  const merged: MenuItem[] = [];
  let previous = new Set<string>();
  for (const items of pages) {
    const current = new Set(items.map(key));
    merged.push(...items.filter((item) => !previous.has(key(item))));
    previous = current;
  }
  return merged.slice(0, MAX_MENU_ITEMS);
}

const filePart = (file: ListFile, index: number): ContentPart => file.mimetype === "application/pdf"
  ? { type: "file", file: { filename: `cardapio-${index + 1}.pdf`, file_data: file.dataUrl } }
  : { type: "image_url", image_url: { url: file.dataUrl } };

export class OpenRouterMenuAgent {
  constructor(private readonly settings?: WineListModelSettingsProvider) {}

  /** Each photo is one page read in parallel (a PDF in one call), within one deadline. */
  async transcribe(files: ListFile[], hint: { restaurantName?: string | null; city?: string | null }, options: { deadline?: number } = {}): Promise<MenuTranscription> {
    const models = this.settings ? await this.settings.getWineListModels() : defaultWineListModels();
    const deadline = options.deadline ?? Date.now() + TRANSCRIPTION_BUDGET_MS;
    const pages = files.some((file) => file.mimetype === "application/pdf") || files.length === 1 ? [files] : files.map((file) => [file]);
    const replies = await Promise.all(pages.map((pageFiles, index) => {
      const page = pages.length > 1 ? { index: index + 1, total: pages.length } : undefined;
      return requestJsonWithFallback(models, [{ type: "text", text: menuPrompt(hint, page) }, ...pageFiles.map(filePart)], {
        maxTokens: pages.length > 1 ? 8_000 : 16_000, title: "Vinato cardapios", deadline, page: page?.index,
        accept: (json) => pages.length > 1 ? Array.isArray(json.items) : normalizeMenuItems(json.items).length > 0,
      });
    }));
    const attempts = replies.flatMap((reply) => reply.attempts);
    const restaurants = replies.map((reply) => (reply.json?.restaurant && typeof reply.json.restaurant === "object" ? reply.json.restaurant : {}) as Record<string, unknown>);
    return {
      restaurant: { name: restaurants.map((item) => text(item.name, 200)).find(Boolean) ?? null, city: restaurants.map((item) => text(item.city, 200)).find(Boolean) ?? null },
      items: mergeMenuPages(replies.map((reply) => normalizeMenuItems(reply.json?.items))),
      model: replies.find((reply) => reply.model)?.model ?? null, attempts, usage: totalUsage(attempts),
      unreadPages: pages.length > 1 ? replies.flatMap((reply, index) => reply.json ? [] : [index + 1]) : [],
      pages: pages.length,
    };
  }
}
