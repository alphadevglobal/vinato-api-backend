import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { PgWineRepository } from "../src/wines.repository.js";

describe("scan image enrichment", () => {
  it("stores the user's scan when the matched catalog wine has no image", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "wine-id", images: [], score: "0.91" }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const repository = new PgWineRepository({ query } as unknown as pg.Pool);
    const file = { mimetype: "image/jpeg", buffer: Buffer.from("user-photo") } as Express.Multer.File;

    const result = await repository.reconcileScan({
      displayName: "Almaviva 2017", producerTitle: "Almaviva", producerName: "Almaviva",
      wine: "Almaviva", country: "Chile", region: "Puente Alto", subRegion: null,
      colour: "Red", type: "Wine", subType: null, designation: null, classification: null,
      vintage: "2017", alcoholContent: null, grapes: null, volume: null, confidence: 0.95, notes: "",
    }, file);

    expect(result).toEqual({ status: "matched", wineId: "wine-id", imageAdded: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toEqual(["wine-id", "data:image/jpeg;base64,dXNlci1waG90bw=="]);
  });
});
