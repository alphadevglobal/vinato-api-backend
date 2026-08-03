import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pool } from "../src/db.js";
import type { Wine } from "../src/types.js";
import { upsertWines } from "../src/wine-upsert.js";

const defaultJsonlUrl =
  "https://huggingface.co/datasets/Dakhoo/L2T-NeurIPS-2023/resolve/main/data/vintages/vintages_dataset.jsonl";
const options = parseArgs(process.argv.slice(2));

try {
  const response = await fetch(options.url);
  if (!response.ok || !response.body) {
    throw new Error(`Hugging Face returned ${response.status} for ${options.url}`);
  }

  const nodeStream = Readable.fromWeb(
    response.body as unknown as NodeReadableStream<Uint8Array>,
  );
  const lines = createInterface({
    input: nodeStream,
    crlfDelay: Infinity,
  });

  const seen = new Set<string>();
  let batch: Wine[] = [];
  let imported = 0;
  let read = 0;
  let skipped = 0;

  for await (const line of lines) {
    read += 1;
    if (!line.trim()) continue;
    const row = JSON.parse(line) as WineSensedRow;
    const wine = mapWineSensedRow(row);
    if (!wine || seen.has(wine.lwin)) {
      skipped += 1;
      continue;
    }

    seen.add(wine.lwin);
    batch.push(wine);

    if (batch.length >= options.batchSize) {
      await flush(batch, options.dryRun);
      imported += batch.length;
      console.log(`Imported ${imported} wines (${read} rows read)`);
      batch = [];
    }

    if (options.limit && imported + batch.length >= options.limit) {
      break;
    }
  }

  if (batch.length) {
    await flush(batch, options.dryRun);
    imported += batch.length;
  }

  console.log(
    `Hugging Face import complete. imported=${imported} read=${read} skipped=${skipped} dryRun=${options.dryRun}`,
  );
} finally {
  await pool.end();
}

type WineSensedRow = {
  vintage_id?: unknown;
  image?: unknown;
  review?: unknown;
  experiment_id?: unknown;
  year?: unknown;
  winery_id?: unknown;
  wine_alcohol?: unknown;
  country?: unknown;
  region?: unknown;
  price?: unknown;
  rating?: unknown;
  grape?: unknown;
  vintage_page_url?: unknown;
  wine?: unknown;
};

type ImportOptions = {
  url: string;
  limit: number | null;
  batchSize: number;
  dryRun: boolean;
};

async function flush(batch: Wine[], dryRun: boolean) {
  if (dryRun) return;
  await upsertWines(pool, batch);
}

function mapWineSensedRow(row: WineSensedRow): Wine | null {
  const vintageId = clean(row.vintage_id);
  const wineName = clean(row.wine);
  if (!vintageId || !wineName) return null;

  const year = clean(row.year);
  const displayName = year && !wineName.includes(year) ? `${wineName} ${year}` : wineName;
  const now = new Date().toISOString();

  return {
    id: stableUuid(`winesensed:${vintageId}`),
    lwin: `hf-${vintageId}`,
    status: "Live",
    displayName,
    producerTitle: null,
    producerName: clean(row.winery_id) ? `Winery ${clean(row.winery_id)}` : null,
    wine: wineName,
    country: clean(row.country),
    region: clean(row.region),
    subRegion: null,
    site: null,
    parcel: null,
    colour: null,
    type: "Wine",
    subType: null,
    designation: null,
    classification: clean(row.rating) ? `Rating ${clean(row.rating)}` : null,
    vintageConfig: year ? "sequential" : null,
    firstVintage: year,
    finalVintage: year,
    dateAdded: "2023-05-01",
    dateUpdated: "2025-02-13",
    reference: buildReference(row),
    createdAt: now,
    updatedAt: now,
  };
}

function buildReference(row: WineSensedRow) {
  return [
    "WineSensed / Dakhoo/L2T-NeurIPS-2023",
    pair("vintage_id", clean(row.vintage_id)),
    pair("winery_id", clean(row.winery_id)),
    pair("alcohol", clean(row.wine_alcohol)),
    pair("price_usd", clean(row.price)),
    pair("rating", clean(row.rating)),
    pair("grape", clean(row.grape)),
    pair("image", clean(row.image)),
    pair("url", clean(row.vintage_page_url)),
  ]
    .filter(Boolean)
    .join("; ");
}

function pair(key: string, value: string | null) {
  return value ? `${key}=${value}` : null;
}

function stableUuid(input: string) {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function clean(value: unknown) {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

function parseArgs(args: string[]): ImportOptions {
  const flags = new Map<string, string | boolean>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    flags.set(key, value ?? true);
  }

  return {
    url: String(flags.get("url") ?? defaultJsonlUrl),
    limit: flags.has("limit") ? parseLimit(String(flags.get("limit"))) : null,
    batchSize: positiveInteger(String(flags.get("batch-size") ?? "500"), "batch-size"),
    dryRun: flags.has("dry-run"),
  };
}

function positiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseLimit(value: string) {
  return value === "all" ? null : positiveInteger(value, "limit");
}
