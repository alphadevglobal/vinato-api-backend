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
  places?: string[]; // region, sub-region, country of the catalog row
  colour?: string | null; // catalog colour column (may be wrong in the imported base)
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
  // Company suffixes printed on back labels ("Rutini Wines", "Cinque Segni Srl", "& Figli").
  "wines", "vinos", "vins", "finos", "sa", "srl", "spa", "sas", "sca", "scav", "ltda", "ltd", "inc", "co", "company", "figli", "hijos", "filhos",
  // Numbering printed as "Nº 3" / "no. 3" / "nr 3".
  "no", "nr", "num", "numero",
  // Company forms and appellations written with initials ("S.L.", "I.G.T.", "D.O.Ca.", "I.P.").
  "sl", "slu", "igt", "docg", "doca", "dop", "igp", "ip", "vqprd", "aop", "ava",
  // Field labels the model sometimes writes instead of a value.
  "produtor", "producer", "productor", "engarrafado", "bottled",
]);

// Words that separate different wines of the same producer and line.
export const TIER_WORDS = new Set([
  "reserva", "reserve", "riserva", "gran", "grande", "grand", "premium", "select", "selection", "seleccion", "selecao",
  "limitada", "limited", "especial", "special", "crianza", "icon", "single", "estate", "superior", "old", "vines",
  "brut", "nature", "extra", "moscatel", "noir", "rose", "rosado", "branco", "blanco", "white", "blanc",
]);

const COLOURS: Array<[string, RegExp]> = [
  ["sparkling", /\b(espumante|sparkling|champagne|cava|prosecco|cremant|brut|spumante|frisante)\b/],
  ["rose", /\b(rose|rosado|rosato|rosa)\b/],
  ["white", /\b(branco|blanco|white|blanc|bianco|chardonnay|sauvignon blanc|riesling|alvarinho|moscatel)\b/],
  ["red", /\b(tinto|tinta|red|rouge|rosso|malbec|cabernet|merlot|carmenere|pinot noir|syrah|shiraz|tannat|bordo|isabel|tempranillo|sangiovese|nebbiolo|primitivo|pinotage|marselan|touriga|montepulciano)\b/],
];

// Sweetness words: "Suave" and "Seco" are different wines of the same line
// (Brazilian table wines), like "Brut" and "Demi-Sec" for sparkling ones.
const SWEETNESS: Array<[string, RegExp]> = [
  ["suave", /\b(suave|doce|dolce|sweet)\b/],
  ["demi", /\b(demi sec|demi|meio seco|semi seco|semisseco|medium dry)\b/],
  ["seco", /\b(seco|seca|dry)\b/],
  ["brut", /\b(brut|extra brut|nature)\b/],
];
export function sweetnessOf(text: string) {
  const normalized = normalizeText(text);
  // "demi-sec" must not also count as "seco"; "extra brut" as "brut" is the same family.
  const found = new Set<string>();
  for (const [name, pattern] of SWEETNESS) if (pattern.test(normalized)) found.add(name);
  if (found.has("demi")) found.delete("seco");
  return found;
}

/** Colour stated by a text. Style words win over grape hints ("Pinot Noir Rosé" is rosé). */
export function colourOf(text: string) {
  const normalized = normalizeText(text);
  for (const [colour, pattern] of COLOURS) if (pattern.test(normalized)) return colour;
  return null;
}

export const GRAPE_WORDS = new Set([
  "cabernet", "franc", "sauvignon", "malbec", "merlot", "syrah", "shiraz", "pinot", "noir", "chardonnay", "carmenere", "tannat",
  "bonarda", "tempranillo", "sangiovese", "primitivo", "nebbiolo", "touriga", "marselan", "montepulciano", "riesling", "viognier",
  "verdot", "grenache", "garnacha", "zinfandel", "barbera", "aglianico", "carignan", "mourvedre", "monastrell", "torrontes",
  "alvarinho", "albarino", "gewurztraminer", "semillon", "moscato", "moscatel", "nero", "avola", "negroamaro", "trincadeira", "aragonez",
]);

