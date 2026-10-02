import type { DrinkingPhase, Wine, WineAward, WineRow } from "./types.js";
import { photoUrl } from "./photo-url.js";

/** catalog_wines.drinking_window → the valid phases, by start year. */
export function drinkingPhases(value: unknown): DrinkingPhase[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DrinkingPhase[] => {
    const phase = (item ?? {}) as Record<string, unknown>;
    const from = Number(phase.from);
    const to = phase.to === null || phase.to === undefined ? null : Number(phase.to);
    const note = typeof phase.note === "string" ? phase.note.trim() : "";
    if (!Number.isInteger(from) || from < 0 || !note || (to !== null && (!Number.isInteger(to) || to < from))) return [];
    return [{ from, to, ...(phase.plus === true ? { plus: true } : {}), note }];
  }).sort((a, b) => a.from - b.from);
}

/** catalog_awarded_wines.awards → the awards with an event or a result, newest first. */
export function wineAwards(value: unknown): WineAward[] {
  if (!Array.isArray(value)) return [];
  const text = (item: unknown) => typeof item === "string" && item.trim() ? item.trim() : null;
  const year = (item: unknown) => Number.isInteger(Number(item)) && Number(item) > 0 ? Number(item) : null;
  return value.flatMap((item): WineAward[] => {
    const award = (item ?? {}) as Record<string, unknown>;
    const result = text(award.result);
    const event = text(award.event_name);
    if (!result && !event) return [];
    return [{ result, title: text(award.title), event, country: text(award.country), year: year(award.award_year), vintage: year(award.wine_vintage),
      symbol: text(award.badge_symbol), sourceUrl: text(award.source_url) }];
  }).sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
}

const toIsoString = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export const mapWineRow = (row: WineRow): Wine => ({
  id: row.id,
  lwin: row.lwin,
  status: row.status,
  displayName: row.display_name,
  producerTitle: row.producer_title,
  producerName: row.producer_name,
  wine: row.wine,
  country: row.country,
  region: row.region,
  subRegion: row.sub_region,
  site: row.site,
  parcel: row.parcel,
  colour: row.colour,
  type: row.type,
  subType: row.sub_type,
  designation: row.designation,
  classification: row.classification,
  vintageConfig: row.vintage_config,
  firstVintage: row.first_vintage,
  finalVintage: row.final_vintage,
  dateAdded: row.date_added,
  dateUpdated: row.date_updated,
  reference: row.reference,
  source: row.source,
  sourceId: row.source_id,
  vintageYear: row.vintage_year,
  alcohol: row.alcohol === null ? null : Number(row.alcohol),
  agingPotential: row.aging_potential ?? null,
  drinkingWindow: drinkingPhases(row.drinking_window),
  priceUsd: row.price_usd === null ? null : Number(row.price_usd),
  rating: row.rating === null ? null : Number(row.rating),
  grapes: row.grapes,
  imagePath: row.image_path,
  imageUrl: photoUrl(row.id, row.image_url, 0),
  sourceUrl: row.source_url,
  reviewCount: row.review_count,
  awardsCount: row.awards_count,
  latestAwardYear: row.latest_award_year,
  awardSymbol: row.award_symbol,
  awards: wineAwards(row.awards),
  dataSource: row.data_source ?? "catalog",
  curationStatus: row.curation_status ?? "approved",
  backImageUrl: photoUrl(row.id, row.back_image_url, 1),
  pairings: (row.pairings ?? []).filter(Boolean),
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
});
