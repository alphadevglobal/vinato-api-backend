import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../src/db.js";

const migrationPath = join(process.cwd(), "migrations", "001_create_wines.sql");
const sql = await readFile(migrationPath, "utf8");

try {
  await pool.query(sql);
  console.log("Migrations applied.");
} finally {
  await pool.end();
}
