import type { ScannedWineData } from "./types.js";

/**
 * Decides which catalog row a label reading refers to. The AI only reads the
 * label; every wine fact shown to the user comes from the catalog row chosen
 * here. Retrieval (SQL) is deliberately broad, this scoring is deliberately
 * strict: a wrong match is worse than sending the label to the review queue.
 */

export type CatalogCandidate = {
  id: string;
  displayName: string;
  wineName: string | null;
  producer: string | null;
  vintage: number | null;
  hasImage: boolean;
};

export type ScoredCandidate = CatalogCandidate & { score: number };

export type MatchDecision =
  | { status: "matched"; best: ScoredCandidate; alternatives: ScoredCandidate[] }
  | { status: "no_match"; alternatives: ScoredCandidate[] };

// Words that describe style or packaging rather than which wine it is.
const GENERIC_WORDS = new Set([
  "vinho", "vinhos", "wine", "vino", "vin", "tinto", "tinta", "red", "rouge", "rosso", "branco", "blanco", "white", "blanc",
  "rose", "rosado", "espumante", "sparkling", "fino", "fina", "nobre", "seco", "seca", "dry", "suave", "demi", "sec",
  "de", "da", "do", "das", "dos", "del", "della", "di", "du", "des", "la", "le", "les", "el", "los", "las", "the", "and", "e", "y", "et",
  "safra", "vintage", "ml", "cl", "l", "vol", "garrafa", "bottle", "regional", "denominacao", "origem", "doc", "do", "aoc", "igp", "dop",
  "vinhedo", "vinhedos", "bodega", "bodegas", "vina", "vinedos", "winery", "cantina", "domaine", "chateau", "casa", "quinta", "vinicola",
  "valley", "vale", "valle", "region",
]);

// Words that separate different wines of the same producer and line.
const TIER_WORDS = new Set([
  "reserva", "reserve", "riserva", "gran", "grande", "grand", "premium", "select", "selection", "seleccion", "selecao",
  "limitada", "limited", "especial", "special", "crianza", "icon", "single", "estate", "superior", "old", "vines",
  "brut", "nature", "extra", "moscatel", "noir", "rose", "rosado", "branco", "blanco", "white", "blanc",
]);

const COLOURS: Array<[string, RegExp]> = [
  ["sparkling", /\b(espumante|sparkling|champagne|cava|prosecco|cremant|brut|spumante|frisante)\b/],
  ["rose", /\b(rose|rosado|rosato|rosa)\b/],
  ["white", /\b(branco|blanco|white|blanc|bianco|chardonnay|sauvignon blanc|riesling|alvarinho|moscatel)\b/],
  ["red", /\b(tinto|tinta|red|rouge|rosso|malbec|cabernet sauvignon|merlot|carmenere|pinot noir|syrah|tannat|bordo)\b/],
];

/** Colour stated by a text. Style words win over grape hints ("Pinot Noir Rosé" is rosé). */
function colourOf(text: string) {
  const normalized = normalizeText(text);
  for (const [colour, pattern] of COLOURS) if (pattern.test(normalized)) return colour;
  return null;
}

// Bottle formats that make a catalog row a different product from a standard 750 ml bottle.
const LARGE_OR_SMALL_FORMAT = /\b(magnum|imperial|jeroboam|rehoboam|methuselah|salmanazar|nabucodonosor|double|split|demi|half|piccolo|(1[,.]5|3|4[,.]5|5|6|9|12|15)\s?l(itros?)?|(187|375|500)\s?ml)\b/;

export function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(value: string | null | undefined) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_WORDS.has(token) && !/^(1[89]|20)\d{2}$/.test(token));
}

/**
 * Search strings for the SQL retrieval step. catalog_wines.normalized_search
 * keeps accents ("fração") while label readings vary, so both spellings are sent.
 */
