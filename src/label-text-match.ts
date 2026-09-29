import {
  colourOf, GRAPE_WORDS, LARGE_OR_SMALL_FORMAT, normalizeText, sameWine, sweetnessOf, TIER_WORDS, tokens,
  type CatalogCandidate,
} from "./catalog-matcher.js";

/**
 * Scan without AI tokens. The phone reads the label itself (Apple Vision: every
 * printed line with its height, and the barcodes) and the API looks the wine up in
 * the catalog. Only an EXACT answer is accepted: the catalog wine must explain the
 * label and the label must name the whole catalog wine. Anything uncertain returns
 * null and the scan goes to the AI exactly as before. A wrong wine is worse than a
 * paid reading.
 */

export type DeviceLine = { text: string; confidence: number; height: number };
export type DeviceReading = { lines: DeviceLine[]; barcodes: string[] };

/** The phone's reading, as sent in the multipart field "deviceReading" (JSON). Invalid parts are dropped. */
export function parseDeviceReading(raw: unknown): DeviceReading | null {
  if (typeof raw !== "string" || !raw || raw.length > 60_000) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const input = value as { lines?: unknown; barcodes?: unknown };
  const lines = (Array.isArray(input.lines) ? input.lines : []).slice(0, 120).flatMap((line): DeviceLine[] => {
    const { text, confidence, height } = (line ?? {}) as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) return [];
    const conf = Number(confidence);
    const h = Number(height);
    if (!Number.isFinite(conf) || !Number.isFinite(h) || h <= 0 || h > 1) return [];
    return [{ text: text.trim().slice(0, 160), confidence: Math.min(1, Math.max(0, conf)), height: h }];
  });
  const barcodes = [...new Set((Array.isArray(input.barcodes) ? input.barcodes : []).map((code) => normalizeBarcode(code)).filter((code): code is string => Boolean(code)))].slice(0, 4);
  return lines.length || barcodes.length ? { lines, barcodes } : null;
}

/**
 * Product barcode as a 13-digit EAN (UPC-A gets its leading zero, EAN-8 stays 8
 * digits), only when the check digit is right: a misread code never finds a wine.
 */
export function normalizeBarcode(value: unknown): string | null {
  const digits = typeof value === "string" || typeof value === "number" ? String(value).replace(/\D/g, "") : "";
  const code = digits.length === 12 ? `0${digits}` : digits;
  if (code.length !== 13 && code.length !== 8) return null;
  if (/^0+$/.test(code)) return null;
  const body = code.slice(0, -1).split("").map(Number);
  // Weights 3/1 from the right of the body (EAN-13 and EAN-8 alike).
  const sum = body.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code.at(-1)) ? code : null;
}

// Vision answers 1.0 for text it is sure of and 0.3–0.5 for guesses. Real labels showed
// 0.5 readings with wrong letters ("CUMIBRERO", "MES DE MURRIETA"): the wine's name
// (the big print) must be read with full confidence; the small print only supports it.
const TRUSTED_CONFIDENCE = 0.5;
const NAME_CONFIDENCE = 0.9;
// Lines at least this share of the tallest line are "the name on the label".
const PROMINENT_SHARE = 0.55;

const trusted = (reading: DeviceReading) => reading.lines.filter((line) => line.confidence >= TRUSTED_CONFIDENCE);

/** Years printed on the label (vintage candidates). */
export function labelYears(reading: DeviceReading, now = new Date()) {
  const years = new Set<number>();
  for (const line of trusted(reading)) {
    for (const match of line.text.matchAll(/\b(19[0-9]{2}|20[0-9]{2})\b/g)) {
      const year = Number(match[1]);
      if (year <= now.getFullYear()) years.add(year);
    }
  }
  return [...years];
}

/** The big-print lines, or null when the reading is too weak to be exact. */
export function prominentLines(reading: DeviceReading) {
  if (!reading.lines.length) return null;
  const tallest = Math.max(...reading.lines.map((line) => line.height));
  const prominent = reading.lines.filter((line) => line.height >= tallest * PROMINENT_SHARE);
  // The name itself was not read with certainty: never guess it.
  if (prominent.some((line) => line.confidence < NAME_CONFIDENCE)) return null;
  return prominent;
}

/** Search strings for the catalog: the big-print name, alone and with the grapes read. */
export function deviceSearchTerms(reading: DeviceReading) {
  const prominent = prominentLines(reading);
  if (!prominent) return [];
  const name = tokens(prominent.map((line) => line.text).join(" "));
  const everything = new Set(trusted(reading).flatMap((line) => normalizeText(line.text).split(" ")));
  const grapes = [...everything].filter((word) => GRAPE_WORDS.has(word) && !name.includes(word));
  const terms = [name.join(" "), [...name, ...grapes].join(" "), ...prominent.map((line) => tokens(line.text).join(" "))];
  return [...new Set(terms.filter((term) => term.length >= 3))].slice(0, 6);
}

export type ExactMatch = { candidate: CatalogCandidate; vintage: number | null };

