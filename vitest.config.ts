import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Migration tests boot an in-memory Postgres (PGlite): slow when files run in parallel.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
