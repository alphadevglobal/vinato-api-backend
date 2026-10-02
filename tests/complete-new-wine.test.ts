import { describe, expect, it } from "vitest";
import { PgWineRepository } from "../src/wines.repository.js";
import { fullDatabase } from "./helpers/full-db.js";

describe("completeNewWine", () => {
  it("fills only the empty sheet fields of the new wine and its Novos Vinhos proposal", async () => {
    const { db, pool } = await fullDatabase();
    const wine = (await db.query<{ id: string }>(`insert into catalog_wines (display_name, aging_potential, pairings, data_source, curation_status) values ('Miolo Seleção', 'Até 2030', '{"dishes":[],"ingredients":[]}', 'ai_scan', 'pending') returning id`)).rows[0].id;
    await db.query(`insert into wine_ai_proposals (wine_id, kind, proposed) values ($1, 'new_wine', '{"displayName":"Miolo Seleção","agingPotential":"Até 2030"}')`, [wine]);
    await new PgWineRepository(pool).completeNewWine(wine, {
      description: "Tinto frutado.", foodPairings: ["Massas", "Pizza"], agingPotential: "3 a 5 anos",
      drinkingWindow: [{ from: 1, to: 3, note: "frutado" }, { from: 4, to: 6, plus: true, note: "terroso" }],
    });
    const row = (await db.query(`select description, pairings, aging_potential, drinking_window from catalog_wines where id = $1`, [wine])).rows[0];
    expect(row).toEqual({ description: "Tinto frutado.", pairings: { dishes: ["Massas", "Pizza"], ingredients: [] }, aging_potential: "Até 2030",
      drinking_window: [{ from: 1, to: 3, note: "frutado" }, { from: 4, to: 6, plus: true, note: "terroso" }] });
    const proposal = (await db.query<{ proposed: Record<string, unknown> }>(`select proposed from wine_ai_proposals where wine_id = $1`, [wine])).rows[0].proposed;
    expect(proposal).toEqual({ displayName: "Miolo Seleção", agingPotential: "Até 2030", description: "Tinto frutado.", pairings: ["Massas", "Pizza"], drinkingWindow: ["1-3: frutado", "4-6+: terroso"] });
  });
});
