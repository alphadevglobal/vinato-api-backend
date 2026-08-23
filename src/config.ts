import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  openRouterModel:
    process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-nano-12b-v2-vl:free",
  openRouterFallbackModel:
    process.env.OPENROUTER_FALLBACK_MODEL ?? "openrouter/free",
  sourceApiUrl: process.env.SOURCE_API_URL ?? "https://wine-api-two.vercel.app",
};
