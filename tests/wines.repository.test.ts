import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { PgWineRepository } from "../src/wines.repository.js";
import type { ScannedWineData } from "../src/types.js";

const almaviva: ScannedWineData = {
  displayName: "Almaviva 2017", producerTitle: "Almaviva", producerName: "Almaviva",
  wine: "Almaviva", country: "Chile", region: "Puente Alto", subRegion: null,
  colour: "Red", type: "Wine", subType: null, designation: null, classification: null,
  vintage: "2017", alcoholContent: null, grapes: null, volume: null, confidence: 0.95, notes: "",
};

function repositoryWith(candidates: object[], identicalScan?: object) {
  const clientQuery = vi.fn(async (sql: string) => (sql.includes("FROM catalog_wines") ? { rows: candidates } : { rows: [] }));
  const client = { query: clientQuery, release: vi.fn() };
  const poolQuery = vi.fn(async (sql: string) =>
    sql.includes("WHERE image_md5 = $1") ? { rows: identicalScan ? [identicalScan] : [] }
      : sql.includes("INSERT INTO unlisted_wine_scans") ? { rows: [{ unlisted_code: "VINATO-UNLISTED-TEST" }] } : { rows: [], rowCount: 1 });
  const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as pg.Pool;
  return { repository: new PgWineRepository(pool), clientQuery, poolQuery };
}

const file = { mimetype: "image/jpeg", buffer: Buffer.from("user-photo") } as Express.Multer.File;
// md5("data:image/jpeg;base64,dXNlci1waG90bw=="), what Postgres stores in image_md5.
const fileHash = "3438d7b12f04c5b09c29c54a3d366153";
const callsWith = (query: ReturnType<typeof vi.fn>, text: string) => query.mock.calls.filter(([sql]) => String(sql).includes(text));

describe("scan image enrichment", () => {
  it("stores the user's scan when the matched catalog wine has no image", async () => {
    const { repository, clientQuery, poolQuery } = repositoryWith([
      { id: "wine-id", display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2017, has_image: false },
    ]);

    const result = await repository.reconcileScan(almaviva, file);

    expect(result).toMatchObject({ status: "matched", wineId: "wine-id", imageAdded: true });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("word_similarity_threshold"))).toBe(true);
    const [attach] = callsWith(poolQuery, "UPDATE catalog_wines SET images");
    expect(attach[1]).toEqual(["wine-id", "data:image/jpeg;base64,dXNlci1waG90bw=="]);
    // Untyped parameters inside jsonb_build_object are rejected by Postgres (42P18).
    expect(attach[0]).toContain("'url', $2::text");
  });

  it("still returns the match when storing the scan photo fails", async () => {
    const { repository, poolQuery } = repositoryWith([
      { id: "wine-id", display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2017, has_image: false },
    ]);
    poolQuery.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(Object.assign(new Error("could not determine data type of parameter $2"), { code: "42P18" }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await repository.reconcileScan(almaviva, file);
    errorLog.mockRestore();

    expect(result).toMatchObject({ status: "matched", wineId: "wine-id", imageAdded: false });
  });

  it("queues the label with catalog alternatives when nothing matches and the reading names no wine", async () => {
    const { repository, poolQuery } = repositoryWith([
      { id: "other", display_name: "Almaviva 2019", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2019, has_image: true },
    ]);

    const result = await repository.reconcileScan({ ...almaviva, displayName: null, producerName: null, producerTitle: null, wine: null, region: "Puente Alto" }, file);

    expect(result).toMatchObject({ status: "needs_registration", code: "VINATO-UNLISTED-TEST" });
    expect(callsWith(poolQuery, "INSERT INTO catalog_wines")).toHaveLength(0);
    expect(callsWith(poolQuery, "INSERT INTO unlisted_wine_scans")).toHaveLength(1);
  });
});

