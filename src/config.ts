import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL,
  openRouterApiKey: process.env.OPENROUTER_API_KEY,
  openRouterModel:
    process.env.OPENROUTER_MODEL ?? "google/gemma-4-26b-a4b-it:free",
  sourceApiUrl: process.env.SOURCE_API_URL ?? "https://wine-api-two.vercel.app",
};
