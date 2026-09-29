import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decideMatch, readingIdentity, scoreCandidate, type CatalogCandidate } from "../src/catalog-matcher.js";
import type { ScannedWineData } from "../src/types.js";

const reading = (fields: Partial<ScannedWineData>): ScannedWineData => ({ confidence: 0.9, notes: "", ...fields });
let sequence = 0;
const wine = (displayName: string, extra: Partial<CatalogCandidate> = {}): CatalogCandidate => {
  sequence += 1;
  return { id: `w${sequence}`, displayName, wineName: null, producer: null, vintage: null, hasImage: false, ...extra };
};
const decided = (data: ScannedWineData, candidates: CatalogCandidate[]) => {
  const decision = decideMatch(data, candidates);
  return decision.status === "matched" ? decision.best.displayName : "no_match";
};

describe("reported wrong associations (29/09)", () => {
  it("does not take 'La Flor' (no producer read) for 'Vinho Flor das Tecedeiras'", () => {
    // The production scan scored 0.83: the only word read ("flor") was in the row,
    // while half of the row ("Tecedeiras") was never on the label.
    expect(decided(reading({ displayName: "La Flor", wine: "La Flor", colour: "tinto" }), [wine("Vinho Flor das Tecedeiras", { colour: "Red", places: ["Portugal"] })])).toBe("no_match");
  });

  it("does not take a white 'Almadén Suave' for 'Almadén Cabernet Suave'", () => {
    // Scored 0.91: "Suave" was treated as a generic word and "Cabernet" never counted.
    expect(decided(reading({ displayName: "ALMADÉN Suave", producerName: "ALMADÉN", wine: "Suave", colour: "branco" }), [
      wine("Almadén Cabernet Suave"), wine("Almadén Riesling", { colour: "White" }), wine("Almadén Tannat", { colour: "Red" }),
    ])).toBe("no_match");
  });

  it("still finds the right wines for complete readings", () => {
    expect(decided(reading({ displayName: "Flor das Tecedeiras", wine: "Flor das Tecedeiras", colour: "tinto" }), [wine("Vinho Flor das Tecedeiras", { colour: "Red" })])).toBe("Vinho Flor das Tecedeiras");
    expect(decided(reading({ displayName: "Almadén Cabernet Suave", producerName: "Almadén", wine: "Cabernet Suave", colour: "tinto" }), [wine("Almadén Cabernet Suave"), wine("Almadén Suave", { colour: "White" })])).toBe("Almadén Cabernet Suave");
  });
});

