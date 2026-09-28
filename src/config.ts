import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  // Dedicated key for the Sommelier chat (separate billing/limits from the label scanner).
  sommelierApiKey: process.env.SOMMELIER_OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
  openRouterModel:
    process.env.OPENROUTER_MODEL ?? "google/gemini-3.1-flash-lite",
  openRouterFallbackModel:
    process.env.OPENROUTER_FALLBACK_MODEL ?? "google/gemini-3.8-flash",
  sourceApiUrl: process.env.SOURCE_API_URL ?? "https://wine-api-two.vercel.app",
};
