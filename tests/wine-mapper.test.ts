import { describe, expect, it } from "vitest";
import { mapWineRow } from "../src/wine-mapper.js";
import type { WineRow } from "../src/types.js";

const row = (overrides: Partial<WineRow> = {}): WineRow => ({
  id: "w1", lwin: "catalog-w1", status: "active", display_name: "Vinho", producer_title: null, producer_name: null, wine: null,
  country: null, region: null, sub_region: null, site: null, parcel: null, colour: null, type: null, sub_type: null, designation: null,
  classification: null, vintage_config: null, first_vintage: null, final_vintage: null, date_added: null, date_updated: null,
  reference: null, source: "catalog_wines", source_id: "w1", vintage_year: null, alcohol: null, price_usd: null, rating: null,
  grapes: null, image_path: null, image_url: null, source_url: null, review_count: 0, awards_count: 0, latest_award_year: null,
  award_symbol: null, created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z", ...overrides,
});

describe("mapWineRow curation fields", () => {
  it("exposes the origin, the curation status, the back label and the pairings", () => {
    expect(mapWineRow(row({ data_source: "ai_scan", curation_status: "pending", back_image_url: "data:image/jpeg;base64,AA==", pairings: ["Pizza", ""] })))
      .toMatchObject({ dataSource: "ai_scan", curationStatus: "pending", backImageUrl: "data:image/jpeg;base64,AA==", pairings: ["Pizza"] });
  });

  it("treats rows without the new columns as approved catalog wines", () => {
    expect(mapWineRow(row())).toMatchObject({ dataSource: "catalog", curationStatus: "approved", backImageUrl: null, pairings: [] });
  });
});