describe("matching rules", () => {
  it("never accepts a row naming a grape the label does not show", () => {
    const data = reading({ displayName: "Rutini", producerName: "Rutini", colour: "tinto" });
    expect(scoreCandidate(data, wine("Vinho Rutini Syrah"))).toBeLessThan(0.72);
    expect(scoreCandidate(data, wine("Vinho Rutini Cabernet / Malbec"))).toBeLessThan(0.72);
  });

  it("tells sweetness levels apart (Suave, Seco, Demi-Sec, Brut)", () => {
    expect(decided(reading({ displayName: "Almadén Tinto Seco", producerName: "Almadén", wine: "Tinto Seco", colour: "tinto" }), [wine("Almadén Suave", { colour: "White" })])).toBe("no_match");
    expect(decided(reading({ displayName: "Quinta do Morgado Bordô Seco", wine: "Bordô Seco", colour: "tinto" }), [wine("Quinta do Morgado Bordô Suave 1L"), wine("Quinta do Morgado Bordô Seco 1L")])).toBe("Quinta do Morgado Bordô Seco 1L");
    expect(decided(reading({ displayName: "Chandon Demi-Sec", producerName: "Chandon", wine: "Demi-Sec" }), [wine("Chandon Brut Réserve"), wine("Chandon Demi-Sec")])).toBe("Chandon Demi-Sec");
  });

  it("deduces red from a single grape name and uses the catalog colour when the name says nothing", () => {
    const white = reading({ displayName: "Almadén Suave", producerName: "Almadén", wine: "Suave", colour: "branco" });
    expect(scoreCandidate(white, wine("Almadén Merlot Suave"))).toBeLessThan(0.72);
    expect(scoreCandidate(reading({ displayName: "Casa Nova Suave", producerName: "Casa Nova", wine: "Suave", colour: "tinto" }), wine("Casa Nova Suave", { colour: "White" })))
      .toBeLessThan(scoreCandidate(reading({ displayName: "Casa Nova Suave", producerName: "Casa Nova", wine: "Suave", colour: "tinto" }), wine("Casa Nova Suave", { colour: "Red" })));
  });

  it("trusts the name over a wrong catalog colour ('il Rosso' stored as White)", () => {
    expect(decided(reading({ displayName: "'Avita Il Rosso", producerName: "'Avita", wine: "Il Rosso", colour: "tinto", region: "Calabria" }), [wine("'Avita, il Rosso, Calabria", { producer: "'Avita", colour: "White", places: ["Calabria", "Italy"] })]))
      .toBe("'Avita, il Rosso, Calabria");
  });

  it("does not accept a single word read without producer unless the row is fully explained", () => {
    expect(decided(reading({ displayName: "Trifula", wine: "Trifula", colour: "tinto" }), [wine("Cascina Luisin, Dolcetto d'Alba, Trifula", { producer: "Cascina Luisin" })])).toBe("no_match");
    expect(decided(reading({ displayName: "Eterno", wine: "Eterno" }), [wine("Barbanera Eterno Rosso Toscana IGT 2024", { producer: "Barbanera", places: ["Toscana", "Italy"] })])).toBe("no_match");
  });

  it("treats a 'producer' that is really the wine's name as a full reading", () => {
    expect(decided(reading({ displayName: "Quinta de Foz de Arouce Tinto", producerName: "Quinta de Foz de Arouce", wine: "Tinto", colour: "tinto", vintage: "2021" }), [
      wine("Joao Portugal Ramos, Quinta de Foz de Arouce Tinto, Beiras", { producer: "Joao Portugal Ramos", colour: "Red", places: ["Beiras", "Portugal"] }),
      wine("Joao Portugal Ramos, Quinta de Foz de Arouce Branco, Beiras", { producer: "Joao Portugal Ramos", colour: "White", places: ["Beiras", "Portugal"] }),
    ])).toBe("Joao Portugal Ramos, Quinta de Foz de Arouce Tinto, Beiras");
  });

  it("does not take another wine of the line when a name word is missing ('La Flor' vs 'Estate I')", () => {
    expect(decided(reading({ displayName: "Pulenta Estate La Flor Malbec", producerName: "Pulenta Estate", wine: "La Flor Malbec", colour: "tinto" }), [wine("Vinho Pulenta Estate I Malbec", { producer: "Pulenta" })])).toBe("no_match");
  });

  it("does not take another producer's wine when the row has no producer field ('El Enemigo' vs 'Quara')", () => {
    expect(decided(reading({ displayName: "El Enemigo Malbec", producerName: "El Enemigo", wine: "Malbec Single Vineyard", designation: "Single Vineyard", colour: "tinto" }), [
      wine("Vinho Quara Single Vineyard Malbec"), wine("Vinho Fin del Mundo Single Vineyard Malbec"),
    ])).toBe("no_match");
  });

  it("keeps initials as a name and tolerates one-letter spelling variants", () => {
    expect(decided(reading({ displayName: "Catena Zapata D.V. Catena Malbec-Malbec", producerName: "Catena Zapata", wine: "D.V. Catena Malbec-Malbec", colour: "tinto" }), [
      wine("Vinho Catena Zapata Malbec"), wine("Vinho DV Catena Malbec-Malbec"),
    ])).toBe("Vinho DV Catena Malbec-Malbec");
    expect(decided(reading({ displayName: "La Grande Bellezza Trebbiano Toscano", producerName: "La Grande Bellezza", wine: "Trebbiano Toscano", colour: "branco", vintage: "2023" }), [wine("La Grande Bellezza Madame Gi Trebiano Toscano")]))
      .toBe("La Grande Bellezza Madame Gi Trebiano Toscano");
  });

  it("reads both producer fields and ignores company forms and numbering", () => {
    expect(decided(reading({ displayName: "Chateau Bauvallon Bordeaux", producerName: "S.C.A.V.M.", producerTitle: "Chateau Bauvallon", wine: "Bordeaux", colour: "tinto", vintage: "2018", region: "Bordeaux" }), [
      wine("Château Bauvallon Bordeaux 2018", { producer: "Château Bauvallon", vintage: 2018, colour: "Red", places: ["Bordeaux", "France"] }),
    ])).toBe("Château Bauvallon Bordeaux 2018");
    expect(decided(reading({ displayName: "Criadores de Rioja Anciano no. 3", producerName: "Criadores de Rioja S.L.", producerTitle: "PRODUTOR", wine: "Anciano no. 3", colour: "tinto", region: "Rioja" }), [
      wine("Criadores de Rioja Anciano Nº 3", { producer: "Criadores de Rioja", colour: "Red", places: ["Rioja", "Spain"] }),
    ])).toBe("Criadores de Rioja Anciano Nº 3");
  });
});

describe("readingIdentity", () => {
  it("allows creating a wine only from a reading that names it", () => {
    expect(readingIdentity({ displayName: "La Flor", wine: "La Flor" }).sufficient).toBe(false);
    expect(readingIdentity({ displayName: "Rutini", producerName: "Rutini" }).sufficient).toBe(false);
    expect(readingIdentity({ displayName: "Quinta do Morgado York Madeira", producerName: "Fante", wine: "York Madeira" }).sufficient).toBe(true);
    expect(readingIdentity({ displayName: "Conquest Gold", wine: "Conquest Gold" }).sufficient).toBe(true);
  });
});

describe("regression set: 132 real and similar labels against production candidates (29/09)", () => {
  type Case = { label: string; source: string; reading: Partial<ScannedWineData>; expected: string; exact: boolean; candidates: CatalogCandidate[] };
  const cases = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/matcher-cases.json"), "utf8")) as Case[];

  it("covers the reported labels and similar ones", () => {
    expect(cases.filter((item) => item.source === "synthetic").length).toBeGreaterThanOrEqual(17);
    expect(cases.length).toBeGreaterThanOrEqual(130);
  });

  it.each(cases.map((item) => [item.label, item] as const))("%s", (_label, item) => {
    const result = decided(reading(item.reading), item.candidates);
    if (item.expected === "no_match" || item.exact) expect(result).toBe(item.expected);
    else expect(result.toLowerCase()).toContain(item.expected.toLowerCase());
  });
});
