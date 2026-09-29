import { describe, expect, it } from "vitest";
import { alcoholPercent, canCreateWine, catalogColour, proposedUpdates, readingToCatalogFields } from "../src/wine-curation.js";
import type { ScannedWineData } from "../src/types.js";

const reading = (overrides: Partial<ScannedWineData> = {}): ScannedWineData => ({
  displayName: "Quinta do Morgado York Madeira", producerTitle: null, producerName: "Fante", wine: "York Madeira",
  country: "Brasil", region: "Serra Gaúcha", subRegion: null, colour: "tinto", type: "Suave", subType: null,
  designation: null, classification: null, vintage: null, alcoholContent: "10% vol", grapes: "Bordô, Isabel",
  volume: "750ml", description: "Vinho de mesa suave, frutado.", foodPairings: ["Massas", "Pizza"], confidence: 0.9, notes: "",
  ...overrides,
});

describe("catalogColour", () => {
  it.each([["tinto", "Red"], ["Rosé", "Rose"], ["branco", "White"], ["Espumante", "Sparkling"], ["red", "Red"], ["laranja", "Amber"]])(
    "maps %s to %s", (input, expected) => expect(catalogColour(input)).toBe(expected));

  it("capitalizes unknown styles and ignores empty values", () => {
    expect(catalogColour("licoroso")).toBe("Licoroso");
    expect(catalogColour(null)).toBeUndefined();
    expect(catalogColour("  ")).toBeUndefined();
  });
});

describe("alcoholPercent", () => {
  it.each([["13,5% vol", 13.5], ["12%", 12], ["Alc. 14.5 % by vol", 14.5], ["0.0%", 0]])("reads %s", (input, expected) => {
    expect(alcoholPercent(input)).toBe(expected);
  });

  it("ignores missing or impossible values", () => {
    expect(alcoholPercent(null)).toBeUndefined();
    expect(alcoholPercent("sem teor")).toBeUndefined();
    expect(alcoholPercent("750")).toBeUndefined();
  });
});

describe("readingToCatalogFields", () => {
  it("turns an AI reading into catalog fields", () => {
    expect(readingToCatalogFields(reading({ vintage: "2021" }))).toEqual({
      displayName: "Quinta do Morgado York Madeira", wineName: "York Madeira", producer: "Fante", country: "Brasil",
      region: "Serra Gaúcha", colour: "Red", wineType: "Suave", vintage: 2021, alcoholPercent: 10,
      grapes: ["Bordô", "Isabel"], description: "Vinho de mesa suave, frutado.", pairings: ["Massas", "Pizza"],
    });
  });

  it("builds the name from producer and wine when the AI gave no display name", () => {
    expect(readingToCatalogFields(reading({ displayName: null, producerName: null, producerTitle: "Casa Perini", wine: "Vintage" })))
      .toMatchObject({ displayName: "Casa Perini Vintage", wineName: "Vintage", producer: "Casa Perini" });
  });

  it("uses the display name as wine name and drops empty fields", () => {
    const fields = readingToCatalogFields(reading({ wine: null, region: " ", grapes: null, foodPairings: null, description: null }));
    expect(fields.wineName).toBe("Quinta do Morgado York Madeira");
    expect(fields).not.toHaveProperty("region");
    expect(fields).not.toHaveProperty("grapes");
    expect(fields).not.toHaveProperty("pairings");
  });

  it("knows when a reading names no wine", () => {
    expect(canCreateWine(readingToCatalogFields(reading()))).toBe(true);
    expect(canCreateWine(readingToCatalogFields(reading({ displayName: null, producerName: null, wine: null })))).toBe(false);
  });
});

describe("proposedUpdates", () => {
  const proposed = readingToCatalogFields(reading({ vintage: "2021" }));

  it("proposes to fill empty fields and change different ones", () => {
    const current = { displayName: "Quinta do Morgado York", wineName: "York", producer: "Fante", country: "Brazil", region: "Serra Gaúcha" };
    expect(proposedUpdates(current, proposed)).toEqual({
      country: "Brasil", colour: "Red", wineType: "Suave", alcoholPercent: 10, grapes: ["Bordô", "Isabel"],
      description: "Vinho de mesa suave, frutado.", pairings: ["Massas", "Pizza"],
    });
  });

  it("never proposes to rename or re-date the wine", () => {
    const changes = proposedUpdates({ displayName: "Outro nome", wineName: "Outro", vintage: 2019 }, proposed);
    expect(changes).not.toHaveProperty("displayName");
    expect(changes).not.toHaveProperty("wineName");
    expect(changes).not.toHaveProperty("vintage");
  });

  it("ignores differences of case, accents and list order", () => {
    const current = {
      producer: "FANTE", country: "brasil", region: "Serra Gaucha", colour: "red", wineType: "suave", alcoholPercent: 10,
      grapes: ["Isabel", "Bordo"], description: "Vinho de mesa suave, frutado", pairings: ["Pizza", "Massas"],
    };
    expect(proposedUpdates(current, proposed)).toEqual({});
  });
});
