import type pg from "pg";
import { normalizeText } from "./catalog-matcher.js";

/**
 * The Sommelier consults the wine lists already transcribed ("Verificação de
 * carta"): the one the user opened in the app, or the one of the restaurant named
 * in the question. Only the lists the user sent, and the ones the admin uploaded,
 * are available — the same rule as the bottle check.
 */
export type WineListItemContext = {
  section: string | null; name: string; producer: string | null; vintage: number | null; country: string | null; region: string | null;
  grapes: string | null; style: string | null; volume: string | null; price: number | null; glassPrice: number | null; currency: string; notes: string | null;
};
export type WineListContext = { id: string; restaurantName: string | null; city: string | null; createdAt: string; items: WineListItemContext[] };
export type WineListSummary = { id: string; restaurantName: string | null; city: string | null; itemCount: number };

export interface WineListLookup {
  /** The list, when the user may use it and it was transcribed. */
  forUser(userId: string, listId: string): Promise<WineListContext | null>;
  /** The newest list of the restaurant the question names, among the lists the user may use. */
  mentioned(userId: string, text: string): Promise<WineListContext | null>;
}

// The lists the user may consult: theirs, and the ones the admin uploaded.
const USABLE = `l.status = 'transcribed' AND (l.user_id = $1 OR (l.user_id IS NULL AND l.uploaded_by IS NOT NULL))`;
// Enough for long menus while keeping the prompt small (about 30 tokens a wine).
export const MAX_CONTEXT_ITEMS = 400;
// Names too common to stand for a restaurant in a sentence ("em casa", "no bar").
const COMMON_NAMES = new Set(["casa", "bar", "vinho", "vinhos", "adega", "cantina", "restaurante", "bistro", "cozinha", "mesa"]);

/** Whether the question names the restaurant (accents, case and punctuation ignored, whole words). */
export function namesRestaurant(text: string, restaurantName: string) {
  const name = normalizeText(restaurantName).trim();
  if (name.length < 4 || COMMON_NAMES.has(name)) return false;
  return ` ${normalizeText(text).trim()} `.includes(` ${name} `);
}

export class SommelierWineLists implements WineListLookup {
  constructor(private readonly pool: pg.Pool) {}

  async forUser(userId: string, listId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(listId)) return null;
    const list = (await this.pool.query<{ id: string; restaurant_name: string | null; city: string | null; created_at: Date | string }>(
      `SELECT l.id, coalesce(r.name, l.restaurant_name) AS restaurant_name, coalesce(r.city, l.city) AS city, l.created_at
       FROM wine_lists l LEFT JOIN restaurants r ON r.id = l.restaurant_id WHERE l.id = $2 AND ${USABLE}`,
      [userId, listId],
    )).rows[0];
    if (!list) return null;
    const items = await this.pool.query<WineListItemContext>(
      `SELECT section, name, producer, vintage, country, region, grapes, style, volume, price::float8 AS price,
              glass_price::float8 AS "glassPrice", currency, notes
       FROM wine_list_items WHERE wine_list_id = $1 ORDER BY position LIMIT ${MAX_CONTEXT_ITEMS + 1}`,
      [list.id],
    );
    return { id: list.id, restaurantName: list.restaurant_name, city: list.city, createdAt: new Date(list.created_at).toISOString(), items: items.rows };
  }

  async mentioned(userId: string, text: string) {
    if (!normalizeText(text).trim()) return null;
    // The newest usable list of each restaurant.
    const lists = (await this.pool.query<{ id: string; name: string }>(
      `SELECT DISTINCT ON (coalesce(l.restaurant_id::text, lower(btrim(l.restaurant_name)))) l.id, coalesce(r.name, l.restaurant_name) AS name
       FROM wine_lists l LEFT JOIN restaurants r ON r.id = l.restaurant_id
       WHERE ${USABLE} AND coalesce(r.name, l.restaurant_name) IS NOT NULL
       ORDER BY coalesce(l.restaurant_id::text, lower(btrim(l.restaurant_name))), l.created_at DESC
       LIMIT 1000`,
      [userId],
    )).rows;
    // The longest name wins ("Fasano Rio" over "Fasano").
    const named = lists.filter((list) => namesRestaurant(text, list.name)).sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length)[0];
    return named ? this.forUser(userId, named.id) : null;
  }
}

export const summaryOf = (list: WineListContext): WineListSummary => ({ id: list.id, restaurantName: list.restaurantName, city: list.city, itemCount: list.items.length });

function price(value: number | null, currency: string) {
  if (value === null || value === undefined) return null;
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "BRL";
  const prefix = code === "BRL" ? "R$" : code === "USD" ? "US$" : code === "EUR" ? "€" : code;
  return `${prefix} ${value.toFixed(2).replace(".", ",")}`;
}

/** One line per wine, in the order of the menu, with what matters to pair and to order. */
export function wineListLine(item: WineListItemContext, index: number) {
  const bottle = price(item.price, item.currency);
  const glass = price(item.glassPrice, item.currency);
  return [
    `${index + 1}. ${item.name}${item.vintage ? ` ${item.vintage}` : ""}`,
    item.producer && !normalizeText(item.name).includes(normalizeText(item.producer)) ? `produtor ${item.producer}` : null,
    [item.region, item.country].filter(Boolean).join(", ") || null,
    item.grapes, item.style, item.volume,
    bottle ? `garrafa ${bottle}` : null, glass ? `taça ${glass}` : null,
    item.notes,
  ].filter(Boolean).join(" | ");
}

/** Instructions and the wines of the list, added to the Sommelier instructions. */
export function wineListInstructions(list: WineListContext) {
  const items = list.items.slice(0, MAX_CONTEXT_ITEMS);
  const where = [list.restaurantName ?? "restaurante sem nome informado", list.city].filter(Boolean).join(", ");
  const bySection: string[] = [];
  let section: string | null | undefined;
  items.forEach((item, index) => {
    const current = item.section?.trim() || "Vinhos";
    if (current !== section) { bySection.push(`## ${current}`); section = current; }
    bySection.push(wineListLine(item, index));
  });
  const date = new Date(list.createdAt).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return `
Carta de vinhos consultada: ${where} (transcrita em ${date}, ${list.items.length} vinho(s)).
Regras para esta carta:
- Recomende somente vinhos desta carta, citando o nome exatamente como está nela, a safra e o preço (garrafa e/ou taça).
- Para harmonizar, indique de 1 a 3 opções em ordem de preferência e explique em uma ou duas frases por que combinam com o prato (acidez, taninos, corpo, gordura, tempero, molho). Quando fizer sentido, ofereça uma opção de melhor custo-benefício e uma opção em taça.
- Se nenhum vinho da carta combinar bem, diga isso com franqueza e indique o mais próximo, explicando a ressalva.
- Nunca invente vinhos, safras ou preços que não estão na lista. Se o cliente perguntar por um vinho que não está nela, diga que ele não aparece nesta carta.
- Se a lista parecer incompleta ou com erro de transcrição, avise que a carta pode ter mudado e sugira confirmar com o garçom.${list.items.length > items.length ? `\n- A carta tem ${list.items.length} vinhos; abaixo estão os ${items.length} primeiros.` : ""}
Vinhos da carta:
${bySection.join("\n")}`;
}
