import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(join(process.cwd(), "migrations/014_unlisted_scan_dedup.sql"), "utf8");
let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  // unlisted_wine_scans as created by migration 006 (foreign keys left out).
  await db.exec(`create table unlisted_wine_scans (
    id uuid primary key default gen_random_uuid(), unlisted_code text not null unique,
    status text not null default 'needs_registration', image_data_url text not null, extracted_data jsonb not null default '{}'::jsonb,
    user_id uuid, registered_wine_id uuid, admin_notes text, created_at timestamptz not null default now(), reviewed_at timestamptz)`);
});

describe("migration 014: identical unlisted scan photos", () => {
  it("keeps image_md5 equal to the md5 the API computes for the data URL", async () => {
    await db.exec(migration);
    const photo = `data:image/jpeg;base64,${Buffer.from("user-photo").toString("base64")}`;
    await db.query(`insert into unlisted_wine_scans (unlisted_code, image_data_url) values ('A', $1)`, [photo]);
    const { rows } = await db.query<{ image_md5: string; resubmissions: number; last_submitted_at: string | null }>(`select image_md5, resubmissions, last_submitted_at from unlisted_wine_scans`);
    expect(rows).toEqual([{ image_md5: createHash("md5").update(photo).digest("hex"), resubmissions: 0, last_submitted_at: null }]);
  });

  it("serves the API lookup from the image_md5 index", async () => {
    await db.exec(migration);
    const { rows } = await db.query<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = 'unlisted_wine_scans_image_md5_idx'`);
    expect(rows[0].indexdef).toContain("(image_md5, created_at DESC)");
  });

  it("can run again, as scripts/migrate.ts reapplies every migration", async () => {
    await db.exec(migration);
    await expect(db.exec(migration)).resolves.toBeDefined();
  });

  it("supports the counter update the API runs on a repeated photo", async () => {
    await db.exec(migration);
    await db.query(`insert into unlisted_wine_scans (unlisted_code, image_data_url) values ('A', 'data:image/jpeg;base64,AA==')`);
    await db.query(`UPDATE unlisted_wine_scans SET resubmissions = resubmissions + 1, last_submitted_at = now() WHERE unlisted_code = $1`, ["A"]);
    const { rows } = await db.query<{ resubmissions: number; last_submitted_at: string | null }>(`select resubmissions, last_submitted_at from unlisted_wine_scans`);
    expect(rows[0].resubmissions).toBe(1);
    expect(rows[0].last_submitted_at).not.toBeNull();
  });
});
