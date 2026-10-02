import type pg from "pg";
import { normalizeText } from "./catalog-matcher.js";
import { namesRestaurant } from "./sommelier-wine-list.js";
import { drinkingPhases } from "./wine-mapper.js";

/** "1-3 anos: perfil floral; 4-7 anos: notas terrosas; 8+ anos: em declínio". */
const windowText = (value: unknown) => drinkingPhases(value)
  .map((phase) => `${phase.from}${phase.to !== null && phase.to !== phase.from ? `-${phase.to}` : ""}${phase.plus ? "+" : ""} anos: ${phase.note}`).join("; ") || null;

/**
 * Everything the app knows that helps the Sommelier answer, added to its
 * instructions on each question: the customer's cellar, favourites, reviews and
 * recent scans; the partner restaurants with a wine list or a menu; the VINATO
 * catalog wines the question names (facts, grade, tempo de guarda, best price);
 * and the menu (Cardápios) of the restaurant being consulted, to pair its dishes
 * with the wines of its list. Each part is best effort: a failing query only
 * leaves its part out.
 */
export type MenuItemContext = { section: string | null; name: string; description: string | null; price: number | null; currency: string; notes: string | null };
export type MenuContext = { id: string; restaurantId: string | null; restaurantName: string | null; city: string | null; items: MenuItemContext[] };
export type MenuSummary = { id: string; restaurantName: string | null; city: string | null; itemCount: number };

export interface SommelierKnowledge {
  /** The customer's data and the catalog wines the question names, as instructions (null when there is nothing). */
  forUser(userId: string, question: string): Promise<string | null>;
  /** The newest menu of the restaurant (by id, or by its name when the list has no restaurant). */
  menuOfRestaurant(restaurantId: string | null, restaurantName: string | null): Promise<MenuContext | null>;
  /** The newest menu of the restaurant the question names. */
  menuMentioned(text: string): Promise<MenuContext | null>;
  menuById(menuId: string): Promise<MenuContext | null>;
}

export const MAX_MENU_CONTEXT_ITEMS = 300;
const USABLE_MENU = `m.deleted_at IS NULL AND m.status = 'transcribed' AND m.curation_status <> 'rejected'`;
// Words that never name a wine in a question.
const STOP_WORDS = new Set(["vinho", "vinhos", "tinto", "branco", "rose", "espumante", "qual", "quais", "para", "com", "sem", "uma", "um", "que", "como", "esse", "este", "essa", "esta", "meu", "minha", "tenho", "posso", "pode", "harmoniza", "harmonizar", "combina", "prato", "carta", "restaurante", "sommelier", "melhor", "garrafa", "taca", "safra", "quando", "beber", "guardar", "guarda", "adega", "sobre", "voce", "indica", "recomenda", "quero", "gostaria", "hoje", "jantar", "almoco"]);

const money = (value: number | null, currency = "BRL") => {
  if (value === null || value === undefined) return null;
  const prefix = currency === "BRL" ? "R$" : currency === "USD" ? "US$" : currency === "EUR" ? "€" : currency;
  return `${prefix} ${Number(value).toFixed(2).replace(".", ",")}`;
};
const join = (...parts: (string | number | null | undefined | false)[]) => parts.filter((part) => part !== null && part !== undefined && part !== false && part !== "").join(" | ");

export class PgSommelierKnowledge implements SommelierKnowledge {
  constructor(private readonly pool: pg.Pool) {}

  private async rows<T extends pg.QueryResultRow>(sql: string, params: unknown[]): Promise<T[]> {
    try {
      return (await this.pool.query<T>(sql, params)).rows;
    } catch (error) {
      console.warn("[sommelier] context query failed", (error as Error).message);
      return [];
    }
  }

