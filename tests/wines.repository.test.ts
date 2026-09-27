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

function repositoryWith(candidates: object[]) {
  const clientQuery = vi.fn(async (sql: string) => (sql.includes("FROM catalog_wines") ? { rows: candidates } : { rows: [] }));
  const client = { query: clientQuery, release: vi.fn() };
  const poolQuery = vi.fn(async (sql: string) =>
    sql.includes("INSERT INTO unlisted_wine_scans") ? { rows: [{ unlisted_code: "VINATO-UNLISTED-TEST" }] } : { rows: [], rowCount: 1 });
  const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as pg.Pool;
  return { repository: new PgWineRepository(pool), clientQuery, poolQuery };
}

const file = { mimetype: "image/jpeg", buffer: Buffer.from("user-photo") } as Express.Multer.File;

describe("scan image enrichment", () => {
  it("stores the user's scan when the matched catalog wine has no image", async () => {
    const { repository, clientQuery, poolQuery } = repositoryWith([
      { id: "wine-id", display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2017, has_image: false },
    ]);

    const result = await repository.reconcileScan(almaviva, file);

    expect(result).toMatchObject({ status: "matched", wineId: "wine-id", imageAdded: true });
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("word_similarity_threshold"))).toBe(true);
    expect(poolQuery.mock.calls[0][1]).toEqual(["wine-id", "data:image/jpeg;base64,dXNlci1waG90bw=="]);
    // Untyped parameters inside jsonb_build_object are rejected by Postgres (42P18).
    expect(poolQuery.mock.calls[0][0]).toContain("'url', $2::text");
  });

  it("still returns the match when storing the scan photo fails", async () => {
    const { repository, poolQuery } = repositoryWith([
      { id: "wine-id", display_name: "Almaviva 2017", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2017, has_image: false },
    ]);
    poolQuery.mockRejectedValueOnce(Object.assign(new Error("could not determine data type of parameter $2"), { code: "42P18" }));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await repository.reconcileScan(almaviva, file);
    errorLog.mockRestore();

    expect(result).toMatchObject({ status: "matched", wineId: "wine-id", imageAdded: false });
  });

  it("queues the label with catalog alternatives when nothing matches", async () => {
    const { repository, poolQuery } = repositoryWith([
      { id: "other", display_name: "Almaviva 2019", wine_name: "Almaviva", producer_manufacturer: "Almaviva", vintage: 2019, has_image: true },
    ]);

    const result = await repository.reconcileScan(almaviva, file);

    expect(result).toEqual({
      status: "needs_registration",
      code: "VINATO-UNLISTED-TEST",
      alternatives: [{ wineId: "other", displayName: "Almaviva 2019" }],
    });
    expect(JSON.parse(poolQuery.mock.calls[0][1][1]).catalogCandidates).toHaveLength(1);
  });
});