// Bottle formats that make a catalog row a different product from a standard 750 ml bottle.
export const LARGE_OR_SMALL_FORMAT = /\b(magnum|imperial|jeroboam|rehoboam|methuselah|salmanazar|nabucodonosor|double|split|demi|half|piccolo|(1[,.]5|3|4[,.]5|5|6|9|12|15)\s?l(itros?)?|(187|375|500)\s?ml)\b/;

export function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    // Portuguese labels print "Bruto"/"Bruto Natural"; the catalog uses Brut/Brut Nature.
    .replace(/\bbruto natural\b/g, "brut nature")
    .replace(/\bbruto\b/g, "brut")
    .trim();
}

export function tokens(value: string | null | undefined) {
  return normalizeText(value)
    // Initials are a name ("D.V. Catena" → "dv"), not stray letters to drop.
    .replace(/\b([a-z])(?: ([a-z]))+\b/g, (match) => match.replace(/ /g, ""))
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

/**
 * Distinctive words read on the label: producer words and wine-name words. A wine
 * can only be created from a reading that names it well enough (producer + name,
 * or at least two name words): "La Flor" alone would create a wrong wine.
 */
export function readingIdentity(data: Pick<ScannedWineData, "displayName" | "producerName" | "producerTitle" | "wine">) {
  const producer = [...new Set([data.producerName, data.producerTitle].flatMap((name) => tokens(name)))];
  const name = [...new Set([...tokens(data.displayName), ...tokens(data.wine)])].filter((token) => !producer.includes(token));
  return { producer, name, sufficient: name.length >= 2 || (producer.length >= 1 && name.length >= 1) };
}

export function labelVintage(data: ScannedWineData) {
  const year = Number(data.vintage);
  return Number.isInteger(year) && year > 1850 && year <= new Date().getFullYear() ? year : null;
}

function labelIsStandardBottle(data: ScannedWineData) {
  const volume = normalizeText(data.volume);
  return !volume || /\b75\s?cl\b|\b750\s?ml\b|\b0 75\s?l\b/.test(volume) || !LARGE_OR_SMALL_FORMAT.test(volume);
}

// One letter of difference in a long word is a spelling variant, not another wine
// ("Trebbiano"/"Trebiano", "Arouce"/"Arource").
function similarWord(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 6 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1; else if (b.length > a.length) j += 1; else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const hasWord = (words: Set<string>, word: string) => words.has(word) || [...words].some((other) => similarWord(word, other));

export function scoreCandidate(data: ScannedWineData, candidate: CatalogCandidate) {
  // Both producer fields: the model may put the company ("S.C.A.V.M.") in one and
  // the estate ("Château Bauvallon") in the other.
  const producerNames = [data.producerName, data.producerTitle].filter((value): value is string => Boolean(value));
  const labelIdentity = new Set([...tokens(data.displayName), ...producerNames.flatMap((name) => tokens(name)), ...tokens(data.wine)]);
  const candidateName = normalizeText([candidate.displayName, candidate.wineName, candidate.producer].filter(Boolean).join(" "));
  const candidateIdentity = new Set(tokens(candidateName));
  if (!labelIdentity.size || !candidateIdentity.size) return 0;

  // How much of what the label says is present in the catalog row...
  const found = [...labelIdentity].filter((token) => hasWord(candidateIdentity, token)).length;
  const labelCoverage = found / labelIdentity.size;
  // ...and how much of the catalog row is explained by the label. A catalog
  // "Lote 43 Magnum" or "Reserva Especial" must not win for a plain "Lote 43".
  const everythingRead = new Set([...labelIdentity, ...tokens(data.designation), ...tokens(data.classification), ...tokens(data.grapes), ...tokens(data.region), ...tokens(data.subRegion), ...tokens(data.country)]);
  const explained = [...candidateIdentity].filter((token) => hasWord(everythingRead, token)).length;
  const candidateCoverage = explained / candidateIdentity.size;

  let score = labelCoverage * 0.6 + candidateCoverage * 0.4;

  const producerTokens = [...new Set(producerNames.flatMap((name) => tokens(name)))];
  if (producerNames.some((name) => { const words = tokens(name); return words.length > 0 && words.every((token) => candidateIdentity.has(token)); })) score += 0.08;
  // The producer read on the label appears nowhere in the row: another producer's
  // wine with the same name ("Absurdo, Cabernet Franc Malbec" for a Rutini).
  // Only rows that name a producer can contradict the label.
  const producerMissing = producerTokens.length > 0 && Boolean(candidate.producer) && !producerTokens.some((token) => candidateIdentity.has(token));

  const vintage = labelVintage(data);
  if (vintage && candidate.vintage === vintage) score += 0.1;

  // A red label never matches the white or sparkling version of the same line.
  // The name says it first ("il Rosso" is red even if the imported row says White);
  // the catalog colour column only speaks when the name does not.
  const labelColour = colourOf([data.colour, data.type, data.displayName, data.wine].filter(Boolean).join(" "));
  const candidateColour = colourOf(candidate.displayName) ?? colourOf(candidate.colour ?? "");
  if (labelColour && candidateColour && labelColour !== candidateColour) score -= 0.45;

  // "Suave" on the label and "Seco" (or nothing) in the row: another wine of the line.
  const labelSweetness = sweetnessOf([data.displayName, data.wine, data.type, data.subType, data.classification].filter(Boolean).join(" "));
  const candidateSweetness = sweetnessOf(candidateName);
  const sweetnessMismatch = [...labelSweetness].filter((word) => !candidateSweetness.has(word)).length + [...candidateSweetness].filter((word) => !labelSweetness.has(word)).length;
  score -= Math.min(0.4, sweetnessMismatch * 0.2);

  // "Reserva", "Gran", "Select"... on only one side means another wine of the line.
  const labelTiers = tierWords([data.displayName, data.wine, data.designation, data.classification].filter(Boolean).join(" "));
  const candidateTiers = tierWords(candidateName);
  const tierMismatch = [...labelTiers].filter((word) => !candidateTiers.has(word)).length + [...candidateTiers].filter((word) => !labelTiers.has(word)).length;
  score -= Math.min(0.4, tierMismatch * 0.2);

  if (labelIsStandardBottle(data) && LARGE_OR_SMALL_FORMAT.test(normalizeText(candidate.displayName))) score -= 0.35;

  // Tie-breakers only. No vintage on the label: prefer the row without vintage
  // (the wine itself) over one specific vintage. Then prefer the richer row.
  if (!vintage && candidate.vintage === null) score += 0.02;
  // Tie-breaker only: prefer the richer row for the same wine.
  if (candidate.hasImage) score += 0.01;
  if (candidate.producer) score += 0.01;

  // "Producer, Wine, Region" rows: a word of the wine's own name that the label
  // does not show ("Rutini, Dominio Malbec Cabernet Franc" for a plain
  // "Rutini Cabernet Franc - Malbec") means another wine of the producer.
  // Producer and region words are ignored here ("Hacienda" Los Haroldos).
  const segments = candidate.displayName.split(",");
  if (segments.length >= 2) {
    const places = new Set((candidate.places ?? []).flatMap((place) => tokens(place)));
    const producerWords = new Set(tokens(candidate.producer ?? segments[0]));
    const unshown = tokens(segments[1]).filter((token) => !everythingRead.has(token) && !places.has(token) && !producerWords.has(token) && !TIER_WORDS.has(token));
    if (unshown.length) score = Math.min(score, 0.65);
  }

  // A grape on the label that the catalog row does not name: a varietal row
  // ("Rutini, Cabernet Franc") is not the blend on the label ("Cabernet Franc - Malbec").
  const missingGrape = [...labelIdentity].some((token) => GRAPE_WORDS.has(token) && !candidateIdentity.has(token));
  if (missingGrape || producerMissing) score = Math.min(score, 0.65);

  // The reverse: a grape in the row that nothing on the label shows ("Almadén
  // Cabernet Suave" or "Rutini Syrah" for a label that names no grape) is another wine.
  const unreadGrape = [...candidateIdentity].some((token) => GRAPE_WORDS.has(token) && !everythingRead.has(token));
  if (unreadGrape) score = Math.min(score, 0.6);

  // Too little was read to tell wines apart: only the producer ("Rutini"), or a
  // single word without producer ("La Flor", "Trifula"). Only a row fully explained
  // by the reading can be that wine.
  // When the "producer" read is in fact the wine's name (the row names another
  // producer: "Quinta de Foz de Arouce" by João Portugal Ramos), it is not thin.
  const nameTokens = [...labelIdentity].filter((token) => !producerTokens.includes(token));
  const rowProducer = new Set(tokens(candidate.producer));
  const producerIsRowProducer = !candidate.producer || producerTokens.some((token) => rowProducer.has(token));
  const thin = (nameTokens.length === 0 && producerIsRowProducer) || (nameTokens.length === 1 && producerTokens.length === 0);
  const places = new Set((candidate.places ?? []).flatMap((place) => tokens(place)));
  if (thin) {
    const unexplained = [...candidateIdentity].filter((token) => !hasWord(everythingRead, token) && !places.has(token));
    if (unexplained.length) score = Math.min(score, 0.6);
  }

  // The producer read appears nowhere in the row, and the row has a name of its own
  // that the label never showed ("Quara" for an "El Enemigo" label): another
  // producer's wine, even when the row has no producer field.
  const producerAbsent = producerTokens.length > 0 && !producerTokens.some((token) => hasWord(candidateIdentity, token));
  const ownName = [...candidateIdentity].filter((token) => !hasWord(everythingRead, token) && !places.has(token) && !GRAPE_WORDS.has(token) && !TIER_WORDS.has(token));
  if (producerAbsent && ownName.length) score = Math.min(score, 0.6);

  // A word of the wine's name on the label that the row does not have ("La Flor"
  // for a "Pulenta Estate I Malbec") names another wine of the producer.
  const unmatchedName = nameTokens.filter((token) => !hasWord(candidateIdentity, token) && !GRAPE_WORDS.has(token) && !places.has(token) && !TIER_WORDS.has(token));
  if (unmatchedName.length) score = Math.min(score, 0.65);

  // A row for another vintage is another bottle (its notes and scores differ):
  // keep it below the match threshold so it is offered as an alternative.
  if (vintage && candidate.vintage && candidate.vintage !== vintage) score = Math.min(score, 0.6);

  // Not capped at 1 here: a perfect name match with the same vintage must still
  // outrank a perfect name match without it. decideMatch caps what it reports.
  return Math.max(0, score);
}

function tierWords(text: string) {
  return new Set(normalizeText(text).split(" ").filter((word) => TIER_WORDS.has(word)));
}

export const MATCH_THRESHOLD = 0.72;
const AMBIGUITY_MARGIN = 0.04;

export function decideMatch(data: ScannedWineData, candidates: CatalogCandidate[]): MatchDecision {
  const scored = candidates
    .map((candidate) => ({ candidate, raw: scoreCandidate(data, candidate) }))
    .sort((a, b) => b.raw - a.raw)
    .map(({ candidate, raw }) => ({ ...candidate, score: Number(Math.min(1, raw).toFixed(3)), raw }));
  const [best, second] = scored;
  const alternatives = scored.filter((candidate) => candidate.score >= 0.45).slice(0, 4);

  if (!best || best.raw < MATCH_THRESHOLD) return { status: "no_match", alternatives: strip(alternatives) };
  // Two different wines scoring the same means the label did not tell them apart.
  // Near-perfect ties are the same wine catalogued twice (different sources);
  // the tie-breakers already put the richer row first.
  if (second && best.raw < 0.9 && best.raw - second.raw < AMBIGUITY_MARGIN && !sameWine(best, second)) {
    return { status: "no_match", alternatives: strip(alternatives) };
  }
  return { status: "matched", best: strip([best])[0], alternatives: strip(alternatives.filter((candidate) => candidate.id !== best.id)) };
}

function strip(list: Array<ScoredCandidate & { raw: number }>): ScoredCandidate[] {
  return list.map(({ raw: _raw, ...candidate }) => candidate);
}

// The same wine catalogued twice ("Vinho Rutini Cabernet / Malbec" and
// "Rutini, Cabernet Malbec, Mendoza") differs only by generic and place words.
export function sameWine(a: CatalogCandidate, b: CatalogCandidate) {
  const places = new Set([...(a.places ?? []), ...(b.places ?? [])].flatMap((place) => tokens(place)));
  const name = (candidate: CatalogCandidate) => [...new Set(tokens([candidate.displayName, candidate.producer].join(" ")))].filter((token) => !places.has(token)).sort().join(" ");
  return name(a) === name(b);
}
