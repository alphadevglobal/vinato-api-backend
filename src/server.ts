import { createApp } from "./app.js";
import { OfferRepository } from "./offers.repository.js";
import { ReviewRepository } from "./reviews.repository.js";
import { SommelierAgent } from "./sommelier.service.js";
import { SommelierWineLists } from "./sommelier-wine-list.js";
import { PgSommelierKnowledge } from "./sommelier-knowledge.js";
import { PgScanAuditRepository } from "./scan-audit.repository.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { OpenRouterWineScanner } from "./scanner.service.js";
import { PgWineRepository } from "./wines.repository.js";
import { AccountRepository } from "./account.repository.js";
import { PgAiModelSettings } from "./ai-model-settings.js";
import { OpenRouterWineListAgent } from "./wine-list.service.js";
import { AdminSessions } from "./admin-session.js";
import { WineListRepository } from "./wine-lists.repository.js";
import { OpenRouterMenuAgent } from "./menu.service.js";
import { MenuRepository } from "./menus.repository.js";

const aiModelSettings = new PgAiModelSettings(pool);

const app = createApp({
  wineRepository: new PgWineRepository(pool),
  wineScanner: new OpenRouterWineScanner(aiModelSettings),
  accountRepository: new AccountRepository(pool),
  scanAudit: new PgScanAuditRepository(pool),
  sommelier: new SommelierAgent(pool, undefined, new SommelierWineLists(pool), new PgSommelierKnowledge(pool)),
  reviews: new ReviewRepository(pool),
  offers: new OfferRepository(pool),
  adminSessions: new AdminSessions(pool),
  wineLists: { agent: new OpenRouterWineListAgent(aiModelSettings), repository: new WineListRepository(pool) },
  menus: { agent: new OpenRouterMenuAgent(aiModelSettings), repository: new MenuRepository(pool) },
});

app.listen(config.port, () => {
  console.log(`Wine API listening on http://localhost:${config.port}`);
  console.log(`Swagger UI available at http://localhost:${config.port}/api/docs`);
});
