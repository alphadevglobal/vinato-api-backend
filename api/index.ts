import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { OpenRouterWineScanner } from "../src/scanner.service.js";
import { PgWineRepository } from "../src/wines.repository.js";
import { AccountRepository } from "../src/account.repository.js";

const app = createApp({
  wineRepository: new PgWineRepository(pool),
  wineScanner: new OpenRouterWineScanner(),
  accountRepository: new AccountRepository(pool),
});

export default app;
