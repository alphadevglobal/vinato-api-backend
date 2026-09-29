import { createApp } from "../src/app.js";
import { OfferRepository } from "../src/offers.repository.js";
import { ReviewRepository } from "../src/reviews.repository.js";
import { SommelierAgent } from "../src/sommelier.service.js";
import { pool } from "../src/db.js";
import { OpenRouterWineScanner } from "../src/scanner.service.js";
import { PgWineRepository } from "../src/wines.repository.js";
import { AccountRepository } from "../src/account.repository.js";
import { PgAiModelSettings } from "../src/ai-model-settings.js";
import { OpenRouterWineListAgent } from "../src/wine-list.service.js";
import { AdminSessions } from "../src/admin-session.js";
import { WineListRepository } from "../src/wine-lists.repository.js";

const aiModelSettings = new PgAiModelSettings(pool);
import { PgScanAuditRepository } from "../src/scan-audit.repository.js";

const app = createApp({
  wineRepository: new PgWineRepository(pool),
  wineScanner: new OpenRouterWineScanner(aiModelSettings),
  accountRepository: new AccountRepository(pool),
  scanAudit: new PgScanAuditRepository(pool),
  sommelier: new SommelierAgent(pool),
  reviews: new ReviewRepository(pool),
  offers: new OfferRepository(pool),
  adminSessions: new AdminSessions(pool),
  wineLists: { agent: new OpenRouterWineListAgent(aiModelSettings), repository: new WineListRepository(pool) },
});

export default app;
