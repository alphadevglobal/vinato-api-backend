import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(join(process.cwd(), "migrations", name), "utf8");
const dataUrl = (bytes: number, fill: number) => `data:image/jpeg;base64,${Buffer.alloc(bytes, fill).toString("base64")}`;
let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    create table catalog_wines (id uuid primary key default gen_random_uuid(), display_name text not null, images jsonb not null default '[]', updated_at timestamptz not null default now());
    create table unlisted_wine_scans (id uuid primary key default gen_random_uuid(), unlisted_code text not null unique, status text not null default 'needs_registration',
      image_data_url text not null, extracted_data jsonb not null default '{}', user_id uuid, registered_wine_id uuid references catalog_wines(id), created_at timestamptz not null default now());
    create table scan_audit_logs (id uuid primary key default gen_random_uuid(), outcome text not null
      constraint scan_audit_logs_outcome_check check (outcome in ('matched', 'needs_registration', 'recognition_failed', 'catalog_failed')));`);
  for (const name of ["014_unlisted_scan_dedup.sql", "015_wine_photo_pool.sql", "016_ai_wine_curation.sql"]) await db.exec(read(name));
});

async function wine(images: unknown[] = []) {
  const { rows } = await db.query<{ id: string }>(`insert into catalog_wines (display_name, images) values ('Vinho', $1::jsonb) returning id`, [JSON.stringify(images)]);
  return rows[0].id;
}

describe("migration 016: AI-assisted catalog", () => {
  it("marks existing wines as approved catalog wines", async () => {
    const id = await wine();
    const { rows } = await db.query(`select data_source, curation_status from catalog_wines where id = $1`, [id]);
    expect(rows).toEqual([{ data_source: "catalog", curation_status: "approved" }]);
  });

  it("only accepts known origins and curation states", async () => {
    await expect(db.query(`insert into catalog_wines (display_name, data_source) values ('X', 'robot')`)).rejects.toThrow(/data_source_check/);
    await expect(db.query(`insert into catalog_wines (display_name, curation_status) values ('X', 'maybe')`)).rejects.toThrow(/curation_status_check/);
  });

  it("keeps a single pending proposal per wine and kind", async () => {
    const id = await wine();
    await db.query(`insert into wine_ai_proposals (wine_id, kind, proposed) values ($1, 'update', '{"region":"A"}')`, [id]);
    await expect(db.query(`insert into wine_ai_proposals (wine_id, kind) values ($1, 'update')`, [id])).rejects.toThrow(/wine_ai_proposals_pending_idx/);
    await db.query(`update wine_ai_proposals set status = 'applied' where wine_id = $1`, [id]);
    await expect(db.query(`insert into wine_ai_proposals (wine_id, kind) values ($1, 'update')`, [id])).resolves.toBeDefined();
  });

  it("merges a new proposal into the pending one, as the API does", async () => {
    const id = await wine();
    const upsert = (proposed: object) => db.query(
      `INSERT INTO wine_ai_proposals (wine_id, kind, proposed, current_values) VALUES ($1, 'update', $2::jsonb, '{}')
       ON CONFLICT (wine_id, kind) WHERE status = 'pending' DO UPDATE SET
         proposed = wine_ai_proposals.proposed || EXCLUDED.proposed, times_proposed = wine_ai_proposals.times_proposed + 1`,
      [id, JSON.stringify(proposed)]);
    await upsert({ region: "A", country: "Chile" });
    await upsert({ region: "B" });
    const { rows } = await db.query(`select proposed, times_proposed from wine_ai_proposals where wine_id = $1`, [id]);
    expect(rows).toEqual([{ proposed: { region: "B", country: "Chile" }, times_proposed: 2 }]);
  });

  it("protects both the front and the back label from the photo pool trim", async () => {
    const front = dataUrl(10, 90);
    const back = dataUrl(10, 91);
    const id = await wine([{ url: front, role: "front" }, { url: back, role: "back" }]);
    const add = (photo: string, day: number) => db.query(
      `insert into wine_photo_candidates (wine_id, image_data_url, source, first_seen_at, last_seen_at) values ($1, $2, 'scan', $3, $3)`,
      [id, photo, `2026-09-${String(day).padStart(2, "0")}`]);
    await add(front, 1);
    await add(back, 2);
    for (let day = 3; day <= 10; day += 1) await add(dataUrl(20 + day, day), day);
    const { rows } = await db.query<{ image_data_url: string }>(`select image_data_url from wine_photo_candidates where wine_id = $1`, [id]);
    expect(rows).toHaveLength(7);
    expect(rows.map((row) => row.image_data_url)).toEqual(expect.arrayContaining([front, back]));
  });

  it("accepts the ai_created scan outcome", async () => {
    await expect(db.query(`insert into scan_audit_logs (outcome) values ('ai_created')`)).resolves.toBeDefined();
    await expect(db.query(`insert into scan_audit_logs (outcome) values ('other')`)).rejects.toThrow(/outcome_check/);
  });

  it("can run again (scripts/migrate.ts reruns every file)", async () => {
    await expect(db.exec(read("016_ai_wine_curation.sql"))).resolves.toBeDefined();
  });
});
