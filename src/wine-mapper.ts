import type { Wine, WineRow } from "./types.js";

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
  createdAt: toIsoString(row.created_at),
  updatedAt: toIsoString(row.updated_at),
});
