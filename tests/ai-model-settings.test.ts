import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { PgAiModelSettings } from "../src/ai-model-settings.js";

describe("PgAiModelSettings", () => {
  it("returns the scanner models saved by the admin panel", async () => {
    const query = vi.fn(async () => ({ rows: [{ model: "vision/model-a", fallbackModel: "vision/model-b" }] }));
    const settings = new PgAiModelSettings({ query } as unknown as pg.Pool);

    await expect(settings.getScannerModels()).resolves.toEqual({
      model: "vision/model-a",
      fallbackModel: "vision/model-b",
    });
  });

  it("uses environment defaults while migration 013 is not installed", async () => {
    const missingTable = Object.assign(new Error("missing relation"), { code: "42P01" });
    const settings = new PgAiModelSettings({ query: vi.fn(async () => { throw missingTable; }) } as unknown as pg.Pool);

    await expect(settings.getScannerModels()).resolves.toMatchObject({
      model: expect.any(String),
      fallbackModel: expect.any(String),
    });
  });

  it("does not hide unexpected database failures", async () => {
    const settings = new PgAiModelSettings({ query: vi.fn(async () => { throw new Error("connection lost"); }) } as unknown as pg.Pool);
    await expect(settings.getScannerModels()).rejects.toThrow("connection lost");
  });
});