  async forUser(userId: string, question: string) {
    const [profile, cellar, favorites, reviews, scans, places, catalog] = await Promise.all([
      this.rows<{ display_name: string | null; plan: string }>(`SELECT display_name, plan FROM app_users WHERE id = $1`, [userId]),
      this.rows<{ name: string; vintage: number | null; color: string | null; origin: string | null; aging: string | null; drinking: unknown; quantity: number }>(
        `SELECT w.display_name AS name, w.vintage, w.color, concat_ws(', ', w.region, w.country) AS origin, w.aging_potential AS aging, w.drinking_window AS drinking, c.quantity
         FROM user_cellars c JOIN catalog_wines w ON w.id = c.wine_id WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 40`, [userId]),
      this.rows<{ name: string; vintage: number | null }>(
        `SELECT w.display_name AS name, w.vintage FROM user_favorites f JOIN catalog_wines w ON w.id = f.wine_id WHERE f.user_id = $1 ORDER BY f.created_at DESC LIMIT 20`, [userId]),
      this.rows<{ name: string; rating: number; comment: string | null }>(
        `SELECT w.display_name AS name, r.rating::float AS rating, left(r.comment, 140) AS comment FROM wine_reviews r JOIN catalog_wines w ON w.id = r.wine_id
         WHERE r.user_id = $1 ORDER BY r.updated_at DESC NULLS LAST LIMIT 15`, [userId]),
      this.rows<{ name: string | null; scanned_at: Date | string }>(
        `SELECT coalesce(w.display_name, h.result->'data'->>'displayName') AS name, h.scanned_at FROM user_scan_history h LEFT JOIN catalog_wines w ON w.id = h.wine_id
         WHERE h.user_id = $1 AND h.status = 'success' ORDER BY h.scanned_at DESC LIMIT 10`, [userId]),
      this.rows<{ name: string; city: string | null; list: boolean; menu: boolean }>(
        `SELECT r.name, r.city,
                exists (SELECT 1 FROM wine_lists l WHERE l.restaurant_id = r.id AND l.deleted_at IS NULL AND l.status = 'transcribed' AND l.curation_status <> 'rejected') AS list,
                exists (SELECT 1 FROM restaurant_menus m WHERE m.restaurant_id = r.id AND ${USABLE_MENU}) AS menu
         FROM restaurants r ORDER BY r.updated_at DESC LIMIT 200`, []),
      this.catalogWines(question),
    ]);
    const parts: string[] = [];
    const me = profile[0];
    if (me) parts.push(`Cliente: ${me.display_name?.trim() || "sem nome informado"} (${me.plan === "premium" ? "membro VINATO Premium" : "plano gratuito"}).`);
    if (cellar.length) parts.push(`Adega do cliente (vinhos que ele tem em casa):\n${cellar.map((wine) => `- ${join(`${wine.name}${wine.vintage ? ` ${wine.vintage}` : ""}`, wine.color, wine.origin, wine.aging && `guarda: ${wine.aging}`, windowText(wine.drinking) && `janela de uso (anos após a safra): ${windowText(wine.drinking)}`, `${wine.quantity} garrafa(s)`)}`).join("\n")}`);
    if (favorites.length) parts.push(`Vinhos favoritos do cliente: ${favorites.map((wine) => `${wine.name}${wine.vintage ? ` ${wine.vintage}` : ""}`).join("; ")}.`);
    if (reviews.length) parts.push(`Avaliações do cliente (nota de 1 a 5):\n${reviews.map((review) => `- ${review.name}: ${review.rating}${review.comment ? ` — "${review.comment}"` : ""}`).join("\n")}`);
    if (scans.length) parts.push(`Últimos rótulos que o cliente escaneou: ${scans.filter((scan) => scan.name).map((scan) => `${scan.name} (${new Date(scan.scanned_at).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })})`).join("; ")}.`);
    const partners = places.filter((place) => place.list || place.menu);
    if (partners.length) parts.push(`Restaurantes parceiros no VINATO (carta de vinhos e/ou cardápio disponíveis; se o cliente citar um deles, a carta e o cardápio aparecem nestas instruções):\n${partners.slice(0, 80).map((place) => `- ${join(place.name, place.city, [place.list && "carta de vinhos", place.menu && "cardápio"].filter(Boolean).join(" e "))}`).join("\n")}`);
    if (catalog.length) parts.push(`Vinhos do catálogo VINATO que a pergunta cita:\n${catalog.join("\n")}`);
    if (!parts.length) return null;
    return `\nDADOS DO VINATO PARA ESTA CONVERSA
Você recebe estes dados do aplicativo junto com a pergunta: use-os para personalizar a resposta (por exemplo, sugerir um vinho da adega do cliente, lembrar o tempo de guarda, considerar o que ele já avaliou). Não liste esses dados sem necessidade e não diga como os recebeu.
${parts.join("\n\n")}`;
  }

  /** Approved catalog wines whose names share the most words with the question (up to 6), with grade, tempo de guarda and the best price. */
  private async catalogWines(question: string) {
    const words = [...new Set(normalizeText(question).split(" ").filter((word) => word.length >= 4 && !STOP_WORDS.has(word)))].slice(0, 8);
    if (!words.length) return [];
    const plain = `translate(lower(w.display_name || ' ' || coalesce(w.producer_manufacturer, '')), 'áàâãäåéèêëíìîïóòôõöúùûüçñ', 'aaaaaaeeeeiiiiooooouuuucn')`;
    const hits = words.map((_, index) => `(CASE WHEN ${plain} LIKE $${index + 1} THEN 1 ELSE 0 END)`).join(" + ");
    const rows = await this.rows<{ name: string; vintage: number | null; producer: string | null; origin: string | null; color: string | null; grapes: string | null; alcohol: number | null; aging: string | null; drinking: unknown; average: number | null; reviews: number | null; price: number | null; currency: string | null; store: string | null; hits: number }>(
      `SELECT w.display_name AS name, w.vintage, w.producer_manufacturer AS producer, concat_ws(', ', w.region, w.country) AS origin, w.color,
              (SELECT string_agg(coalesce(g->>'name', g #>> '{}'), ', ') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(w.grapes) = 'array' THEN w.grapes ELSE '[]'::jsonb END) g) AS grapes,
              w.alcohol_percent::float AS alcohol, w.aging_potential AS aging, w.drinking_window AS drinking,
              (SELECT round(s.rating_sum / NULLIF(s.review_count, 0), 1)::float FROM wine_review_stats s WHERE s.wine_id = w.id) AS average,
              (SELECT s.review_count FROM wine_review_stats s WHERE s.wine_id = w.id) AS reviews,
              best.price, best.currency, best.store, (${hits}) AS hits
       FROM catalog_wines w
       LEFT JOIN LATERAL (
         SELECT o.price::float AS price, o.currency, m.name AS store FROM wine_offers o JOIN wine_merchants m ON m.id = o.merchant_id
         WHERE o.wine_id = w.id AND m.active AND NOT o.hidden AND o.in_stock ORDER BY o.price LIMIT 1
       ) best ON true
       WHERE w.curation_status = 'approved' AND (${hits}) >= ${Math.min(2, words.length)}
       ORDER BY (${hits}) DESC, (SELECT s.review_count FROM wine_review_stats s WHERE s.wine_id = w.id) DESC NULLS LAST
       LIMIT 6`,
      words.map((word) => `%${word}%`),
    );
    return rows.map((wine) => `- ${join(`${wine.name}${wine.vintage ? ` ${wine.vintage}` : ""}`, wine.producer && `produtor ${wine.producer}`, wine.origin, wine.color, wine.grapes,
      wine.alcohol && `${wine.alcohol}% álcool`, wine.aging && `tempo de guarda: ${wine.aging}`, windowText(wine.drinking) && `janela de uso (anos após a safra): ${windowText(wine.drinking)}`,
      wine.reviews ? `nota dos usuários ${wine.average}/5 (${wine.reviews} avaliações)` : null,
      wine.price !== null ? `a partir de ${money(wine.price, wine.currency ?? "BRL")} em ${wine.store}` : null)}`);
  }

  private async menu(where: string, params: unknown[]): Promise<MenuContext | null> {
    const [menu] = await this.rows<{ id: string; restaurant_id: string | null; name: string | null; city: string | null }>(
      `SELECT m.id, m.restaurant_id, coalesce(r.name, m.restaurant_name) AS name, coalesce(r.city, m.city) AS city
       FROM restaurant_menus m LEFT JOIN restaurants r ON r.id = m.restaurant_id
       WHERE ${USABLE_MENU} AND ${where} ORDER BY (m.curation_status = 'approved') DESC, m.created_at DESC LIMIT 1`, params);
    if (!menu) return null;
    const items = await this.rows<MenuItemContext>(
      `SELECT section, name, description, price::float8 AS price, currency, notes FROM restaurant_menu_items WHERE menu_id = $1 ORDER BY position LIMIT ${MAX_MENU_CONTEXT_ITEMS + 1}`, [menu.id]);
    return { id: menu.id, restaurantId: menu.restaurant_id, restaurantName: menu.name, city: menu.city, items };
  }

  menuOfRestaurant(restaurantId: string | null, restaurantName: string | null) {
    if (restaurantId) return this.menu(`m.restaurant_id = $1`, [restaurantId]);
    if (restaurantName?.trim()) return this.menu(`lower(btrim(coalesce(r.name, m.restaurant_name))) = lower(btrim($1))`, [restaurantName]);
    return Promise.resolve(null);
  }

  menuById(menuId: string) {
    return /^[0-9a-f-]{36}$/i.test(menuId) ? this.menu(`m.id = $1`, [menuId]) : Promise.resolve(null);
  }

  async menuMentioned(text: string) {
    if (!normalizeText(text).trim()) return null;
    const menus = await this.rows<{ id: string; name: string }>(
      `SELECT DISTINCT ON (coalesce(m.restaurant_id::text, lower(btrim(m.restaurant_name)))) m.id, coalesce(r.name, m.restaurant_name) AS name
       FROM restaurant_menus m LEFT JOIN restaurants r ON r.id = m.restaurant_id
       WHERE ${USABLE_MENU} AND coalesce(r.name, m.restaurant_name) IS NOT NULL
       ORDER BY coalesce(m.restaurant_id::text, lower(btrim(m.restaurant_name))), m.created_at DESC LIMIT 1000`, []);
    const named = menus.filter((menu) => namesRestaurant(text, menu.name)).sort((a, b) => normalizeText(b.name).length - normalizeText(a.name).length)[0];
    return named ? this.menuById(named.id) : null;
  }
}

