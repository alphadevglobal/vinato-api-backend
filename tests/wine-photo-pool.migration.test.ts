import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");
const dataUrl = (bytes: number, fill: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes, fill).toString("base64")}`;
const addPhoto = (wineId: string, photo: string) => db.query(
  `INSERT INTO wine_photo_candidates (wine_id, image_data_url, source) VALUES ($1, $2, 'scan')
   ON CONFLICT (wine_id, image_md5) DO UPDATE SET times_seen = wine_photo_candidates.times_seen + 1, last_seen_at = now()`,
  [wineId, photo]);
let db: PGlite;

async function wine(images: unknown[] = []) {
  const { rows } = await db.query<{ id: string }>(`insert into catalog_wines (display_name, images) values ('Vinho', $1::jsonb) returning id`, [JSON.stringify(images)]);
  return rows[0].id;
}
const pool = async (wineId: string) => (await db.query<{ image_bytes: number; times_seen: number; source: string }>(
  `select image_bytes::float8 as image_bytes, times_seen, source from wine_photo_candidates where wine_id = $1 order by last_seen_at desc, first_seen_at desc`, [wineId])).rows;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create table catalog_wines (id uuid primary key default gen_random_uuid(), display_name text not null, images jsonb not null default '[]', updated_at timestamptz not null default now());
    create table unlisted_wine_scans (id uuid primary key default gen_random_uuid(), unlisted_code text not null unique, status text not null default 'needs_registration',
      image_data_url text not null, extracted_data jsonb not null default '{}', user_id uuid, registered_wine_id uuid references catalog_wines(id), created_at timestamptz not null default now());`);
  await db.exec(read("014_unlisted_scan_dedup.sql"));
});

describe("migration 015: wine photo pool", () => {
  it("stores a photo once per wine and counts identical photos", async () => {
    await db.exec(read("015_wine_photo_pool.sql"));
    const id = await wine();
    await addPhoto(id, dataUrl(100, 1));
    await addPhoto(id, dataUrl(100, 1));
    expect(await pool(id)).toEqual([{ image_bytes: 100, times_seen: 2, source: "scan" }]);
  });

  it("keeps only the 5 latest photos, plus the main photo however old", async () => {
    await db.exec(read("015_wine_photo_pool.sql"));
    const main = dataUrl(10, 99);
    const id = await wine([{ url: main, source: "user_scan" }]);
    await addPhoto(id, main);
    for (let fill = 1; fill <= 7; fill += 1) { await new Promise((resolve) => setTimeout(resolve, 5)); await addPhoto(id, dataUrl(10 + fill, fill)); }
    const photos = await pool(id);
    expect(photos.map((photo) => photo.image_bytes)).toEqual([17, 16, 15, 14, 13, 10]);
  });

  it("brings the catalog photos and the linked scans into the pool", async () => {
    const stored = dataUrl(50, 1);
    const id = await wine([{ url: stored, source: "user_scan" }, "https://loja/rotulo.jpg"]);
    const scan = dataUrl(60, 2);
    await db.query(`insert into unlisted_wine_scans (unlisted_code, image_data_url, registered_wine_id, status) values ('A', $1, $2, 'registered'), ('B', $1, $2, 'registered')`, [scan, id]);
    await db.query(`update unlisted_wine_scans set resubmissions = 2 where unlisted_code = 'B'`);
    await db.exec(read("015_wine_photo_pool.sql"));
    const photos = await pool(id);
    expect(photos).toHaveLength(2);
    expect(photos.find((photo) => photo.source === "catalog")).toMatchObject({ image_bytes: 50, times_seen: 1 });
    expect(photos.find((photo) => photo.source === "unlisted_scan")).toMatchObject({ image_bytes: 60, times_seen: 4 });
  });

  it("can run again without changing the counts (scripts/migrate.ts reruns every file)", async () => {
    const id = await wine();
    await db.query(`insert into unlisted_wine_scans (unlisted_code, image_data_url, registered_wine_id, status) values ('A', $1, $2, 'registered')`, [dataUrl(60, 2), id]);
    await db.exec(read("015_wine_photo_pool.sql"));
    await db.exec(read("015_wine_photo_pool.sql"));
    expect(await pool(id)).toMatchObject([{ times_seen: 1 }]);
  });

  it("drops the pool with the wine", async () => {
    await db.exec(read("015_wine_photo_pool.sql"));
    const id = await wine();
    await addPhoto(id, dataUrl(10, 1));
    await db.query(`delete from catalog_wines where id = $1`, [id]);
    expect((await db.query(`select * from wine_photo_candidates`)).rows).toEqual([]);
  });
});