/**
 * The catalog wine the label names, exactly, or null. Every rule below errs
 * towards null (the AI then reads the label as before).
 */
export function exactTextMatch(reading: DeviceReading, candidates: CatalogCandidate[], now = new Date()): ExactMatch | null {
  const prominent = prominentLines(reading);
  if (!prominent) return null;
  const lines = trusted(reading);
  const allText = lines.map((line) => line.text).join(" ");
  const words = new Set(normalizeText(allText).split(" ").filter(Boolean));
  const identity = new Set(tokens(allText));
  const bigWords = [...new Set(tokens(prominent.map((line) => line.text).join(" ")))].filter((word) => !/^\d+$/.test(word));
  if (!bigWords.length) return null;
  const years = labelYears(reading, now);
  const labelColour = colourOf(allText);
  const labelSweetness = sweetnessOf(allText);
  const labelFormat = LARGE_OR_SMALL_FORMAT.test(normalizeText(allText));
  const labelGrapes = [...words].filter((word) => GRAPE_WORDS.has(word));
  const labelTiers = [...words].filter((word) => TIER_WORDS.has(word));

  const passing = candidates.filter((candidate) => {
    const places = new Set((candidate.places ?? []).flatMap((place) => tokens(place)));
    const producer = new Set(tokens(candidate.producer));
    const own = new Set(tokens([candidate.displayName, candidate.wineName, candidate.producer].filter(Boolean).join(" ")));
    const name = [...own].filter((word) => !producer.has(word) && !places.has(word));
    const candidateText = normalizeText([candidate.displayName, candidate.wineName].filter(Boolean).join(" "));

    // 1. The whole name of the catalog wine is printed on the label.
    if (!name.length || !name.every((word) => identity.has(word))) return false;
    // 2. Its producer too (one word is enough: "Catena" for "Catena Zapata").
    if (producer.size && ![...producer].some((word) => identity.has(word))) return false;
    // 3. The big print is fully explained by this wine: "Catena Alta" is not "Catena Malbec".
    if (!bigWords.every((word) => own.has(word) || places.has(word))) return false;
    // ...and it names the wine itself, not only the region.
    if (!bigWords.some((word) => own.has(word))) return false;
    // 4. No grape and no "Reserva/Gran/Brut..." on the label that the wine lacks.
    if (labelGrapes.some((word) => !own.has(word))) return false;
    if (labelTiers.some((word) => !own.has(word))) return false;
    // 5. Same colour, sweetness and bottle format.
    const colour = colourOf(candidate.displayName) ?? colourOf(candidate.colour ?? "");
    if (labelColour && colour && labelColour !== colour) return false;
    const sweetness = sweetnessOf(candidateText);
    if ([...labelSweetness].some((word) => !sweetness.has(word)) || [...sweetness].some((word) => !labelSweetness.has(word))) return false;
    if (LARGE_OR_SMALL_FORMAT.test(candidateText) !== labelFormat) return false;
    // 6. A row for one vintage only answers to that year printed on the label.
    if (candidate.vintage && !years.includes(candidate.vintage)) return false;
    return true;
  });
  if (!passing.length) return null;

  const nameOf = (candidate: CatalogCandidate) => {
    const places = new Set((candidate.places ?? []).flatMap((place) => tokens(place)));
    const producer = new Set(tokens(candidate.producer));
    return new Set(tokens([candidate.displayName, candidate.wineName, candidate.producer].filter(Boolean).join(" ")).filter((word) => !producer.has(word) && !places.has(word)));
  };
  // The most specific wine explains the label; a shorter name inside it is the same line, not a rival.
  const ranked = [...passing].sort((a, b) => nameOf(b).size - nameOf(a).size);
  const best = ranked[0];
  const bestName = nameOf(best);
  for (const other of ranked.slice(1)) {
    const otherName = nameOf(other);
    const inside = [...otherName].every((word) => bestName.has(word));
    // Two different wines both fit the label: not exact.
    if (!inside && !sameWine(best, other)) return null;
    if (otherName.size === bestName.size && !sameWine(best, other)) return null;
  }

  const vintage = years.length === 1 ? years[0] : best.vintage ?? null;
  // Duplicates of the same wine: the row for the printed vintage, then the one with a photo.
  const sameName = ranked.filter((candidate) => sameWine(candidate, best));
  const chosen = sameName.find((candidate) => vintage && candidate.vintage === vintage)
    ?? sameName.find((candidate) => !candidate.vintage && candidate.hasImage)
    ?? sameName.find((candidate) => !candidate.vintage)
    ?? best;
  return { candidate: chosen, vintage };
}

/** Volume printed on the label ("750 ml"), for the scan result. */
export function labelVolume(reading: DeviceReading) {
  const match = trusted(reading).map((line) => line.text).join(" ").match(/\b(\d{3,4})\s?(ml|mL|ML)\b|\b(\d[,.]\d{1,2})\s?(l|L)\b/);
  return match ? match[0].replace(/\s+/g, " ") : null;
}
