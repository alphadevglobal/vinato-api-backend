import type pg from "pg";
import { config } from "./config.js";

export type ScannerModelSettings = { model: string; fallbackModel: string };
export type ScannerModelSettingsProvider = { getScannerModels(): Promise<ScannerModelSettings> };

export const defaultScannerModels = (): ScannerModelSettings => ({
  model: config.openRouterModel,
  fallbackModel: config.openRouterFallbackModel,
});

export class PgAiModelSettings implements ScannerModelSettingsProvider {
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
}
