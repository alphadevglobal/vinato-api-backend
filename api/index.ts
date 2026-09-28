import { createApp } from "../src/app.js";
import { SommelierAgent } from "../src/sommelier.service.js";
import { pool } from "../src/db.js";
import { OpenRouterWineScanner } from "../src/scanner.service.js";
import { PgWineRepository } from "../src/wines.repository.js";
import { AccountRepository } from "../src/account.repository.js";
import { PgScanAuditRepository } from "../src/scan-audit.repository.js";

const app = createApp({
  wineRepository: new PgWineRepository(pool),
  wineScanner: new OpenRouterWineScanner(),
  accountRepository: new AccountRepository(pool),
  scanAudit: new PgScanAuditRepository(pool),
  sommelier: new SommelierAgent(pool),
});

export default app;
