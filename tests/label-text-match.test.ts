import { describe, expect, it } from "vitest";
import type { CatalogCandidate } from "../src/catalog-matcher.js";
import { deviceSearchTerms, exactTextMatch, labelVolume, labelYears, normalizeBarcode, parseDeviceReading, prominentLines, type DeviceReading } from "../src/label-text-match.js";

const now = new Date("2026-09-29T12:00:00Z");
const line = (text: string, height: number, confidence = 1) => ({ text, height, confidence });
const wine = (id: string, displayName: string, extra: Partial<CatalogCandidate> = {}): CatalogCandidate => ({
  id, displayName, wineName: null, producer: null, vintage: null, hasImage: false, places: [], colour: null, ...extra,
});

// Real Apple Vision output for a photo of an Alamos Malbec 2005 (macOS harness, same code as the app).
const alamos: DeviceReading = {
  lines: [line("2005", 0.041), line("ALAMOS", 0.149), line("THE WINES OF CATENA", 0.058), line("MALBEC", 0.038), line("MENDOZA XICENTINA", 0.056, 0.3)],
  barcodes: [],
};
const catalog = [
  wine("alamos-malbec", "Alamos Malbec", { producer: "Catena Zapata", places: ["Mendoza", "Argentina"], colour: "red" }),
  wine("alamos-chardonnay", "Alamos Chardonnay", { producer: "Catena Zapata", places: ["Mendoza", "Argentina"], colour: "white" }),
  wine("alamos-seleccion", "Alamos Selección Malbec", { producer: "Catena Zapata", places: ["Mendoza", "Argentina"] }),
  wine("alamos-malbec-2010", "Alamos Malbec", { producer: "Catena Zapata", vintage: 2010, places: ["Mendoza"] }),
  wine("catena-malbec", "Catena Malbec", { producer: "Catena Zapata", places: ["Mendoza"] }),
];

