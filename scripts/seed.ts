import { pool } from "../src/db.js";
import { seedWines } from "../src/seed-data.js";
import { upsertWines } from "../src/wine-upsert.js";

try {
  await upsertWines(pool, seedWines);
  console.log(`Seeded ${seedWines.length} wines.`);
} finally {
  await pool.end();
}
