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
    expect(JSON.parse(callsWith(poolQuery, "INSERT INTO unlisted_wine_scans")[0][1][1]).catalogCandidates).toHaveLength(1);
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