describe("identical scan photos", () => {
  it("looks the photo up by the same md5 Postgres keeps in image_md5", async () => {
    const { repository, poolQuery } = repositoryWith([]);
    await repository.reconcileScan(almaviva, file);
    expect(callsWith(poolQuery, "WHERE image_md5 = $1")[0][1]).toEqual([fileHash]);
  });

  it("answers with the wine the admin linked to this exact photo, without searching the catalog", async () => {
    const { repository, clientQuery, poolQuery } = repositoryWith([], { unlisted_code: "VINATO-UNLISTED-OLD", status: "registered", registered_wine_id: "linked-wine" });

    const result = await repository.reconcileScan(almaviva, file);

    expect(result).toMatchObject({ status: "matched", wineId: "linked-wine" });
    expect(clientQuery).not.toHaveBeenCalled();
    expect(callsWith(poolQuery, "resubmissions = resubmissions + 1")[0][1]).toEqual(["VINATO-UNLISTED-OLD"]);
    expect(callsWith(poolQuery, "INSERT INTO unlisted_wine_scans")).toHaveLength(0);
  });

  it("reuses the queued scan instead of storing the same photo again", async () => {
    const { repository, poolQuery } = repositoryWith([], { unlisted_code: "VINATO-UNLISTED-OLD", status: "needs_registration", registered_wine_id: null });

    const result = await repository.reconcileScan(almaviva, file);

    expect(result).toEqual({ status: "needs_registration", code: "VINATO-UNLISTED-OLD", alternatives: [] });
    expect(callsWith(poolQuery, "INSERT INTO unlisted_wine_scans")).toHaveLength(0);
    expect(callsWith(poolQuery, "resubmissions = resubmissions + 1")).toHaveLength(1);
  });

  it("still prefers a catalog match over a queued identical photo", async () => {
    const { repository, poolQuery } = repositoryWith(
      [{ id: "wine-id", display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2017, has_image: true }],
      { unlisted_code: "VINATO-UNLISTED-OLD", status: "needs_registration", registered_wine_id: null },
    );

    const result = await repository.reconcileScan(almaviva, file);

    expect(result).toMatchObject({ status: "matched", wineId: "wine-id", imageAdded: false });
    expect(callsWith(poolQuery, "resubmissions")).toHaveLength(0);
  });
});

describe("wine photo pool", () => {
  const matchedCandidate = { id: "wine-id", display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2017, has_image: true };

  it("offers every matched scan photo to the wine's pool, counting identical photos", async () => {
    const { repository, poolQuery } = repositoryWith([matchedCandidate]);
    await repository.reconcileScan(almaviva, file, "user-1");
    const [insert] = callsWith(poolQuery, "INSERT INTO wine_photo_candidates");
    expect(insert[1]).toEqual(["wine-id", "data:image/jpeg;base64,dXNlci1waG90bw==", "user-1"]);
    expect(insert[0]).toContain("ON CONFLICT (wine_id, image_md5) DO UPDATE");
    expect(insert[0]).toContain("times_seen = wine_photo_candidates.times_seen + 1");
  });

  it("adds the photo after attaching it as the main photo of a wine without one", async () => {
    const { repository, poolQuery } = repositoryWith([{ ...matchedCandidate, has_image: false }]);
    await repository.reconcileScan(almaviva, file);
    const statements = poolQuery.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes("UPDATE catalog_wines SET images"))).toBeLessThan(statements.findIndex((sql) => sql.includes("INSERT INTO wine_photo_candidates")));
  });

  it("offers the photo to the wine the admin linked to an identical scan", async () => {
    const { repository, poolQuery } = repositoryWith([], { unlisted_code: "VINATO-UNLISTED-OLD", status: "registered", registered_wine_id: "linked-wine" });
    await repository.reconcileScan(almaviva, file);
    expect(callsWith(poolQuery, "INSERT INTO wine_photo_candidates")[0][1][0]).toBe("linked-wine");
  });

  it("does not add photos of unmatched labels to any pool", async () => {
    const { repository, poolQuery } = repositoryWith([]);
    await repository.reconcileScan(almaviva, file);
    expect(callsWith(poolQuery, "wine_photo_candidates")).toHaveLength(0);
  });

  it("keeps the match when the pool cannot be written", async () => {
    const { repository, poolQuery } = repositoryWith([matchedCandidate]);
    poolQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("wine_photo_candidates")) throw Object.assign(new Error('relation "wine_photo_candidates" does not exist'), { code: "42P01" });
      return { rows: [], rowCount: 1 };
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await repository.reconcileScan(almaviva, file);
    errorLog.mockRestore();
    expect(result).toMatchObject({ status: "matched", wineId: "wine-id" });
  });
});

