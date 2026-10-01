import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import type pg from "pg";

/**
 * In-memory Postgres with every migration of this repository applied, plus the
 * vinato-web admin "users" table some of them reference.
 */
export async function fullDatabase() {
  const db = new PGlite({ extensions: { citext, pgcrypto, pg_trgm } });
  await db.exec(`create table users (id uuid primary key default gen_random_uuid(), email text, display_name text, avatar_url text, role text not null default 'user', status text not null default 'active')`);
  const directory = join(process.cwd(), "migrations");
  for (const name of readdirSync(directory).filter((file) => file.endsWith(".sql")).sort()) await db.exec(readFileSync(join(directory, name), "utf8"));
  const pool = { query: (sql: string, params?: unknown[]) => db.query(sql, params) } as unknown as pg.Pool;
  return { db, pool };
}