describe("scan without AI: exact catalog match from the label text", () => {
  it("finds exactly the wine named on the label, with the printed vintage", () => {
    const match = exactTextMatch(alamos, catalog, now);
    expect(match?.candidate.id).toBe("alamos-malbec");
    expect(match?.vintage).toBe(2005);
  });

  it("never answers with a similar wine: another grape, another tier or another line", () => {
    // Only Chardonnay, Selección and Catena Malbec in the catalog: none is this wine.
    expect(exactTextMatch(alamos, catalog.filter((item) => item.id !== "alamos-malbec" && item.id !== "alamos-malbec-2010"), now)).toBeNull();
  });

  it("rejects a catalog wine whose big-print name has a word the row does not ('Catena Alta' is not 'Catena Malbec')", () => {
    const alta: DeviceReading = { lines: [line("CATENA ALTA", 0.14), line("MALBEC", 0.05), line("Catena Zapata", 0.03)], barcodes: [] };
    expect(exactTextMatch(alta, catalog, now)).toBeNull();
    const withAlta = [...catalog, wine("catena-alta", "Catena Alta Malbec", { producer: "Catena Zapata" })];
    expect(exactTextMatch(alta, withAlta, now)?.candidate.id).toBe("catena-alta");
  });

  it("requires every word of the catalog name on the label ('Reserva' missing = another wine)", () => {
    const plain: DeviceReading = { lines: [line("CASA VALDUGA", 0.12), line("ORIGEM", 0.1), line("Cabernet Sauvignon", 0.04)], barcodes: [] };
    const rows = [wine("reserva", "Casa Valduga Origem Reserva Cabernet Sauvignon", { producer: "Casa Valduga" })];
    expect(exactTextMatch(plain, rows, now)).toBeNull();
    const rows2 = [...rows, wine("origem", "Casa Valduga Origem Cabernet Sauvignon", { producer: "Casa Valduga" })];
    expect(exactTextMatch(plain, rows2, now)?.candidate.id).toBe("origem");
  });

  it("does not take a generic row for a varietal label, nor a red for a rosé", () => {
    const merlot: DeviceReading = { lines: [line("MIOLO", 0.12), line("SELEÇÃO", 0.1), line("Merlot", 0.05)], barcodes: [] };
    expect(exactTextMatch(merlot, [wine("selecao", "Miolo Seleção", { producer: "Miolo" })], now)).toBeNull();
    const rose: DeviceReading = { lines: [line("MIOLO", 0.12), line("SELEÇÃO", 0.1), line("Rosé", 0.05)], barcodes: [] };
    expect(exactTextMatch(rose, [wine("selecao-tinto", "Miolo Seleção Tinto", { producer: "Miolo", colour: "red" })], now)).toBeNull();
  });

  it("keeps sweetness and bottle format apart", () => {
    const suave: DeviceReading = { lines: [line("SANTA FELICIDADE", 0.12), line("Tinto Suave", 0.06)], barcodes: [] };
    expect(exactTextMatch(suave, [wine("seco", "Santa Felicidade Tinto Seco")], now)).toBeNull();
    expect(exactTextMatch(suave, [wine("suave", "Santa Felicidade Tinto Suave")], now)?.candidate.id).toBe("suave");
    const magnumRow = [wine("magnum", "Alamos Malbec Magnum", { producer: "Catena Zapata" })];
    expect(exactTextMatch(alamos, magnumRow, now)).toBeNull();
  });

  it("finds the wine whatever the vintage; the vintage is the one printed on the label", () => {
    const rows = [wine("2010", "Alamos Malbec", { producer: "Catena Zapata", vintage: 2010 })];
    // A 2005 label is still the Alamos Malbec catalogued from a 2010 bottle.
    expect(exactTextMatch(alamos, rows, now)).toMatchObject({ candidate: { id: "2010" }, vintage: 2005 });
    const reading2010: DeviceReading = { ...alamos, lines: alamos.lines.map((item) => (item.text === "2005" ? { ...item, text: "2010" } : item)) };
    expect(exactTextMatch(reading2010, [...catalog], now)).toMatchObject({ candidate: { id: "alamos-malbec-2010" }, vintage: 2010 });
  });

  it("gives up when two different wines fit the label", () => {
    const reading: DeviceReading = { lines: [line("DUETTO", 0.12), line("Malbec", 0.05)], barcodes: [] };
    const rows = [wine("a", "Duetto Malbec", { producer: "Bodega Uno" }), wine("b", "Duetto Malbec", { producer: "Cantina Due" })];
    // Neither producer is printed: both rows are rejected.
    expect(exactTextMatch(reading, rows, now)).toBeNull();
    const withProducers: DeviceReading = { lines: [...reading.lines, line("Bodega Uno · Cantina Due", 0.02)], barcodes: [] };
    expect(exactTextMatch(withProducers, rows, now)).toBeNull();
  });

  it("treats the same wine catalogued twice as one, preferring the row with a photo", () => {
    const rows = [
      wine("dup-a", "Alamos Malbec", { producer: "Catena Zapata", places: ["Mendoza"] }),
      wine("dup-b", "Alamos, Malbec, Mendoza", { producer: "Catena Zapata", places: ["Mendoza"], hasImage: true }),
    ];
    expect(exactTextMatch(alamos, rows, now)?.candidate.id).toBe("dup-b");
  });

  it("never guesses a name read with low confidence", () => {
    // Real Vision output for a tiny, blurry Chianti seal: everything is a 0.3 guess.
    const blurry: DeviceReading = { lines: [line("CHIAND", 0.045, 0.3), line("CANTO", 0.119, 0.3), line("0750", 0.059)], barcodes: [] };
    expect(prominentLines(blurry)).toBeNull();
    expect(exactTextMatch(blurry, [wine("canto", "Canto")], now)).toBeNull();
    expect(deviceSearchTerms(blurry)).toEqual([]);
  });

  it("needs full confidence on the name: real 0.5 readings had wrong letters", () => {
    // Real Vision output (Viña Cumbrero Rioja photo): "CUMIBRERO" at 0.5 confidence.
    const cumbrero: DeviceReading = { lines: [line("CUMIBRERO", 0.096, 0.5), line("CUMBRERO", 0.089, 0.5), line("RIOJA", 0.03)], barcodes: [] };
    expect(exactTextMatch(cumbrero, [wine("cumbrero", "Viña Cumbrero Rioja", { places: ["Rioja"] })], now)).toBeNull();
    // Real output for a Château Lafite label: the name is sure, a long blurry line is the tallest.
    const lafite: DeviceReading = { lines: [line("SETE ONLE DU CHATEAU LAFITE ROTNSCHILD", 0.056, 0.3), line("CHATEAU LAFITE ROTHSCHILD", 0.041), line("1999", 0.036), line("PAUILLAC", 0.023)], barcodes: [] };
    expect(exactTextMatch(lafite, [wine("lafite", "Château Lafite Rothschild", { places: ["Pauillac"] })], now)).toBeNull();
  });

  it("builds search terms from the big print and the grapes", () => {
    expect(deviceSearchTerms(alamos)).toEqual(["alamos", "alamos malbec"]);
  });

  it("reads years and volume from trusted lines only", () => {
    expect(labelYears(alamos, now)).toEqual([2005]);
    expect(labelYears({ lines: [line("2031", 0.1), line("1998", 0.1, 0.3)], barcodes: [] }, now)).toEqual([]);
    expect(labelVolume({ lines: [line("750 ml · 13,5% vol", 0.02)], barcodes: [] })).toBe("750 ml");
  });
});

describe("device reading and barcodes", () => {
  it("accepts only valid EAN/UPC codes", () => {
    expect(normalizeBarcode("4620017455554")).toBe("4620017455554"); // real code read by Vision
    expect(normalizeBarcode("4620017455553")).toBeNull(); // wrong check digit
    expect(normalizeBarcode("036000291452")).toBe("0036000291452"); // UPC-A → EAN-13
    expect(normalizeBarcode("96385074")).toBe("96385074"); // EAN-8
    expect(normalizeBarcode("0000000000000")).toBeNull();
    expect(normalizeBarcode("abc")).toBeNull();
  });

  it("parses the phone's reading and drops what is malformed", () => {
    const parsed = parseDeviceReading(JSON.stringify({
      lines: [{ text: " ALAMOS ", confidence: 1, height: 0.15 }, { text: "", confidence: 1, height: 0.1 }, { text: "x", confidence: "a", height: 0.1 }, { text: "big", confidence: 1, height: 3 }],
      barcodes: ["4620017455554", "4620017455554", "123"],
    }));
    expect(parsed).toEqual({ lines: [{ text: "ALAMOS", confidence: 1, height: 0.15 }], barcodes: ["4620017455554"] });
    expect(parseDeviceReading("not json")).toBeNull();
    expect(parseDeviceReading(undefined)).toBeNull();
    expect(parseDeviceReading(JSON.stringify({ lines: [], barcodes: [] }))).toBeNull();
  });
});
