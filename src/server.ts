import { createApp } from "./app.js";
import { OfferRepository } from "./offers.repository.js";
import { ReviewRepository } from "./reviews.repository.js";
import { SommelierAgent } from "./sommelier.service.js";
import { PgScanAuditRepository } from "./scan-audit.repository.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { OpenRouterWineScanner } from "./scanner.service.js";
import { PgWineRepository } from "./wines.repository.js";
import { AccountRepository } from "./account.repository.js";

const app = createApp({
  wineRepository: new PgWineRepository(pool),
  wineScanner: new OpenRouterWineScanner(),
  accountRepository: new AccountRepository(pool),
  scanAudit: new PgScanAuditRepository(pool),
  sommelier: new SommelierAgent(pool),
  reviews: new ReviewRepository(pool),
  offers: new OfferRepository(pool),
});

app.listen(config.port, () => {
  console.log(`Wine API listening on http://localhost:${config.port}`);
  console.log(`Swagger UI available at http://localhost:${config.port}/api/docs`);
});