export const menuSummaryOf = (menu: MenuContext): MenuSummary => ({ id: menu.id, restaurantName: menu.restaurantName, city: menu.city, itemCount: menu.items.length });

/** The dishes of the menu, by section, with the rules to pair them with the restaurant's wine list. */
export function menuInstructions(menu: MenuContext, withWineList: boolean) {
  const items = menu.items.slice(0, MAX_MENU_CONTEXT_ITEMS);
  const where = [menu.restaurantName ?? "restaurante sem nome informado", menu.city].filter(Boolean).join(", ");
  const lines: string[] = [];
  let section: string | null | undefined;
  items.forEach((item, index) => {
    const current = item.section?.trim() || "Pratos";
    if (current !== section) { lines.push(`## ${current}`); section = current; }
    lines.push(`${index + 1}. ${join(item.name, item.description, money(item.price, item.currency), item.notes)}`);
  });
  return `
Cardápio consultado: ${where} (${menu.items.length} prato(s)).
Regras para o cardápio:
- Quando o cliente citar um prato (pelo nome, parte do nome ou descrição), encontre-o neste cardápio e use os ingredientes, o molho e o preparo para harmonizar.
${withWineList
    ? "- Recomende para o prato os vinhos da carta deste mesmo restaurante (acima), com nome, safra e preço exatamente como na carta, explicando por que combinam."
    : "- Este restaurante não tem carta de vinhos no VINATO: indique estilos, uvas e regiões que combinam com o prato e, se fizer sentido, vinhos da adega do cliente."}
- Você também pode sugerir pratos deste cardápio para o vinho que o cliente escolheu.
- Não invente pratos, ingredientes ou preços que não estão no cardápio.${menu.items.length > items.length ? `\n- O cardápio tem ${menu.items.length} pratos; abaixo estão os ${items.length} primeiros.` : ""}
Pratos do cardápio:
${lines.join("\n")}`;
}

/**
 * Always added to the Sommelier instructions: it resolves what it can with the
 * list, the menu, the customer's data and its knowledge, and only refers the
 * customer to the restaurant staff for what it cannot know.
 */
export const AUTONOMY_RULES = `
AUTONOMIA
- Resolva você mesmo tudo o que puder com a carta de vinhos, o cardápio, os dados do cliente e o seu conhecimento: escolha o vinho, harmonize com o prato, explique o rótulo, a temperatura e o serviço.
- Não sugira chamar o sommelier, o garçom ou a equipe do restaurante para algo que você pode responder. Indique confirmar com a equipe somente o que você não tem como saber (por exemplo, se o vinho está disponível hoje ou qual safra está sendo servida).`;
