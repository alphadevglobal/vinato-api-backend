import { config } from "../src/config.js";
import { pool } from "../src/db.js";
import type { PaginatedWines, Wine } from "../src/types.js";
import { upsertWines } from "../src/wine-upsert.js";

type ImportOptions = {
  pages: number | "all";
  limit: number;
  startPage: number;
  truncate: boolean;
};

const options = parseArgs(process.argv.slice(2));

try {
  if (options.truncate) {
    await pool.query("TRUNCATE TABLE wines");
    console.log("Truncated wines table.");
  }

  let imported = 0;
  let currentPage = options.startPage;
  const maxPageExclusive =
    options.pages === "all"
      ? Number.POSITIVE_INFINITY
      : options.startPage + options.pages;
  let totalPages: number | null = null;

  while (true) {
    if (currentPage >= maxPageExclusive) {
      break;
    }

    const url = new URL("/wines", config.sourceApiUrl);
    url.searchParams.set("page", String(currentPage));
    url.searchParams.set("limit", String(options.limit));

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Source API returned ${response.status} for ${url.toString()}`);
    }

    const page = (await response.json()) as PaginatedWines;
    totalPages = page.totalPages;
    await upsertWines(pool, page.data.map(normalizeWine));
    imported += page.data.length;
    console.log(`Imported page ${currentPage}/${totalPages}: ${page.data.length} wines`);

    if (!page.data.length || currentPage >= page.totalPages) break;
    currentPage += 1;
  }

  console.log(`Import complete. ${imported} wines imported.`);
} finally {
  await pool.end();
}

function parseArgs(args: string[]): ImportOptions {
  const flags = new Map<string, string | boolean>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, value] = arg.slice(2).split("=", 2);
    flags.set(key, value ?? true);
  }

  const pagesValue = String(flags.get("pages") ?? "10");
  const pages: ImportOptions["pages"] =
    pagesValue === "all" ? "all" : positiveInteger(pagesValue, "pages");
  const limit = positiveInteger(String(flags.get("limit") ?? "100"), "limit");
  const startPage = positiveInteger(String(flags.get("start-page") ?? "1"), "start-page");

  if (limit > 100) {
    throw new Error("limit must be <= 100 because the source API caps pagination there.");
  }

  return {
    pages,
    limit,
    startPage,
    truncate: flags.has("truncate"),
  };
}

function positiveInteger(value: string, name: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizeWine(wine: Wine): Wine {
  return {
    ...wine,
    status: wine.status ?? null,
    producerTitle: wine.producerTitle ?? null,
    producerName: wine.producerName ?? null,
    wine: wine.wine ?? null,
    country: wine.country ?? null,
    region: wine.region ?? null,
    subRegion: wine.subRegion ?? null,
    site: wine.site ?? null,
    parcel: wine.parcel ?? null,
    colour: wine.colour ?? null,
    type: wine.type ?? null,
    subType: wine.subType ?? null,
    designation: wine.designation ?? null,
    classification: wine.classification ?? null,
    vintageConfig: wine.vintageConfig ?? null,
    firstVintage: wine.firstVintage ?? null,
    finalVintage: wine.finalVintage ?? null,
    dateAdded: wine.dateAdded ?? null,
    dateUpdated: wine.dateUpdated ?? null,
    reference: wine.reference ?? null,
  };
}
