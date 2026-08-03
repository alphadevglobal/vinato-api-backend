import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { seedWines } from "../src/seed-data.js";
import type {
  AutocompleteWine,
  PaginatedWines,
  ScanWineLabelResult,
  Wine,
  WineListQuery,
  WineRepository,
  WineScanner,
} from "../src/types.js";

class MemoryWineRepository implements WineRepository {
  constructor(private readonly wines: Wine[]) {}

  async findAll(query: WineListQuery): Promise<PaginatedWines> {
    const filtered = this.wines
      .filter((wine) => matches(wine.country, query.country))
      .filter((wine) => matches(wine.colour, query.colour))
      .filter((wine) => matches(wine.region, query.region))
      .filter((wine) => matches(wine.type, query.type))
      .filter((wine) =>
        query.search
          ? wine.displayName.toLowerCase().includes(query.search.toLowerCase())
          : true,
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    const start = (query.page - 1) * query.limit;
    const data = filtered.slice(start, start + query.limit);

    return {
      data,
      total: filtered.length,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(filtered.length / query.limit),
    };
  }

  async autocomplete(term: string): Promise<AutocompleteWine[]> {
    return this.wines
      .filter((wine) => wine.displayName.toLowerCase().includes(term.toLowerCase()))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 10)
      .map((wine) => ({
        id: wine.id,
        lwin: wine.lwin,
        displayName: wine.displayName,
        country: wine.country,
        colour: wine.colour,
      }));
  }

  async findById(id: string): Promise<Wine | null> {
    return this.wines.find((wine) => wine.id === id) ?? null;
  }

  async findByLwin(lwin: string): Promise<Wine | null> {
    return this.wines.find((wine) => wine.lwin === lwin) ?? null;
  }
}

class StubWineScanner implements WineScanner {
  async scanWineLabel(): Promise<ScanWineLabelResult> {
    return {
      success: true,
      data: {
        displayName: "Chateau Test 2019",
        producerTitle: "Chateau",
        producerName: "Test",
        wine: "Grand Vin",
        country: "France",
        region: "Bordeaux",
        subRegion: "Margaux",
        colour: "Red",
        type: "Still",
        subType: "Dry",
        designation: "AOC",
        classification: "NA",
        vintage: "2019",
        alcoholContent: "13.5%",
        grapes: "Cabernet Sauvignon, Merlot",
        volume: "750ml",
        confidence: 0.91,
        notes: "Imagem de teste.",
      },
    };
  }
}

const app = createApp({
  wineRepository: new MemoryWineRepository(seedWines),
  wineScanner: new StubWineScanner(),
});

describe("Wine API", () => {
  it("responds with the reference root message", async () => {
    const response = await request(app).get("/").expect(200);

    expect(response.text).toBe("Hello World!");
  });

  it("exposes OpenAPI JSON with wine routes", async () => {
    const response = await request(app).get("/api/docs-json").expect(200);

    expect(response.body.info.title).toBe("Wine API");
    expect(response.body.paths).toHaveProperty("/wines");
    expect(response.body.paths).toHaveProperty("/wine-scanner/scan");
  });

  it("redirects Swagger UI to the trailing-slash route", async () => {
    const response = await request(app).get("/api/docs").expect(302);

    expect(response.headers.location).toBe("/api/docs/");
  });

  it("serves Swagger UI static assets", async () => {
    const cssResponse = await request(app).get("/api/docs/swagger-ui.css").expect(200);
    const jsResponse = await request(app)
      .get("/api/docs/swagger-ui-bundle.js")
      .expect(200);

    expect(cssResponse.headers["content-type"]).toContain("text/css");
    expect(cssResponse.text).toContain(".swagger-ui");
    expect(jsResponse.headers["content-type"]).toContain("javascript");
    expect(jsResponse.text).toContain("SwaggerUIBundle");
  });

  it("lists wines with pagination metadata", async () => {
    const response = await request(app).get("/wines?limit=2&page=1").expect(200);

    expect(response.body.data).toHaveLength(2);
    expect(response.body.page).toBe(1);
    expect(response.body.limit).toBe(2);
    expect(response.body.total).toBe(seedWines.length);
    expect(response.body.totalPages).toBe(Math.ceil(seedWines.length / 2));
  });

  it("filters wines case-insensitively", async () => {
    const response = await request(app)
      .get("/wines?country=france&region=Bordeaux&search=Margaux&limit=10")
      .expect(200);

    expect(response.body.total).toBeGreaterThan(0);
    expect(response.body.data.every((wine: Wine) => wine.country === "France")).toBe(true);
    expect(
      response.body.data.every((wine: Wine) => wine.displayName.includes("Margaux")),
    ).toBe(true);
  });

  it("validates pagination like the reference API", async () => {
    const response = await request(app).get("/wines?limit=200").expect(400);

    expect(response.body).toEqual({
      message: ["limit must not be greater than 100"],
      error: "Bad Request",
      statusCode: 400,
    });
  });

  it("autocompletes by display name", async () => {
    const response = await request(app)
      .get("/wines/autocomplete?term=Margaux")
      .expect(200);

    expect(response.body.length).toBeGreaterThan(0);
    expect(Object.keys(response.body[0]).sort()).toEqual(
      ["colour", "country", "displayName", "id", "lwin"].sort(),
    );
  });

  it("finds a wine by LWIN", async () => {
    const response = await request(app).get("/wines/lwin/2685731").expect(200);

    expect(response.body.displayName).toBe("'Avita, Classico Rosso Superiore, Ciro");
  });

  it("rejects invalid UUIDs using the reference message", async () => {
    const response = await request(app).get("/wines/not-a-uuid").expect(400);

    expect(response.body).toEqual({
      message: "Validation failed (uuid is expected)",
      error: "Bad Request",
      statusCode: 400,
    });
  });

  it("rejects scanner calls without an image", async () => {
    const response = await request(app).post("/wine-scanner/scan").expect(400);

    expect(response.body.message).toBe(
      'Nenhum arquivo de imagem foi enviado. Use o campo "image".',
    );
  });

  it("rejects unsupported image mimetypes", async () => {
    const response = await request(app)
      .post("/wine-scanner/scan")
      .attach("image", Buffer.from("plain text"), {
        filename: "label.txt",
        contentType: "text/plain",
      })
      .expect(400);

    expect(response.body.message).toContain("Tipo de arquivo não suportado");
  });

  it("scans supported image uploads", async () => {
    const response = await request(app)
      .post("/wine-scanner/scan")
      .attach("image", Buffer.from("fake-png"), {
        filename: "label.png",
        contentType: "image/png",
      })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.data.displayName).toBe("Chateau Test 2019");
  });
});

function matches(actual: string | null, expected?: string) {
  if (!expected) return true;
  return actual?.toLowerCase() === expected.toLowerCase();
}
