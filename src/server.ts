import { createApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db.js";
import { OpenRouterWineScanner } from "./scanner.service.js";
import { PgWineRepository } from "./wines.repository.js";

const app = createApp({
  wineRepository: new PgWineRepository(pool),
  wineScanner: new OpenRouterWineScanner(),
});

app.listen(config.port, () => {
  console.log(`Wine API listening on http://localhost:${config.port}`);
  console.log(`Swagger UI available at http://localhost:${config.port}/api/docs`);
});
