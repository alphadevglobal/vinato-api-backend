import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pool } from "../src/db.js";
import type { Wine } from "../src/types.js";
import { upsertWines } from "../src/wine-upsert.js";

const VINTAGES_URL = "https://huggingface.co/datasets/Dakhoo/L2T-NeurIPS-2023/resolve/main/data/vintages/vintages_dataset.jsonl";
const ALL_URL = "https://huggingface.co/datasets/Dakhoo/L2T-NeurIPS-2023/resolve/main/data/all/all_dataset.jsonl";
const BATCH_SIZE = 500;
const materializeOnly = process.argv.includes("--materialize-only");

type WineSensedRow = {
  vintage_id?: unknown; image?: unknown; review?: unknown; experiment_id?: unknown;
  year?: unknown; winery_id?: unknown; wine_alcohol?: unknown; country?: unknown;
  region?: unknown; price?: unknown; rating?: unknown; grape?: unknown;
  vintage_page_url?: unknown; wine?: unknown;
};

type Observation = { id: string; vintageId: string; imagePath: string | null; review: string | null; experimentId: string | null };

try {
  if (!materializeOnly) {
    await importStream(VINTAGES_URL, false);
    await importStream(ALL_URL, true);
  }
  await materializeCatalog();
  await pool.query(`
    UPDATE catalog_wines wine
    SET review_count = counts.total,
        image_path = COALESCE(wine.image_path, counts.image_path),
        updated_at = now()
    FROM (
      SELECT vintage_id, COUNT(review)::int AS total, MIN(image_path) FILTER (WHERE image_path IS NOT NULL) AS image_path
      FROM winesensed_observations
      GROUP BY vintage_id
    ) counts
    WHERE wine.source = 'winesensed' AND wine.source_id = counts.vintage_id
  `);
  const summary = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM catalog_wines WHERE source = 'winesensed') AS wines,
      (SELECT COUNT(*)::int FROM winesensed_observations) AS observations,
      (SELECT COUNT(*)::int FROM winesensed_observations WHERE review IS NOT NULL) AS reviews,
      (SELECT COUNT(*)::int FROM winesensed_observations WHERE image_path IS NOT NULL) AS image_references
  `);
  console.log("WineSensed import complete", summary.rows[0]);
} finally {
  await pool.end();
}

async function materializeCatalog() {
  const result = await pool.query(`
    INSERT INTO catalog_wines (
      id, lwin, status, display_name, wine, type, reference,
      source, source_id, image_path, review_count, created_at, updated_at
    )
    SELECT
      gen_random_uuid(),
      'hf-' || observations.vintage_id,
      'test-only',
      'WineSensed Vintage #' || observations.vintage_id,
      NULL,
      'Wine',
      'WineSensed / Dakhoo/L2T-NeurIPS-2023; CC BY-NC-ND 4.0; TEST ONLY',
      'winesensed',
      observations.vintage_id,
      MIN(observations.image_path) FILTER (WHERE observations.image_path IS NOT NULL),
      COUNT(observations.review)::int,
      now(),
      now()
    FROM winesensed_observations observations
    GROUP BY observations.vintage_id
    ON CONFLICT (lwin) DO UPDATE SET
      image_path = COALESCE(catalog_wines.image_path, EXCLUDED.image_path),
      review_count = EXCLUDED.review_count,
      updated_at = now()
  `);
  console.log(`WineSensed catalog materialized: ${result.rowCount ?? 0} vintages processed`);
}

async function importStream(url: string, includeObservations: boolean) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Hugging Face returned ${response.status} for ${url}`);
  const lines = createInterface({ input: Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>), crlfDelay: Infinity });
  let wines: Wine[] = [];
  let observations: Observation[] = [];
  let read = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    read += 1;
    const row = JSON.parse(line) as WineSensedRow;
    const wine = mapWine(row);
    if (wine) wines.push(wine);
    if (includeObservations) {
      const observation = mapObservation(row);
      if (observation) observations.push(observation);
    }
    if (wines.length >= BATCH_SIZE || observations.length >= BATCH_SIZE) {
      await flush(wines, observations);
      wines = [];
      observations = [];
    }
    if (read % 25_000 === 0) console.log(`${url.includes("/all/") ? "all" : "vintages"}: ${read} rows processed`);
  }
  await flush(wines, observations);
  console.log(`${url.includes("/all/") ? "all" : "vintages"}: ${read} rows processed`);
}

async function flush(wines: Wine[], observations: Observation[]) {
  if (wines.length) {
    const unique = [...new Map(wines.map((wine) => [wine.lwin, wine])).values()];
    await upsertWines(pool, unique);
  }
  if (!observations.length) return;
  await pool.query(`
    INSERT INTO winesensed_observations (id, vintage_id, image_path, review, experiment_id)
    SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
    ON CONFLICT (id) DO NOTHING
  `, [
    observations.map((item) => item.id), observations.map((item) => item.vintageId),
    observations.map((item) => item.imagePath), observations.map((item) => item.review),
    observations.map((item) => item.experimentId),
  ]);
}

function mapWine(row: WineSensedRow): Wine | null {
  const vintageId = clean(row.vintage_id);
  const wineName = clean(row.wine);
  if (!vintageId || !wineName) return null;
  const year = integer(row.year);
  const now = new Date().toISOString();
  return {
    id: stableUuid(`winesensed:${vintageId}`), lwin: `hf-${vintageId}`, status: "test-only",
    displayName: year && !wineName.includes(String(year)) ? `${wineName} ${year}` : wineName,
    producerTitle: null, producerName: clean(row.winery_id) ? `Winery ${clean(row.winery_id)}` : null,
    wine: wineName, country: clean(row.country), region: clean(row.region)?.trim() ?? null,
    subRegion: null, site: null, parcel: null, colour: null, type: "Wine", subType: null,
    designation: null, classification: null, vintageConfig: year ? "sequential" : null,
    firstVintage: year ? String(year) : null, finalVintage: year ? String(year) : null,
    dateAdded: "2023-05-01", dateUpdated: "2025-02-13",
    reference: "WineSensed / Dakhoo/L2T-NeurIPS-2023; CC BY-NC-ND 4.0; TEST ONLY",
    source: "winesensed", sourceId: vintageId, vintageYear: year,
    alcohol: decimal(row.wine_alcohol), priceUsd: decimal(row.price), rating: decimal(row.rating),
    grapes: clean(row.grape), imagePath: clean(row.image), imageUrl: null,
    sourceUrl: normalizeUrl(clean(row.vintage_page_url)), reviewCount: 0,
    createdAt: now, updatedAt: now,
  };
}

function mapObservation(row: WineSensedRow): Observation | null {
  const vintageId = clean(row.vintage_id);
  const imagePath = clean(row.image);
  const review = clean(row.review);
  if (!vintageId || (!imagePath && !review)) return null;
  const experimentId = clean(row.experiment_id);
  return { id: createHash("sha256").update([vintageId, imagePath, review, experimentId].join("\u0000")).digest("hex"), vintageId, imagePath, review, experimentId };
}

function stableUuid(input: string) {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}
function clean(value: unknown) { if (value === null || value === undefined) return null; const result = String(value).trim(); return result || null; }
function integer(value: unknown) { const number = Number(value); return Number.isInteger(number) ? number : null; }
function decimal(value: unknown) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function normalizeUrl(value: string | null) { if (!value) return null; return value.startsWith("http") ? value : `https://${value}`; }
