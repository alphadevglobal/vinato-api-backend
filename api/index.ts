import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { OpenRouterWineScanner } from "../src/scanner.service.js";
import { PgWineRepository } from "../src/wines.repository.js";

const app = createApp({
  wineRepository: new PgWineRepository(pool),
  wineScanner: new OpenRouterWineScanner(),
});

export default app;
