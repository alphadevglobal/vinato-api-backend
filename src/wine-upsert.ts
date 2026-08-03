import type pg from "pg";
import type { Wine } from "./types.js";

const columns = [
  "id",
  "lwin",
  "status",
  "display_name",
  "producer_title",
  "producer_name",
  "wine",
  "country",
  "region",
  "sub_region",
  "site",
  "parcel",
  "colour",
  "type",
  "sub_type",
  "designation",
  "classification",
  "vintage_config",
  "first_vintage",
  "final_vintage",
  "date_added",
  "date_updated",
  "reference",
  "created_at",
  "updated_at",
] as const;

export async function upsertWines(pool: pg.Pool, wines: Wine[]) {
  if (!wines.length) return;

  const values: unknown[] = [];
  const rowsSql = wines.map((wine, rowIndex) => {
    const rowValues = wineToRowValues(wine);
    values.push(...rowValues);
    const offset = rowIndex * columns.length;
    return `(${columns.map((_, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  });

  const updates = columns
    .filter((column) => column !== "lwin")
    .map((column) => `${column} = EXCLUDED.${column}`)
    .join(", ");

  await pool.query(
    `
      INSERT INTO wines (${columns.join(", ")})
      VALUES ${rowsSql.join(", ")}
      ON CONFLICT (lwin) DO UPDATE SET ${updates}
    `,
    values,
  );
}

function wineToRowValues(wine: Wine) {
  return [
    wine.id,
    wine.lwin,
    wine.status,
    wine.displayName,
    wine.producerTitle,
    wine.producerName,
    wine.wine,
    wine.country,
    wine.region,
    wine.subRegion,
    wine.site,
    wine.parcel,
    wine.colour,
    wine.type,
    wine.subType,
    wine.designation,
    wine.classification,
    wine.vintageConfig,
    wine.firstVintage,
    wine.finalVintage,
    wine.dateAdded,
    wine.dateUpdated,
    wine.reference,
    wine.createdAt,
    wine.updatedAt,
  ];
}
