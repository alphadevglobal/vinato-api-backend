import { normalizeText } from "./catalog-matcher.js";
import type { ScannedWineData } from "./types.js";

/**
 * Catalog facts proposed by the AI, keyed by the field names shared with the
 * admin curation screen (vinato-web lib/wine-curation.ts) and stored in
 * wine_ai_proposals.proposed / current_values.
 */
export type CatalogFields = {
  displayName?: string;
  wineName?: string;
  producer?: string;
  country?: string;
  region?: string;
  subRegion?: string;
  colour?: string;
  wineType?: string;
  designation?: string;
  classification?: string;
  vintage?: number;
  alcoholPercent?: number;
  grapes?: string[];
  description?: string;
  pairings?: string[];
};
export type CatalogField = keyof CatalogFields;

// Name and vintage identify the catalog row: the AI may create a wine with them,
// but never proposes to rename or re-date an existing one.
const IDENTITY_FIELDS: CatalogField[] = ["displayName", "wineName", "vintage"];
export const UPDATABLE_FIELDS: CatalogField[] = [
  "producer", "country", "region", "subRegion", "colour", "wineType", "designation", "classification",
  "alcoholPercent", "grapes", "description", "pairings",
];

const COLOURS: Record<string, string> = {
  tinto: "Red", red: "Red", rouge: "Red", rosso: "Red",
  branco: "White", white: "White", blanc: "White", blanco: "White", bianco: "White",
  rose: "Rose", rosado: "Rose", rosato: "Rose",
  espumante: "Sparkling", sparkling: "Sparkling", champagne: "Sparkling", cava: "Sparkling", prosecco: "Sparkling",
  fortificado: "Fortified", fortified: "Fortified", sobremesa: "Dessert", dessert: "Dessert", laranja: "Amber", orange: "Amber",
};

/** Catalog colour ("Red", "White", "Rose", "Sparkling"...) for a label reading ("tinto", "rosé"...). */
export function catalogColour(value: string | null | undefined) {
  const key = normalizeText(value);
  if (!key) return undefined;
  return COLOURS[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

/** "13,5% vol" → 13.5. */
export function alcoholPercent(value: string | null | undefined) {
  const match = value?.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return undefined;
  const parsed = Number(match[1].replace(",", "."));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

const text = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};
const list = (value: string | string[] | null | undefined) => {
  const items = (Array.isArray(value) ? value : (value ?? "").split(",")).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

/** Every catalog field the AI reading can fill. */
export function readingToCatalogFields(reading: ScannedWineData): CatalogFields {
  const producer = text(reading.producerName) ?? text(reading.producerTitle);
  const wineName = text(reading.wine);
  const displayName = text(reading.displayName) ?? ([producer, wineName].filter(Boolean).join(" ") || undefined);
  const vintage = reading.vintage && /^\d{4}$/.test(reading.vintage) ? Number(reading.vintage) : undefined;
  const fields: CatalogFields = {
    displayName,
    wineName: wineName ?? displayName,
    producer,
    country: text(reading.country),
    region: text(reading.region),
    subRegion: text(reading.subRegion),
    colour: catalogColour(reading.colour),
    wineType: text(reading.type),
    designation: text(reading.designation),
    classification: text(reading.classification),
    vintage,
    alcoholPercent: alcoholPercent(reading.alcoholContent),
    grapes: list(reading.grapes),
    description: text(reading.description),
    pairings: list(reading.foodPairings),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as CatalogFields;
}

/** Whether a reading names a wine at all (a wine can be created from it). */
export function canCreateWine(fields: CatalogFields) {
  return Boolean(fields.displayName && fields.wineName);
}

const comparable = (value: unknown) => Array.isArray(value)
  ? value.map((item) => normalizeText(String(item))).sort().join("|")
  : typeof value === "number" ? String(value) : normalizeText(typeof value === "string" ? value : "");

/**
 * Fields the AI would fill (catalog empty) or change (catalog differs) on an
 * existing wine. Identity fields are never proposed.
 */
export function proposedUpdates(current: CatalogFields, proposed: CatalogFields) {
  const changes: CatalogFields = {};
  for (const field of UPDATABLE_FIELDS) {
    if (IDENTITY_FIELDS.includes(field)) continue;
    const next = proposed[field];
    if (next === undefined || comparable(next) === "") continue;
    if (comparable(next) === comparable(current[field])) continue;
    (changes as Record<string, unknown>)[field] = next;
  }
  return changes;
}