describe("AI-assisted catalog", () => {
  type Handler = (sql: string, params: unknown[]) => { rows: object[]; rowCount?: number } | undefined;
  function repositoryFor(options: { candidates?: object[]; existingByName?: object[]; catalogRow?: object; failInsert?: boolean; identical?: object } = {}) {
    const clientQuery = vi.fn(async (sql: string) => (sql.includes("FROM catalog_wines") ? { rows: options.candidates ?? [] } : { rows: [] }));
    const handlers: Handler[] = [
      (sql) => sql.includes("WHERE image_md5 = $1") ? { rows: options.identical ? [options.identical] : [] } : undefined,
      (sql) => sql.includes("lower(btrim(display_name)) = lower(btrim($1))") ? { rows: options.existingByName ?? [] } : undefined,
      (sql) => {
        if (!sql.includes("INSERT INTO catalog_wines")) return undefined;
        if (options.failInsert) throw new Error("insert failed");
        return { rows: [{ id: "ai-wine" }] };
      },
      (sql) => sql.includes("SELECT display_name, wine_name") ? { rows: options.catalogRow ? [options.catalogRow] : [] } : undefined,
      (sql) => sql.includes("INSERT INTO unlisted_wine_scans") ? { rows: [{ unlisted_code: "VINATO-UNLISTED-TEST" }] } : undefined,
    ];
    const poolQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
      for (const handler of handlers) { const result = handler(String(sql), params); if (result) return result; }
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as pg.Pool;
    return { repository: new PgWineRepository(pool), poolQuery };
  }
  const morgado: ScannedWineData = {
    displayName: "Quinta do Morgado York Madeira", producerTitle: null, producerName: "Fante", wine: "York Madeira",
    country: "Brasil", region: null, subRegion: null, colour: "tinto", type: "Suave", subType: null, designation: null,
    classification: null, vintage: null, alcoholContent: "10%", grapes: "Bordô, Isabel", volume: null,
    description: "Vinho de mesa suave.", foodPairings: ["Pizza"], confidence: 0.9, notes: "",
  };
  const catalogRow = {
    display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", country: "Chile", region: null,
    sub_region: null, color: "Red", wine_type: null, designation: null, classification: null, vintage: 2017, alcohol_percent: null,
    grapes: [{ name: "Cabernet Sauvignon", percentage: 70 }], description: null, pairings: { dishes: [], ingredients: [] },
    data_source: "catalog", curation_status: "approved",
  };
  const matchedAlmaviva = { id: "wine-id", display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2017, has_image: true };

  it("creates the wine from the AI reading when the catalog has no match, with the scan photo as front label", async () => {
    const { repository, poolQuery } = repositoryFor({ candidates: [] });
    const trace = { modelsTried: [], catalogQueried: false, modelUsed: "~deepseek/deepseek-flash-latest" };

    const result = await repository.reconcileScan(morgado, file, "user-1", trace);

    expect(result).toEqual({ status: "matched", wineId: "ai-wine", imageAdded: true, created: true, alternatives: [] });
    const [insert] = callsWith(poolQuery, "INSERT INTO catalog_wines");
    expect(insert[0]).toContain("'ai_scan', 'pending'");
    expect(insert[0]).toContain("'role', 'front'");
    expect(insert[1]).toEqual([
      "Quinta do Morgado York Madeira", "York Madeira", "Fante", "Brasil", null, null, "Red", "Suave", null, null, null, 10,
      JSON.stringify([{ name: "Bordô", percentage: null }, { name: "Isabel", percentage: null }]), "Vinho de mesa suave.",
      JSON.stringify({ dishes: ["Pizza"], ingredients: [] }), "data:image/jpeg;base64,dXNlci1waG90bw==", null,
    ]);
    const [proposal] = callsWith(poolQuery, "INSERT INTO wine_ai_proposals");
    expect(proposal[0]).toContain("'new_wine'");
    expect(proposal[1][0]).toBe("ai-wine");
    expect(JSON.parse(proposal[1][1] as string)).toMatchObject({ displayName: "Quinta do Morgado York Madeira", producer: "Fante", colour: "Red" });
    expect(proposal[1].slice(4)).toEqual(["~deepseek/deepseek-flash-latest", 0.9, "user-1"]);
    expect(callsWith(poolQuery, "INSERT INTO wine_photo_candidates")[0][1][0]).toBe("ai-wine");
    expect(callsWith(poolQuery, "INSERT INTO unlisted_wine_scans")).toHaveLength(0);
  });

  it("reuses a wine with the same name and vintage instead of creating a duplicate", async () => {
    const { repository, poolQuery } = repositoryFor({ existingByName: [{ id: "existing" }], catalogRow: { ...catalogRow, display_name: morgado.displayName, data_source: "ai_scan", curation_status: "pending" } });

    const result = await repository.reconcileScan(morgado, file);

    expect(result).toMatchObject({ status: "matched", wineId: "existing", created: false });
    expect(callsWith(poolQuery, "INSERT INTO catalog_wines")).toHaveLength(0);
    // The wine still awaits curation: the new scan only counts on its proposal.
    expect(callsWith(poolQuery, "times_proposed = times_proposed + 1")[0][1]).toEqual(["existing"]);
  });

  it("falls back to the review queue when the wine cannot be created", async () => {
    const { repository } = repositoryFor({ failInsert: true });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await repository.reconcileScan(morgado, file);
    errorLog.mockRestore();
    expect(result).toMatchObject({ status: "needs_registration", code: "VINATO-UNLISTED-TEST" });
  });

  it("fills the empty catalog fields at once and proposes the ones that would change a value", async () => {
    const { repository, poolQuery } = repositoryFor({ candidates: [matchedAlmaviva], catalogRow });

    await repository.reconcileScan({ ...almaviva, alcoholContent: "14,5%", grapes: "Cabernet Sauvignon, Carmenère", description: "Tinto chileno encorpado." }, file, "user-1");

    const [fill] = callsWith(poolQuery, "UPDATE catalog_wines SET").filter(([sql]) => !String(sql).includes("images"));
    expect(fill[0]).toContain("region = $2");
    expect(fill[0]).toContain("description = ");
    expect(fill[1]).toEqual(["wine-id", "Puente Alto", "Wine", 14.5, "Tinto chileno encorpado."]);
    const [applied, pending] = callsWith(poolQuery, "INSERT INTO wine_ai_proposals");
    expect(applied[0]).toContain("'applied'");
    expect(JSON.parse(applied[1][1] as string)).toEqual({ region: "Puente Alto", wineType: "Wine", alcoholPercent: 14.5, description: "Tinto chileno encorpado." });
    expect(JSON.parse(applied[1][7] as string)).toMatchObject({ auto: true });
    // The catalog already names a grape: replacing it waits for the curators.
    expect(pending[0]).toContain("ON CONFLICT (wine_id, kind) WHERE status = 'pending' DO UPDATE");
    expect(JSON.parse(pending[1][1] as string)).toEqual({ grapes: ["Cabernet Sauvignon", "Carmenère"] });
  });

  it("gives a catalog wine without producer the producer read on the label ('Vinho Cobos Felino Malbec')", async () => {
    const felino = { id: "felino", display_name: "Vinho Cobos Felino Malbec", wine_name: "Cobos Felino Malbec", producer_manufacturer: null, vintage: null, has_image: true };
    const { repository, poolQuery } = repositoryFor({ candidates: [felino], catalogRow: { ...catalogRow, display_name: "Vinho Cobos Felino Malbec", wine_name: "Cobos Felino Malbec", producer_manufacturer: null, country: "Argentina", color: "Red", vintage: null, grapes: [{ name: "Malbec" }] } });
    const result = await repository.reconcileScan({ ...almaviva, displayName: "Viña Cobos FELINO", producerName: "Viña Cobos", producerTitle: null, wine: "FELINO", grapes: "Malbec", country: "Argentina", region: "Mendoza", vintage: "2023", description: "Malbec de Mendoza, frutado e macio." }, file);
    expect(result).toMatchObject({ status: "matched", wineId: "felino" });
    const [fill] = callsWith(poolQuery, "UPDATE catalog_wines SET").filter(([sql]) => !String(sql).includes("images"));
    expect(fill[0]).toContain("producer_manufacturer = $2");
    expect(fill[1]).toContain("Viña Cobos");
    expect(fill[1]).toContain("Mendoza");
  });

  it("only proposes (never writes) after a match that is strong but not very strong", async () => {
    const { repository, poolQuery } = repositoryFor({ candidates: [matchedAlmaviva], catalogRow });
    await (repository as unknown as { proposeCatalogUpdate: (id: string, data: ScannedWineData, trace?: unknown, userId?: string, autoFill?: boolean) => Promise<void> })
      .proposeCatalogUpdate("wine-id", { ...almaviva, description: "Tinto chileno." }, undefined, undefined, false);
    expect(callsWith(poolQuery, "UPDATE catalog_wines SET")).toHaveLength(0);
    expect(callsWith(poolQuery, "INSERT INTO wine_ai_proposals")[0][0]).toContain("ON CONFLICT");
  });

  it("records no proposal when the AI agrees with the catalog", async () => {
    const { repository, poolQuery } = repositoryFor({ candidates: [matchedAlmaviva], catalogRow: { ...catalogRow, region: "Puente Alto", wine_type: "Wine" } });
    await repository.reconcileScan({ ...almaviva, grapes: "Cabernet Sauvignon" }, file);
    expect(callsWith(poolQuery, "INSERT INTO wine_ai_proposals")).toHaveLength(0);
  });

  it("keeps the match when the proposal cannot be written", async () => {
    const { repository, poolQuery } = repositoryFor({ candidates: [matchedAlmaviva], catalogRow });
    const original = poolQuery.getMockImplementation()!;
    poolQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (String(sql).includes("wine_ai_proposals")) throw new Error("relation does not exist");
      return original(sql, params);
    });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await repository.reconcileScan(almaviva, file);
    errorLog.mockRestore();
    expect(result).toMatchObject({ status: "matched", wineId: "wine-id" });
  });

  it("proposes updates for the wine linked to an identical photo too", async () => {
    const { repository, poolQuery } = repositoryFor({ identical: { unlisted_code: "OLD", status: "registered", registered_wine_id: "linked" }, catalogRow });
    await repository.reconcileScan({ ...almaviva, description: "Novo texto." }, file);
    expect(callsWith(poolQuery, "INSERT INTO wine_ai_proposals")[0][1][0]).toBe("linked");
  });

  it("leaves wines rejected by the curators out of the scan candidates", async () => {
    const clientCalls: string[] = [];
    const client = { query: vi.fn(async (sql: string) => { clientCalls.push(String(sql)); return { rows: [] }; }), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as unknown as pg.Pool;
    await new PgWineRepository(pool).findScanCandidates(almaviva);
    expect(clientCalls.find((sql) => sql.includes("FROM catalog_wines"))).toContain("curation_status <> 'rejected'");
  });
});

