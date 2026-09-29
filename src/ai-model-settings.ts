import type pg from "pg";
import { config } from "./config.js";

export type ScannerModelSettings = { model: string; fallbackModel: string };
export type ScannerModelSettingsProvider = { getScannerModels(): Promise<ScannerModelSettings> };
export type WineListModelSettingsProvider = { getWineListModels(): Promise<ScannerModelSettings> };

// Wine lists need a vision model that also reads PDFs and writes long answers.
export const defaultWineListModels = (): ScannerModelSettings => ({
  model: "google/gemini-3.8-flash",
  fallbackModel: "google/gemini-3.1-flash-lite",
});

export const defaultScannerModels = (): ScannerModelSettings => ({
  model: config.openRouterModel,
  fallbackModel: config.openRouterFallbackModel,
});

export class PgAiModelSettings implements ScannerModelSettingsProvider, WineListModelSettingsProvider {
  constructor(private readonly pool: pg.Pool) {}

  async getScannerModels(): Promise<ScannerModelSettings> {
    try {
      const row = (await this.pool.query(
        `SELECT model, fallback_model AS "fallbackModel" FROM scanner_agent_config WHERE id = 1`,
      )).rows[0];
      return row?.model && row?.fallbackModel
        ? { model: row.model, fallbackModel: row.fallbackModel }
        : defaultScannerModels();
    } catch (error) {
      // Keep scans available while migration 013 is being rolled out.
      if ((error as { code?: string }).code === "42P01") return defaultScannerModels();
      throw error;
    }
  }

  /** Model for wine list transcription and bottle checks (vinato-web migration 0013). */
  async getWineListModels(): Promise<ScannerModelSettings> {
    try {
      const row = (await this.pool.query(
        `SELECT model, fallback_model AS "fallbackModel" FROM wine_list_agent_config WHERE id = 1`,
      )).rows[0];
      return row?.model ? { model: row.model, fallbackModel: row.fallbackModel ?? row.model } : defaultWineListModels();
    } catch (error) {
      if ((error as { code?: string }).code === "42P01") return defaultWineListModels();
      throw error;
    }
  }
}
