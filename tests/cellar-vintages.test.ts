import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AccountRepository } from "../src/account.repository.js";
import { PgSommelierKnowledge } from "../src/sommelier-knowledge.js";
import { fullDatabase } from "./helpers/full-db.js";

async function setup(plan = "premium") {
  const { db, pool } = await fullDatabase();
  const window = [{ from: 1, to: 3, note: "Fruta fresca" }, { from: 4, to: 8, note: "Notas terrosas" }];
  const wine = (await db.query<{ id: string }>(`insert into catalog_wines (display_name, drinking_window) values ('Ciro', $1::jsonb) returning id`, [JSON.stringify(window)])).rows[0].id;
  const user = (await db.query<{ id: string }>(`insert into app_users (email, display_name, password_hash, plan) values ('c@v.t', 'Cia', 'x', $1) returning id`, [plan])).rows[0].id;
  const accounts = new AccountRepository(pool);
  accounts.getUser = async () => ({ id: user, email: "c@v.t", displayName: "Cia", role: "user", plan, planExpiresAt: null, status: "active", avatarUrl: null }) as never;
  const app = createApp({ wineRepository: {} as never, wineScanner: {} as never, accountRepository: accounts });
  return { db, pool, wine, user, accounts, app };
}

describe("cellar vintages", () => {
  it("keeps the vintages of a wine, with the wine's janela de uso", async () => {
    const { wine, app } = await setup();
    const saved = await request(app).put(`/me/cellar/${wine}/vintages`).set("Authorization", "Bearer t")
      .send({ vintages: [{ vintage: 2016, quantity: 2 }, { vintage: 2020 }] }).expect(200);
    expect(saved.body).toEqual({ wineId: wine, quantity: 3, vintages: [{ vintage: 2020, quantity: 1 }, { vintage: 2016, quantity: 2 }] });

    await request(app).put(`/me/cellar/${wine}/vintages`).set("Authorization", "Bearer t").send({ vintages: [{ vintage: 2020, quantity: 4 }] }).expect(200);
    const cellar = await request(app).get("/me/cellar").set("Authorization", "Bearer t").expect(200);
    expect(cellar.body[0].quantity).toBe(4);
    expect(cellar.body[0].vintages).toEqual([{ vintage: 2020, quantity: 4 }]);
    expect(cellar.body[0].wine.drinkingWindow).toEqual([{ from: 1, to: 3, note: "Fruta fresca" }, { from: 4, to: 8, note: "Notas terrosas" }]);
  });

  it("adds the vintage read on the label with the wine, and removes the vintages with the wine", async () => {
    const { wine, app, db } = await setup();
    await request(app).put(`/me/cellar/${wine}`).set("Authorization", "Bearer t").send({ quantity: 1, vintage: 2016 }).expect(200);
    await request(app).put(`/me/cellar/${wine}`).set("Authorization", "Bearer t").send({ quantity: 2, vintage: 2016 }).expect(200);
    const cellar = await request(app).get("/me/cellar").set("Authorization", "Bearer t").expect(200);
    expect(cellar.body[0].vintages).toEqual([{ vintage: 2016, quantity: 1 }]);
    await request(app).delete(`/me/cellar/${wine}`).set("Authorization", "Bearer t").expect(204);
    expect((await db.query(`select * from user_cellar_vintages`)).rows).toEqual([]);
  });

  it("refuses invalid vintages and non-Premium members", async () => {
    const { wine, app } = await setup();
    for (const vintages of [[{ vintage: 16 }], [{ vintage: 2016 }, { vintage: 2016 }], [{ vintage: 2016, quantity: 0 }], "2016"]) {
      await request(app).put(`/me/cellar/${wine}/vintages`).set("Authorization", "Bearer t").send({ vintages }).expect(400);
    }
    await request(app).put(`/me/cellar/${wine}`).set("Authorization", "Bearer t").send({ quantity: 1, vintage: 99 }).expect(400);
    const free = await setup("free");
    await request(free.app).put(`/me/cellar/${free.wine}/vintages`).set("Authorization", "Bearer t").send({ vintages: [] }).expect(403);
  });

  it("tells the Sommelier the vintages the member has", async () => {
    const { wine, user, accounts, pool } = await setup();
    await accounts.setCellarVintages(user, wine, [{ vintage: 2016, quantity: 2 }, { vintage: 2020, quantity: 1 }]);
    const context = await new PgSommelierKnowledge(pool).forUser(user, "O que tenho na adega?");
    expect(context).toContain("Ciro | safras que ele tem (garrafas): 2016 (2), 2020 (1)");
  });
});
