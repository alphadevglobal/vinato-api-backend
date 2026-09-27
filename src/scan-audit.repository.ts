import type pg from "pg";
import type { ScannedWineData } from "./types.js";

export type ModelAttempt = { model: string; ok: boolean; ms: number; status?: number; error?: string };

/** Filled in by the scanner and the catalog matcher while a scan runs. */
export type ScanTrace = {
  modelsTried: ModelAttempt[];
  modelUsed?: string;
  recognitionMs?: number;
  catalogQueried: boolean;
  catalogCandidates?: number;
  catalogMs?: number;
};

export const newScanTrace = (): ScanTrace => ({ modelsTried: [], catalogQueried: false });

export type ScanAuditEntry = {
  userId?: string | null;
  success: boolean;
  outcome: "matched" | "needs_registration" | "recognition_failed" | "catalog_failed";
  errorStage?: "recognition" | "catalog";
  errorMessage?: string;
  file: Express.Multer.File;
  trace: ScanTrace;
  reading?: ScannedWineData;
  catalogWineId?: string;
  matchScore?: number;
  unlistedCode?: string;
  imageAdded?: boolean;
  durationMs: number;
  platform?: string;
  appVersion?: string;
};

export type ScanAuditLog = { record(entry: ScanAuditEntry): Promise<void> };

export class PgScanAuditRepository implements ScanAuditLog {
  constructor(private readonly pool: pg.Pool) {}

  async record(entry: ScanAuditEntry) {
    const { trace, file } = entry;
    await this.pool.query(
      `INSERT INTO scan_audit_logs (
         user_id, success, outcome, error_stage, error_message, image_data_url, image_mime, image_bytes,
         model_used, models_tried, reading, confidence, catalog_queried, catalog_candidates, catalog_wine_id,
         match_score, unlisted_code, image_added, duration_ms, recognition_ms, catalog_ms, platform, app_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
      [
        entry.userId ?? null, entry.success, entry.outcome, entry.errorStage ?? null, entry.errorMessage?.slice(0, 1000) ?? null,
        `data:${file.mimetype};base64,${file.buffer.toString("base64")}`, file.mimetype, file.size ?? file.buffer.length,
        trace.modelUsed ?? null, JSON.stringify(trace.modelsTried), entry.reading ? JSON.stringify(entry.reading) : null,
        entry.reading?.confidence ?? null, trace.catalogQueried, trace.catalogCandidates ?? null, entry.catalogWineId ?? null,
        entry.matchScore ?? null, entry.unlistedCode ?? null, entry.imageAdded ?? null, Math.round(entry.durationMs),
        trace.recognitionMs ?? null, trace.catalogMs ?? null, entry.platform?.slice(0, 40) ?? null, entry.appVersion?.slice(0, 40) ?? null,
      ],
    );
  }
}
