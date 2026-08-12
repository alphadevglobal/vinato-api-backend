import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pool } from "../src/db.js";

try {
  const directory = join(process.cwd(), "migrations");
  const migrations = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const sql = await readFile(join(directory, migration), "utf8");
    await pool.query(sql);
    console.log(`Applied ${migration}`);
  }
} finally {
  await pool.end();
}
