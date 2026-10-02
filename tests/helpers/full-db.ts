import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type pg from "pg";

/**
 * In-memory Postgres with every migration of this repository applied, plus the
 * vinato-web admin "users" table some of them reference, and the production
 * catalog_awarded_wines view (created outside the migrations).
 */
export async function fullDatabase() {
  const db = new PGlite({ extensions: { citext, pgcrypto, pg_trgm } });
  await db.exec(`create table users (id uuid primary key default gen_random_uuid(), email text, display_name text, avatar_url text, role text not null default 'user', status text not null default 'active')`);
  const directory = join(process.cwd(), "migrations");
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) await db.exec(readFileSync(join(directory, name), "utf8"));
  await db.exec(`alter table catalog_wines add column if not exists awards jsonb not null default '[]'::jsonb;
    create or replace view catalog_awarded_wines as select c.id, c.awards, jsonb_array_length(c.awards) as awards_count,
      (select max((a.value ->> 'award_year')::integer) from jsonb_array_elements(c.awards) a(value)) as latest_award_year,
      coalesce((c.awards -> 0) ->> 'badge_symbol', '🎖️') as award_symbol
    from catalog_wines c where c.awards <> '[]'::jsonb`);
  const pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as pg.Pool;
  return { db, pool };
}
