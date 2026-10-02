import { describe, expect, it } from "vitest";
import { decideMatch, searchTerms, type CatalogCandidate } from "../src/catalog-matcher.js";
import type { ScannedWineData } from "../src/types.js";

// Readings and catalog rows below come from real scans against the Vinato catalog.
function reading(fields: Partial<ScannedWineData>): ScannedWineData {
  return {
    displayName: null, producerTitle: null, producerName: null, wine: null, country: null, region: null, subRegion: null,
    colour: null, type: null, subType: null, designation: null, classification: null, vintage: null, alcoholContent: null,
    grapes: null, volume: null, confidence: 0.95, notes: "", ...fields,
  };
}

function row(id: string, displayName: string, extra: Partial<CatalogCandidate> = {}): CatalogCandidate {
  return { id, displayName, wineName: null, producer: null, vintage: null, hasImage: true, ...extra };
}

describe("catalog matcher", () => {
  it("matches a vintage label to the catalog row without vintage", () => {
    const decision = decideMatch(
      reading({ displayName: "Casa Perini Fração Única Cabernet Sauvignon 2020", producerName: "Casa Perini", wine: "Fração Única", vintage: "2020" }),
      [row("fracao", "Casa Perini Fração Única Cabernet Sauvignon"), row("other", "Casa Perini Arte da Vinícola Cabernet Sauvignon")],
    );
    expect(decision).toMatchObject({ status: "matched", best: { id: "fracao" } });
  });

  it("never matches a red label to the white wine of the same line", () => {
    const decision = decideMatch(
      reading({ displayName: "Cartuxa EA Tinto 2023", producerName: "Cartuxa", wine: "EA", colour: "Tinto", vintage: "2023" }),
      [row("branco", "Cartuxa, EA Branco, Alentejo", { producer: "Cartuxa" }), row("tinto", "Cartuxa, EA Tinto, Alentejo", { producer: "Cartuxa" })],
    );
    expect(decision).toMatchObject({ status: "matched", best: { id: "tinto" } });
  });

  it("keeps Reserva and entry-level wines apart", () => {
    const decision = decideMatch(
      reading({ displayName: "Los Haroldos Reserva Malbec 2023", producerName: "Los Haroldos", wine: "Reserva Malbec", vintage: "2023" }),
      [row("basic", "Los Haroldos Malbec 2020", { vintage: 2020 })],
    );
    expect(decision.status).toBe("no_match");
  });

  it("prefers the standard bottle over a Magnum of the same vintage", () => {
    const decision = decideMatch(
      reading({ displayName: "Miolo Lote 43", producerName: "Miolo", wine: "Lote 43", vintage: "2022", volume: "750ml", colour: "tinto" }),
      [row("magnum", "Miolo Lote 43 2022 Magnum 1,5L", { vintage: 2022 }), row("imperial", "Miolo Lote 43 2023 Imperial 6L", { vintage: 2023 }), row("bottle", "Vinho Miolo Lote 43")],
    );
    expect(decision).toMatchObject({ status: "matched", best: { id: "bottle" } });
  });

  it("matches the same wine whatever the vintage: the vintage only breaks ties", () => {
    const decision = decideMatch(
      reading({ displayName: "3 Autores Grande Reserva 2011", wine: "3 Autores Grande Reserva", vintage: "2011" }),
      [row("2018", "3 Autores Grande Reserva 2018", { vintage: 2018 })],
    );
    expect(decision).toMatchObject({ status: "matched", best: { id: "2018" } });
    // Two rows of the same wine: the one of the printed vintage wins the tie.
    const tie = decideMatch(
      reading({ displayName: "3 Autores Grande Reserva 2011", wine: "3 Autores Grande Reserva", vintage: "2011" }),
      [row("2018", "3 Autores Grande Reserva", { vintage: 2018 }), row("2011", "3 Autores Grande Reserva", { vintage: 2011 })],
    );
    expect(tie).toMatchObject({ status: "matched", best: { id: "2011" } });
  });

  it("treats the same wine catalogued twice as a match, not an ambiguity", () => {
    const decision = decideMatch(
      reading({ displayName: "Norton Reserva Malbec 2021", producerName: "Norton", wine: "Reserva Malbec", vintage: "2021" }),
      [row("a", "Vinho  Bodega Norton Reserva Malbec"), row("b", "Bodega Norton, Reserva Malbec, Mendoza", { hasImage: false })],
    );
    expect(decision).toMatchObject({ status: "matched", best: { id: "a" } });
  });

  it("does not match a different wine that only shares the producer", () => {
    const decision = decideMatch(
      reading({ displayName: "MORANDE Vitis Única CARMENÈRE 2023", producerName: "MORANDE", wine: "Vitis Única", grapes: "CARMENÈRE", vintage: "2023" }),
      [row("carmenere", "Morande, Carmenere, Maipo Valley", { producer: "Morande" })],
    );
    expect(decision.status).toBe("no_match");
  });

  it("reads the Portuguese Bruto / Bruto Natural as Brut / Brut Nature", () => {
    const decision = decideMatch(
      reading({ displayName: "Soalheiro Bruto Natural Alvarinho", producerName: "Soalheiro", wine: "Bruto Natural Alvarinho", type: "Espumante" }),
      [row("nature", "Soalheiro, Brut Nature Alvarinho, Minho", { producer: "Soalheiro" }), row("brut", "Soalheiro, Brut Alvarinho, Minho", { producer: "Soalheiro" })],
    );
    expect(decision).toMatchObject({ status: "matched", best: { id: "nature" } });
  });

  it("ignores company suffixes and duplicate rows that differ only by region", () => {
    const decision = decideMatch(
      reading({ displayName: "Rutini Cabernet - Malbec", producerName: "Rutini Wines", wine: "Cabernet - Malbec", vintage: "2018" }),
      [row("shop", "Vinho Rutini Cabernet / Malbec"), row("lwin", "Rutini, Cabernet Malbec, Mendoza", { producer: "Rutini", hasImage: false, places: ["Mendoza", "Argentina"] })],
    );
    expect(decision).toMatchObject({ status: "matched", best: { id: "shop" } });
  });

  it("does not match another wine of the producer whose name the label does not show", () => {
    const decision = decideMatch(
      reading({ displayName: "Rutini Cabernet Franc Malbec", producerName: "Rutini Wines", wine: "Cabernet Franc Malbec", vintage: "2022" }),
      [row("dominio", "Rutini, Dominio Malbec Cabernet Franc, Uco Valley", { producer: "Rutini", places: ["Uco Valley", "Argentina"] })],
    );
    expect(decision.status).toBe("no_match");
  });

  it("does not match a varietal row when the label names a blend", () => {
    const decision = decideMatch(
      reading({ displayName: "Rutini Cabernet Franc Malbec", producerName: "Rutini Wines", wine: "Cabernet Franc Malbec", region: "Mendoza", vintage: "2022" }),
      [row("varietal", "Rutini, Cabernet Franc, Mendoza", { producer: "Rutini", places: ["Mendoza", "Argentina"] })],
    );
    expect(decision.status).toBe("no_match");
  });

  it("does not match the same wine name from another producer", () => {
    const decision = decideMatch(
      reading({ displayName: "Rutini Cabernet Franc Malbec", producerName: "Rutini Wines", wine: "Cabernet Franc Malbec", region: "Mendoza" }),
      [row("absurdo", "Absurdo, Cabernet Franc Malbec, Mendoza", { producer: "Absurdo", places: ["Mendoza", "Argentina"] })],
    );
    expect(decision.status).toBe("no_match");
  });

  it("searches accented and unaccented spellings, without a producer-only term", () => {
    const terms = searchTerms(reading({ displayName: "Casa Perini Fração Única", producerName: "Casa Perini", wine: "Fração Única" }));
    expect(terms).toContain("perini fracao unica");
    expect(terms).toContain("perini fração única");
    expect(terms).not.toContain("perini");
  });
});
