import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { CatalogCandidate } from "../src/catalog-matcher.js";
import { PgWineRepository } from "../src/wines.repository.js";

const read = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");
const EAN = "4620017455554";

describe("migration 022: barcodes learned from scans", () => {
  let db: PGlite;
  let repository: PgWineRepository;
  const wine = async (name: string, extra = "") => (await db.query<{ id: string }>(`insert into catalog_wines (display_name${extra ? ", " + extra.split("=")[0] : ""}) values ('${name}'${extra ? ", " + extra.split("=")[1] : ""}) returning id`)).rows[0].id;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(`
      create table app_users (id uuid primary key default gen_random_uuid());
      create table catalog_wines (id uuid primary key default gen_random_uuid(), display_name text not null, vintage smallint,
        curation_status text not null default 'approved', merged_into uuid);
      create table scan_audit_logs (id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now());`);
    await db.exec(read("022_scan_without_ai.sql"));
    repository = new PgWineRepository(db as unknown as pg.Pool);
  });

  it("finds the wine of a barcode a scan already resolved, and counts confirmations", async () => {
    const id = await wine("Alamos Malbec");
    expect(await repository.findWineByBarcode(EAN)).toBeNull();
    await repository.rememberBarcode(EAN, id, "scan_ai");
    await repository.rememberBarcode(EAN, id, "scan_text");
    expect(await repository.findWineByBarcode(EAN)).toEqual({ wineId: id, vintage: null });
    const row = (await db.query<{ source: string; confirmations: number }>(`select source, confirmations from wine_barcodes`)).rows[0];
    expect(row).toEqual({ source: "scan_ai", confirmations: 1 });
  });

  it("keeps the first link unless the user corrected it, and follows merges and rejections", async () => {
    const right = await wine("Alamos Malbec");
    const wrong = await wine("Alamos Chardonnay");
    await repository.rememberBarcode(EAN, wrong, "scan_ai");
    await repository.rememberBarcode(EAN, right, "scan_ai");
    expect((await repository.findWineByBarcode(EAN))?.wineId).toBe(wrong);
    await repository.rememberBarcode(EAN, right, "scan_ai", undefined, true);
    expect((await repository.findWineByBarcode(EAN))?.wineId).toBe(right);
    expect((await db.query<{ corrections: number }>(`select corrections from wine_barcodes`)).rows[0].corrections).toBe(1);

    const merged = await wine("Alamos, Malbec");
    await db.query(`update catalog_wines set merged_into = $1 where id = $2`, [merged, right]);
    expect((await repository.findWineByBarcode(EAN))?.wineId).toBe(merged);
    await db.query(`update catalog_wines set merged_into = null, curation_status = 'rejected' where id = $1`, [right]);
    expect(await repository.findWineByBarcode(EAN)).toBeNull();
  });

  it("rejects malformed barcodes and adds the audit columns", async () => {
    const id = await wine("Vinho");
    await expect(db.query(`insert into wine_barcodes (barcode, wine_id) values ('12345', $1)`, [id])).rejects.toThrow();
    const columns = (await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'scan_audit_logs'`)).rows.map((row) => row.column_name);
    expect(columns).toEqual(expect.arrayContaining(["resolved_by", "device_reading"]));
  });
});

describe("POST /wine-scanner/scan tries the catalog before the AI", () => {
  const alamos = { id: "w-alamos", displayName: "Alamos Malbec", producer: "Catena Zapata", places: ["Mendoza"], wineName: null, vintage: null, hasImage: true, colour: "red" } as CatalogCandidate;
  const reading = (lines: Array<[string, number, number?]>, barcodes: string[] = []) =>
    JSON.stringify({ lines: lines.map(([text, height, confidence = 1]) => ({ text, height, confidence })), barcodes });
  const alamosReading = reading([["ALAMOS", 0.149], ["THE WINES OF CATENA", 0.058], ["MALBEC", 0.038], ["2005", 0.041]]);

  const setup = (links: Record<string, { wineId: string; vintage: number | null }> = {}) => {
    const scanWineLabel = vi.fn(async () => ({ success: true as const, data: { displayName: "Alamos Malbec", producerName: "Catena", confidence: 0.9 } as never }));
    const repo = {
      findById: vi.fn(async (id: string) => ({ id, displayName: id === "w-alamos" ? "Alamos Malbec" : "Outro", producerName: "Catena Zapata", vintageYear: null, reference: "Tinto elegante." })),
      findCandidatesByTerms: vi.fn(async () => [alamos, { ...alamos, id: "w-chard", displayName: "Alamos Chardonnay", colour: "white" }]),
      findWineByBarcode: vi.fn(async (code: string) => links[code] ?? null),
      rememberBarcode: vi.fn(async () => undefined),
      attachDeviceScan: vi.fn(async () => false),
      reconcileScan: vi.fn(async () => ({ status: "matched" as const, wineId: "w-ai", imageAdded: false, alternatives: [] })),
    };
    const record = vi.fn(async () => undefined);
    const app = createApp({ wineRepository: repo as never, wineScanner: { scanWineLabel }, scanAudit: { record } });
    const scan = (fields: Record<string, string>) => {
      const call = request(app).post("/wine-scanner/scan").attach("image", Buffer.from("jpeg"), { filename: "label.jpg", contentType: "image/jpeg" });
      for (const [key, value] of Object.entries(fields)) call.field(key, value);
      return call;
    };
    return { scan, repo, scanWineLabel, record };
  };

  it("answers from the label text without calling the AI, with the printed vintage", async () => {
    const { scan, scanWineLabel, record, repo } = setup();
    const response = await scan({ deviceReading: alamosReading }).expect(200);
    expect(scanWineLabel).not.toHaveBeenCalled();
    expect(response.body.catalog).toMatchObject({ status: "matched", wineId: "w-alamos", resolvedBy: "text" });
    expect(response.body.data).toMatchObject({ displayName: "Alamos Malbec", vintage: "2005", confidence: 1 });
    expect(repo.attachDeviceScan).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ resolvedBy: "text", outcome: "matched", deviceReading: expect.objectContaining({ barcodes: [] }) }));
    const trace = (record.mock.calls[0] as unknown as [{ trace: { modelsTried: unknown[] } }])[0].trace;
    expect(trace.modelsTried).toEqual([]);
  });

  it("answers from a known barcode first", async () => {
    const { scan, scanWineLabel, repo } = setup({ [EAN]: { wineId: "w-alamos", vintage: null } });
    const response = await scan({ deviceReading: reading([["???", 0.1, 0.3]], [EAN]) }).expect(200);
    expect(scanWineLabel).not.toHaveBeenCalled();
    expect(response.body.catalog.resolvedBy).toBe("barcode");
    expect(repo.findCandidatesByTerms).not.toHaveBeenCalled();
  });

  it("falls back to the AI when nothing is exact, and learns the barcode from its answer", async () => {
    const { scan, scanWineLabel, repo } = setup();
    const response = await scan({ deviceReading: reading([["CATENA ALTA", 0.14], ["Malbec", 0.04]], [EAN]) }).expect(200);
    expect(scanWineLabel).toHaveBeenCalledTimes(1);
    expect(response.body.catalog).toMatchObject({ wineId: "w-ai", resolvedBy: "ai" });
    expect(repo.rememberBarcode).toHaveBeenCalledWith(EAN, "w-ai", "scan_ai", undefined, false);
  });

  it("goes straight to the AI when the user says the wine was wrong, correcting the barcode", async () => {
    const { scan, scanWineLabel, repo } = setup({ [EAN]: { wineId: "w-alamos", vintage: null } });
    await scan({ deviceReading: reading([["ALAMOS", 0.15]], [EAN]), mode: "ai" }).expect(200);
    expect(scanWineLabel).toHaveBeenCalledTimes(1);
    expect(repo.findWineByBarcode).not.toHaveBeenCalled();
    expect(repo.rememberBarcode).toHaveBeenCalledWith(EAN, "w-ai", "scan_ai", undefined, true);
  });

  it("works as before for app versions that send no reading", async () => {
    const { scan, scanWineLabel } = setup();
    await scan({}).expect(200);
    expect(scanWineLabel).toHaveBeenCalledTimes(1);
  });

  it("ignores a barcode linked to another vintage than the one printed", async () => {
    const { scan, scanWineLabel } = setup({ [EAN]: { wineId: "w-2010", vintage: 2010 } });
    // Text match still finds the non-vintage row exactly.
    const withBarcode = alamosReading.replace('"barcodes":[]', `"barcodes":["${EAN}"]`);
    const response = await scan({ deviceReading: withBarcode }).expect(200);
    expect(scanWineLabel).not.toHaveBeenCalled();
    expect(response.body.catalog).toMatchObject({ wineId: "w-alamos", resolvedBy: "text" });
  });
});
