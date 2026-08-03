import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

if (!config.databaseUrl && process.env.NODE_ENV !== "test") {
  throw new Error("DATABASE_URL is required");
}

export const pool = new Pool({
  connectionString: config.databaseUrl,
});