export function searchTerms(data: ScannedWineData) {
  const producer = data.producerName ?? data.producerTitle;
  // No producer-only term: it would rank every wine of that producer equally
  // and crowd the right one out of the candidate list.
  // The wine name alone ("Reserva Malbec") is only searched when no producer was
  // read: it matches thousands of rows and makes the query slow.
  const raw = [data.displayName, [producer, data.wine].filter(Boolean).join(" "), producer ? null : data.wine];
  const terms = raw.flatMap((term) => {
    const plain = tokens(term);
    const accented = (term ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ")
      .filter((token) => plain.includes(normalizeText(token)));
    return [plain.join(" "), accented.join(" ")];
  });
  // Also the full name as printed (minus the year): catalog names keep words like
  // "Blanc de" that the identity tokens drop, and word similarity needs them.
  const printed = (data.displayName ?? "").toLowerCase().replace(/\b(1[89]|20)\d{2}\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return [...new Set([...terms, printed, normalizeText(printed)].filter((term) => term.length >= 3))].slice(0, 6);
}

export function labelVintage(data: ScannedWineData) {
  const year = Number(data.vintage);
  return Number.isInteger(year) && year > 1850 && year <= new Date().getFullYear() ? year : null;
}

function labelIsStandardBottle(data: ScannedWineData) {
  const volume = normalizeText(data.volume);
  return !volume || /\b75\s?cl\b|\b750\s?ml\b|\b0 75\s?l\b/.test(volume) || !LARGE_OR_SMALL_FORMAT.test(volume);
}

export function scoreCandidate(data: ScannedWineData, candidate: CatalogCandidate) {
  const producer = data.producerName ?? data.producerTitle;
  const labelIdentity = new Set([...tokens(data.displayName), ...tokens(producer), ...tokens(data.wine)]);
  const candidateName = normalizeText([candidate.displayName, candidate.wineName, candidate.producer].filter(Boolean).join(" "));
  const candidateIdentity = new Set(tokens(candidateName));
  if (!labelIdentity.size || !candidateIdentity.size) return 0;

  // How much of what the label says is present in the catalog row...
  const found = [...labelIdentity].filter((token) => candidateIdentity.has(token)).length;
  const labelCoverage = found / labelIdentity.size;
  // ...and how much of the catalog row is explained by the label. A catalog
  // "Lote 43 Magnum" or "Reserva Especial" must not win for a plain "Lote 43".
  const everythingRead = new Set([...labelIdentity, ...tokens(data.designation), ...tokens(data.classification), ...tokens(data.grapes), ...tokens(data.region), ...tokens(data.subRegion), ...tokens(data.country)]);
  const explained = [...candidateIdentity].filter((token) => everythingRead.has(token)).length;
  const candidateCoverage = explained / candidateIdentity.size;

  let score = labelCoverage * 0.6 + candidateCoverage * 0.4;

  const producerTokens = tokens(producer);
  if (producerTokens.length && producerTokens.every((token) => candidateIdentity.has(token))) score += 0.08;

  const vintage = labelVintage(data);
  if (vintage && candidate.vintage === vintage) score += 0.1;

  // A red label never matches the white or sparkling version of the same line.
  const labelColour = colourOf([data.colour, data.type, data.displayName, data.wine].filter(Boolean).join(" "));
  const candidateColour = colourOf(candidate.displayName);
  if (labelColour && candidateColour && labelColour !== candidateColour) score -= 0.45;

  // "Reserva", "Gran", "Select"... on only one side means another wine of the line.
  const labelTiers = tierWords([data.displayName, data.wine, data.designation, data.classification].filter(Boolean).join(" "));
  const candidateTiers = tierWords(candidateName);
  const tierMismatch = [...labelTiers].filter((word) => !candidateTiers.has(word)).length + [...candidateTiers].filter((word) => !labelTiers.has(word)).length;
  score -= Math.min(0.4, tierMismatch * 0.2);

  if (labelIsStandardBottle(data) && LARGE_OR_SMALL_FORMAT.test(normalizeText(candidate.displayName))) score -= 0.35;

  // Tie-breaker only: prefer the richer row for the same wine.
  if (candidate.hasImage) score += 0.01;
  if (candidate.producer) score += 0.01;

  // A row for another vintage is another bottle (its notes and scores differ):
  // keep it below the match threshold so it is offered as an alternative.
  if (vintage && candidate.vintage && candidate.vintage !== vintage) score = Math.min(score, 0.6);

  return Math.max(0, Math.min(1, score));
}

function tierWords(text: string) {
  return new Set(normalizeText(text).split(" ").filter((word) => TIER_WORDS.has(word)));
}

export const MATCH_THRESHOLD = 0.72;
const AMBIGUITY_MARGIN = 0.04;

export function decideMatch(data: ScannedWineData, candidates: CatalogCandidate[]): MatchDecision {
  const scored = candidates
    .map((candidate) => ({ ...candidate, score: Number(scoreCandidate(data, candidate).toFixed(3)) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const alternatives = scored.filter((candidate) => candidate.score >= 0.45).slice(0, 4);

  if (!best || best.score < MATCH_THRESHOLD) return { status: "no_match", alternatives };
  // Two different wines scoring the same means the label did not tell them apart.
  // Near-perfect ties are the same wine catalogued twice (different sources);
  // the tie-breakers already put the richer row first.
  if (second && best.score < 0.9 && best.score - second.score < AMBIGUITY_MARGIN && !sameWine(best, second)) {
    return { status: "no_match", alternatives };
  }
  return { status: "matched", best, alternatives: alternatives.filter((candidate) => candidate.id !== best.id) };
}

function sameWine(a: CatalogCandidate, b: CatalogCandidate) {
  const name = (candidate: CatalogCandidate) => tokens([candidate.displayName, candidate.producer].join(" ")).sort().join(" ");
  return name(a) === name(b);
}
