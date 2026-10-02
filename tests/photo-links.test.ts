import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AccountRepository } from "../src/account.repository.js";
import { PgWineRepository } from "../src/wines.repository.js";
import { fullDatabase } from "./helpers/full-db.js";

const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(3000, 7).toString("base64")}`;

describe("label photos as links", () => {
  it("lists, details, explores and fills the cellar with links, and serves the photo with a long cache", async () => {
    const { db, pool } = await fullDatabase();
    const wine = (await db.query<{ id: string }>(`insert into catalog_wines (display_name, country, region, images) values ('Almaviva', 'Chile', 'Puente Alto', $1::jsonb) returning id`,
      [JSON.stringify([{ url: PHOTO, role: "front" }, { url: "https://loja.com/verso.jpg", role: "back" }])])).rows[0].id;
    const repository = new PgWineRepository(pool);

    const detail = await repository.findById(wine);
    expect(detail?.imageUrl).toMatch(new RegExp(`/wines/${wine}/photo\\?i=0&v=[0-9a-f]{12}$`));
    expect(detail?.backImageUrl).toBe("https://loja.com/verso.jpg");
    const region = (await repository.explore()).regions.find((item) => item.name === "Puente Alto");
    expect(region?.imageUrl).toBe(detail?.imageUrl);
    expect(JSON.stringify(await repository.explore())).not.toContain("data:image");

    const user = (await db.query<{ id: string }>(`insert into app_users (email, display_name, password_hash) values ('a@v.t', 'Ana', 'x') returning id`)).rows[0].id;
    await db.query(`insert into user_cellars (user_id, wine_id, quantity) values ($1, $2, 1)`, [user, wine]);
    const cellar = await new AccountRepository(pool).getCellar(user);
    expect(cellar[0].wine.imageUrl).toBe(detail?.imageUrl);

    const app = createApp({ wineRepository: repository, wineScanner: {} as never });
    const photo = await request(app).get(`/wines/${wine}/photo?i=0&v=x`).expect(200);
    expect(photo.headers["content-type"]).toBe("image/jpeg");
    expect(photo.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(photo.body.length).toBe(3000);
    await request(app).get(`/wines/${wine}/photo?i=1`).expect(302).expect("Location", "https://loja.com/verso.jpg");
    await request(app).get(`/wines/${wine}/photo?i=5`).expect(404);
    await request(app).get(`/wines/not-a-uuid/photo`).expect(404);
  });
});

describe("awards in the wine detail", () => {
  it("lists where, when and what for, newest first", async () => {
    const { db, pool } = await fullDatabase();
    const awards = [
      { result: "Gold Medal", title: null, event_name: "Royal Sydney Wine Show", country: "Australia", award_year: 2017, wine_vintage: 2015, badge_symbol: "🏅", source_url: "https://x.au/a.pdf" },
      { result: "Trophy", title: "Best Sweet White", event_name: "Royal Queensland Wine Show", country: "Australia", award_year: 2019, wine_vintage: 2015, badge_symbol: "🏆" },
      { note: "empty" },
    ];
    const wine = (await db.query<{ id: string }>(`insert into catalog_wines (display_name, awards) values ('Noble', $1::jsonb) returning id`, [JSON.stringify(awards)])).rows[0].id;
    const detail = await new PgWineRepository(pool).findById(wine);
    expect(detail?.awardsCount).toBe(3);
    expect(detail?.awards).toEqual([
      { result: "Trophy", title: "Best Sweet White", event: "Royal Queensland Wine Show", country: "Australia", year: 2019, vintage: 2015, symbol: "🏆", sourceUrl: null },
      { result: "Gold Medal", title: null, event: "Royal Sydney Wine Show", country: "Australia", year: 2017, vintage: 2015, symbol: "🏅", sourceUrl: "https://x.au/a.pdf" },
    ]);
  });
});

describe("scan history photos", () => {
  it("gives each entry the catalog photo link", async () => {
    const { db, pool } = await fullDatabase();
    const wine = (await db.query<{ id: string }>(`insert into catalog_wines (display_name, images) values ('Ciro', $1::jsonb) returning id`, [JSON.stringify([{ url: PHOTO }])])).rows[0].id;
    const user = (await db.query<{ id: string }>(`insert into app_users (email, display_name, password_hash) values ('h@v.t', 'Hel', 'x') returning id`)).rows[0].id;
    const accounts = new AccountRepository(pool);
    await accounts.addHistory(user, { wineId: wine, status: "success", imageUri: "file:///tmp/camera.jpg" });
    await accounts.addHistory(user, { status: "error", imageUri: "file:///tmp/other.jpg" });
    const history = await accounts.getHistory(user);
    expect(history.map((entry) => entry.wineImageUrl)).toEqual([null, expect.stringMatching(new RegExp(`/wines/${wine}/photo\\?i=0&v=`))]);
  });
});