describe("merged duplicates", () => {
  it("opens the wine a duplicate was merged into", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const pool = { query } as unknown as pg.Pool;
    await new PgWineRepository(pool).findById("duplicate-id");
    expect(query.mock.calls[0][0]).toContain("WHERE id = COALESCE((SELECT merged_into FROM catalog_wines WHERE id = $1), $1)");
    expect(query.mock.calls[0][1]).toEqual(["duplicate-id"]);
  });
});

describe("scan safeguards (29/09 review)", () => {
  it("maps a merged duplicate found by its old name to the wine that replaced it", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.includes("FROM catalog_wines")
      ? { rows: [{ id: "dup", merged_into: "target", display_name: "Almadén Suave", wine_name: "Suave", producer_manufacturer: "Almadén", vintage: null, region: null, sub_region: null, country: "Brazil", color: "White", has_image: true }] }
      : { rows: [] }), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query: vi.fn() } as unknown as pg.Pool;
    const [candidate] = await new PgWineRepository(pool).findScanCandidates({ ...almaviva, displayName: "Almadén Suave", producerName: "Almadén", wine: "Suave" });
    expect(candidate).toMatchObject({ id: "target", displayName: "Almadén Suave", colour: "White" });
    expect(String(client.query.mock.calls.find(([sql]) => String(sql).includes("FROM catalog_wines"))?.[0])).toContain("curation_status <> 'rejected' OR merged_into IS NOT NULL");
  });

  it("does not create a wine from a reading too thin to name it (e.g. 'La Flor')", async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    const poolQuery = vi.fn(async (sql: string) => sql.includes("INSERT INTO unlisted_wine_scans") ? { rows: [{ unlisted_code: "VINATO-UNLISTED-TEST" }] } : { rows: [], rowCount: 0 });
    const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as pg.Pool;
    const result = await new PgWineRepository(pool).reconcileScan({ ...almaviva, displayName: "La Flor", producerName: null, producerTitle: null, wine: "La Flor", region: null, country: null }, file);
    expect(result).toMatchObject({ status: "needs_registration" });
    expect(poolQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO catalog_wines"))).toBe(false);
  });

  it("proposes facts only from strong matches", async () => {
    // A real borderline match (0.757): the right wine, but not sure enough to write facts on it.
    const borderline = { id: "bellezza", display_name: "La Grande Bellezza Madame Gi Trebiano Toscano", wine_name: null, producer_manufacturer: null, vintage: null, has_image: true, region: null, sub_region: null, country: null, color: null };
    const client = { query: vi.fn(async (sql: string) => (sql.includes("FROM catalog_wines") ? { rows: [borderline] } : { rows: [] })), release: vi.fn() };
    const poolQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as pg.Pool;
    const fixture = (JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/matcher-cases.json"), "utf8")) as { label: string; reading: object }[])
      .find((item) => item.label === "LA GRANDE BELLEZZA TREBBIANO TOSCANO")!;
    const result = await new PgWineRepository(pool).reconcileScan({ confidence: 0.9, notes: "", ...fixture.reading } as ScannedWineData, file);
    expect(result).toMatchObject({ status: "matched", wineId: "bellezza" });
    expect((result as { matchScore: number }).matchScore).toBeLessThan(0.85);
    expect(poolQuery.mock.calls.some(([sql]) => String(sql).includes("wine_ai_proposals"))).toBe(false);
  });
});
