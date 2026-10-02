import type { ScanTrace } from "./scan-audit.repository.js";
import { decideMatch, readingIdentity, searchTerms, type CatalogCandidate } from "./catalog-matcher.js";
import type {
  AutocompleteWine,
  ExploreCatalog,
  PaginatedWines,
  Wine,
  WineListQuery,
  WineRepository,
  WineRow,
  ScannedWineData,
  ScanWineLabelResult,
} from "./types.js";
import { mapWineRow } from "./wine-mapper.js";
import { canCreateWine, fillAssignments, proposedUpdates, readingToCatalogFields, splitFills, type CatalogFields } from "./wine-curation.js";
import { createHash } from "node:crypto";
import type pg from "pg";

const baseSelect = `
  SELECT
    id,
    COALESCE(scan_code, 'catalog-' || id::text) AS lwin,
    'active'::text AS status,
    display_name,
    NULL::text AS producer_title,
    producer_manufacturer AS producer_name,
    wine_name AS wine,
    country,
    region,
    sub_region,
    NULL::text AS site,
    NULL::text AS parcel,
    color AS colour,
    wine_type AS type,
    NULL::text AS sub_type,
    designation,
    classification,
    NULL::text AS vintage_config,
    vintage::text AS first_vintage,
    vintage::text AS final_vintage,
    created_at::text AS date_added,
    updated_at::text AS date_updated,
    description AS reference,
    'catalog_wines'::text AS source,
    id::text AS source_id,
    vintage AS vintage_year,
    alcohol_percent AS alcohol,
    aging_potential,
    drinking_window,
    NULL::numeric AS price_usd,
    -- "Nota Crítica": average of the users' reviews (1 to 5), from wine_review_stats.
    (SELECT round(stats.rating_sum / NULLIF(stats.review_count, 0), 1) FROM wine_review_stats stats WHERE stats.wine_id = catalog_wines.id) AS rating,
    CASE
      WHEN jsonb_typeof(grapes) = 'array' THEN array_to_string(ARRAY(
        SELECT CASE
          WHEN jsonb_typeof(grape) = 'object' AND NULLIF(grape->>'name', '') IS NOT NULL
            THEN concat(CASE WHEN NULLIF(grape->>'percentage', '') IS NOT NULL THEN (grape->>'percentage') || '% ' ELSE '' END, grape->>'name')
          WHEN jsonb_typeof(grape) = 'string' THEN grape #>> '{}'
        END
        FROM jsonb_array_elements(grapes) grape
      ), ', ')
      WHEN jsonb_typeof(grapes) = 'object' AND NULLIF(grapes->>'name', '') IS NOT NULL
        THEN concat(CASE WHEN NULLIF(grapes->>'percentage', '') IS NOT NULL THEN (grapes->>'percentage') || '% ' ELSE '' END, grapes->>'name')
      ELSE grapes #>> '{}'
    END AS grapes,
    NULL::text AS image_path,
    CASE
      WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 AND jsonb_typeof(images->0) = 'string' THEN images->>0
      WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 THEN COALESCE(images->0->>'url', images->0->>'image_url')
      ELSE NULL
    END AS image_url,
    NULL::text AS source_url,
    data_source,
    curation_status,
    CASE WHEN jsonb_typeof(images) = 'array' AND jsonb_typeof(images->1) = 'object' AND images->1->>'role' = 'back'
      THEN COALESCE(images->1->>'url', images->1->>'image_url') END AS back_image_url,
    CASE WHEN jsonb_typeof(pairings->'dishes') = 'array' THEN ARRAY(
      SELECT CASE WHEN jsonb_typeof(dish) = 'string' THEN dish #>> '{}' ELSE dish->>'name' END
      FROM jsonb_array_elements(pairings->'dishes') dish
    ) ELSE ARRAY[]::text[] END AS pairings,
    COALESCE((SELECT stats.review_count FROM wine_review_stats stats WHERE stats.wine_id = catalog_wines.id), 0)::integer AS review_count,
    COALESCE((SELECT awarded.awards_count FROM catalog_awarded_wines awarded WHERE awarded.id = catalog_wines.id), 0)::integer AS awards_count,
    (SELECT awarded.latest_award_year FROM catalog_awarded_wines awarded WHERE awarded.id = catalog_wines.id) AS latest_award_year,
    (SELECT awarded.award_symbol FROM catalog_awarded_wines awarded WHERE awarded.id = catalog_wines.id) AS award_symbol,
    created_at,
    updated_at
  FROM catalog_wines
`;

// One canonical style per wine, whatever the source spelling ("Rosé"/"Rose",
// "Fortified"/"fortified", colour missing but type present). The explore
// facet and the /wines?colour= filter use the same expression.
const STYLE_SQL = `CASE lower(btrim(COALESCE(NULLIF(btrim(color), ''), NULLIF(btrim(wine_type), ''))))
  WHEN 'red' THEN 'Red' WHEN 'white' THEN 'White' WHEN 'sparkling' THEN 'Sparkling'
  WHEN 'rose' THEN 'Rosé' WHEN 'rosé' THEN 'Rosé' WHEN 'fortified' THEN 'Fortified'
  WHEN 'dessert' THEN 'Dessert' WHEN 'sweet' THEN 'Dessert' WHEN 'amber' THEN 'Amber' WHEN 'orange' THEN 'Amber'
  ELSE initcap(btrim(COALESCE(NULLIF(btrim(color), ''), NULLIF(btrim(wine_type), ''))))
END`;

// Matches at or above this score may propose facts for the catalog wine; at or
// above AUTO_FILL_MATCH the facts missing in the catalog are written at once.
const STRONG_MATCH = 0.85;
const AUTO_FILL_MATCH = 0.9;

const scanImageDataUrl = (file: Express.Multer.File) => `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;

type CatalogFieldsRow = {
  display_name: string; wine_name: string | null; producer_manufacturer: string | null; country: string | null; region: string | null;
  sub_region: string | null; color: string | null; wine_type: string | null; designation: string | null; classification: string | null;
  vintage: number | null; alcohol_percent: string | number | null; grapes: unknown; description: string | null; pairings: unknown;
  aging_potential?: string | null; data_source: string; curation_status: string;
};
const CATALOG_FIELDS_SELECT = `display_name, wine_name, producer_manufacturer, country, region, sub_region, color, wine_type,
  designation, classification, vintage, alcohol_percent, grapes, description, pairings, aging_potential, data_source, curation_status`;

const names = (value: unknown) => (Array.isArray(value) ? value : [])
  .map((item) => typeof item === "string" ? item : typeof item === "object" && item && typeof (item as { name?: unknown }).name === "string" ? (item as { name: string }).name : "")
  .map((item) => item.trim())
  .filter(Boolean);

/** Catalog row → the field names used by wine_ai_proposals. */
export function catalogFieldsFromRow(row: CatalogFieldsRow): CatalogFields {
  const grapes = names(row.grapes);
  const dishes = names((row.pairings as { dishes?: unknown } | null)?.dishes);
  const fields: CatalogFields = {
    displayName: row.display_name, wineName: row.wine_name ?? undefined, producer: row.producer_manufacturer ?? undefined,
    country: row.country ?? undefined, region: row.region ?? undefined, subRegion: row.sub_region ?? undefined,
    colour: row.color ?? undefined, wineType: row.wine_type ?? undefined, designation: row.designation ?? undefined,
    classification: row.classification ?? undefined, vintage: row.vintage ?? undefined,
    alcoholPercent: row.alcohol_percent === null ? undefined : Number(row.alcohol_percent),
    grapes: grapes.length ? grapes : undefined, description: row.description ?? undefined, pairings: dishes.length ? dishes : undefined,
    agingPotential: row.aging_potential ?? undefined,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== "")) as CatalogFields;
}

export class PgWineRepository implements WineRepository {
  private exploreCache?: { value: ExploreCatalog; expiresAt: number };

  constructor(private readonly pool: pg.Pool) {}

  async logUnlistedScan(file: Express.Multer.File, userId?: string, extractedData: Record<string, unknown> = {}) {
    const imageDataUrl = scanImageDataUrl(file);
    const result = await this.pool.query<{ unlisted_code: string }>(
      `INSERT INTO unlisted_wine_scans (unlisted_code, image_data_url, extracted_data, user_id)
       VALUES ('VINATO-UNLISTED-' || to_char(now(), 'YYYYMMDD') || '-' || upper(encode(gen_random_bytes(4), 'hex')), $1, $2::jsonb, $3)
       RETURNING unlisted_code`,
      [imageDataUrl, JSON.stringify(extractedData), userId ?? null],
    );
    return { status: "needs_registration" as const, code: result.rows[0].unlisted_code };
  }

  /**
   * The newest unmatched scan with this exact photo (md5 of the data URL, the
   * generated image_md5 column). Retries and re-uploads of the same file used to
   * store the photo again on every scan.
   */
  private async findIdenticalScan(imageHash: string) {
    const result = await this.pool.query<{ unlisted_code: string; status: string; registered_wine_id: string | null }>(
      `SELECT unlisted_code, status, registered_wine_id FROM unlisted_wine_scans
       WHERE image_md5 = $1 ORDER BY (registered_wine_id IS NOT NULL) DESC, created_at DESC LIMIT 1`,
      [imageHash],
    );
    return result.rows[0] ?? null;
  }

  private async countResubmission(code: string) {
    await this.pool.query(
      `UPDATE unlisted_wine_scans SET resubmissions = resubmissions + 1, last_submitted_at = now() WHERE unlisted_code = $1`,
      [code],
    );
  }

  /**
   * Offers the scan photo to the wine's photo pool (migration 015 / vinato-web 0010),
   * where the admin picks the photo the app shows. A byte-identical photo only
   * bumps times_seen; the pool keeps the 5 latest distinct photos. Best effort.
   */
  private async addToPhotoPool(wineId: string, file: Express.Multer.File, userId?: string) {
    try {
      await this.pool.query(
        `INSERT INTO wine_photo_candidates (wine_id, image_data_url, source, user_id)
         VALUES ($1, $2, 'scan', $3)
         ON CONFLICT (wine_id, image_md5) DO UPDATE
         SET times_seen = wine_photo_candidates.times_seen + 1, last_seen_at = now()`,
        [wineId, scanImageDataUrl(file), userId ?? null],
      );
    } catch (error) {
      console.error("[wine-scanner] could not add the scan photo to the wine photo pool", error);
    }
  }

  // The photo is a bonus: failing to store it must not fail the scan.
  private async attachScanImage(wineId: string, file: Express.Multer.File) {
    try {
      // jsonb_build_object takes "any": the parameter must be typed ($2::text),
      // otherwise Postgres rejects it (42P18) and every such scan failed.
      const updated = await this.pool.query(
        `UPDATE catalog_wines SET images = jsonb_build_array(jsonb_build_object(
           'url', $2::text, 'source', 'user_scan', 'role', 'front', 'review_status', 'pending', 'captured_at', now()
         )), updated_at = now()
         WHERE id = $1 AND (images IS NULL OR images = '[]'::jsonb)`,
        [wineId, scanImageDataUrl(file)],
      );
      return (updated.rowCount ?? 0) > 0;
    } catch (error) {
      console.error("[wine-scanner] could not store the scan photo", error);
      return false;
    }
  }

  async findScanCandidates(data: ScannedWineData): Promise<CatalogCandidate[]> {
    return this.findCandidatesByTerms(searchTerms(data));
  }

  /** The wine a product barcode was linked to (label-text-match), following merges; null when unknown. */
  async findWineByBarcode(barcode: string): Promise<{ wineId: string; vintage: number | null } | null> {
    try {
      const result = await this.pool.query<{ id: string; vintage: number | null }>(
        `SELECT coalesce(w.merged_into, w.id) AS id, w.vintage
         FROM wine_barcodes b JOIN catalog_wines w ON w.id = b.wine_id
         WHERE b.barcode = $1 AND (w.curation_status <> 'rejected' OR w.merged_into IS NOT NULL)
         LIMIT 1`,
        [barcode],
      );
      const row = result.rows[0];
      return row ? { wineId: row.id, vintage: row.vintage } : null;
    } catch (error) {
      // Before migration 022 there is no barcode table: the scan simply goes on.
      console.error("[wine-scanner] barcode lookup failed", (error as Error).message);
      return null;
    }
  }

  /**
   * Links a barcode to the wine a scan resolved. An existing link is kept (and
   * confirmed when it agrees) unless replace is set: the user said the barcode
   * answer was wrong and the AI read the label again.
   */
  async rememberBarcode(barcode: string, wineId: string, source: "scan_ai" | "scan_text", userId?: string, replace = false) {
    try {
      await this.pool.query(
        `INSERT INTO wine_barcodes (barcode, wine_id, source, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (barcode) DO UPDATE SET
           confirmations = wine_barcodes.confirmations + CASE WHEN wine_barcodes.wine_id = EXCLUDED.wine_id THEN 1 ELSE 0 END,
           wine_id = CASE WHEN $5::boolean THEN EXCLUDED.wine_id ELSE wine_barcodes.wine_id END,
           source = CASE WHEN $5::boolean THEN EXCLUDED.source ELSE wine_barcodes.source END,
           corrections = wine_barcodes.corrections + CASE WHEN $5::boolean AND wine_barcodes.wine_id <> EXCLUDED.wine_id THEN 1 ELSE 0 END,
           updated_at = now()`,
        [barcode, wineId, source, userId ?? null, replace],
      );
    } catch (error) {
      console.error("[wine-scanner] could not store the barcode", (error as Error).message);
    }
  }

  /** A scan resolved without AI: the photo still becomes the label (if missing) and joins the photo pool. */
  async attachDeviceScan(wineId: string, file: Express.Multer.File, userId?: string) {
    const imageAdded = await this.attachScanImage(wineId, file);
    await this.addToPhotoPool(wineId, file, userId);
    return imageAdded;
  }

  async findCandidatesByTerms(terms: string[]): Promise<CatalogCandidate[]> {
    if (!terms.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Short label terms against long normalized_search rows: word similarity,
      // served by the normalized_search GIN trigram index through %>.
      await client.query("SELECT set_config('pg_trgm.word_similarity_threshold', '0.6', true)");
      const where = terms.map((_, index) => `normalized_search %> $${index + 1}`).join(" OR ");
      const rank = terms.map((_, index) => `word_similarity($${index + 1}, normalized_search)`).join(" + ");
      // A duplicate the curators merged still answers to its name: it stands for
      // the wine it was merged into (otherwise the same label creates it again).
      const result = await client.query<{ id: string; merged_into: string | null; display_name: string; wine_name: string | null; producer_manufacturer: string | null; vintage: number | null; has_image: boolean; region: string | null; sub_region: string | null; country: string | null; color: string | null }>(
        `SELECT id, merged_into, display_name, wine_name, producer_manufacturer, vintage, region, sub_region, country, color,
                (jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0) AS has_image
         FROM catalog_wines
         WHERE (${where}) AND (curation_status <> 'rejected' OR merged_into IS NOT NULL)
         ORDER BY (${rank}) DESC
         LIMIT 40`,
        terms,
      );
      await client.query("COMMIT");
      return result.rows.map((row) => ({
        id: row.merged_into ?? row.id, displayName: row.display_name, wineName: row.wine_name,
        producer: row.producer_manufacturer, vintage: row.vintage, hasImage: row.has_image, colour: row.color,
        places: [row.region, row.sub_region, row.country].filter((place): place is string => Boolean(place)),
      }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileScan(data: ScannedWineData, file: Express.Multer.File, userId?: string, trace?: ScanTrace): Promise<NonNullable<ScanWineLabelResult["catalog"]>> {
    const startedAt = Date.now();
    const imageHash = createHash("md5").update(scanImageDataUrl(file)).digest("hex");
    const identical = await this.findIdenticalScan(imageHash);
    // The admin already linked this exact photo to a catalog wine: that is the answer,
    // even when the label reading still does not match the catalog on its own.
    if (identical?.registered_wine_id) {
      await this.countResubmission(identical.unlisted_code);
      const imageAdded = await this.attachScanImage(identical.registered_wine_id, file);
      await this.addToPhotoPool(identical.registered_wine_id, file, userId);
      await this.proposeCatalogUpdate(identical.registered_wine_id, data, trace, userId, true);
      return { status: "matched", wineId: identical.registered_wine_id, imageAdded, alternatives: [] };
    }

    if (trace) trace.catalogQueried = true;
    const candidates = await this.findScanCandidates(data);
    if (trace) { trace.catalogCandidates = candidates.length; trace.catalogMs = Date.now() - startedAt; }
    const decision = decideMatch(data, candidates);
    const alternatives = decision.alternatives.map((candidate) => ({ wineId: candidate.id, displayName: candidate.displayName }));

    if (decision.status === "matched") {
      const { best } = decision;
      const imageAdded = best.hasImage ? false : await this.attachScanImage(best.id, file);
      await this.addToPhotoPool(best.id, file, userId);
      // Only a strong match may propose facts for the wine: a borderline one
      // ("La Flor" → "Flor das Tecedeiras") would write another wine's facts.
      if (best.score >= STRONG_MATCH) await this.proposeCatalogUpdate(best.id, data, trace, userId, best.score >= AUTO_FILL_MATCH);
      return { status: "matched", wineId: best.id, imageAdded, matchScore: best.score, alternatives };
    }

    // No safe match: a scan never ends without wine details. The wine is created
    // from the AI reading (pending curation) with the scan photo as its front label.
    const aiWine = await this.createAiWine(data, file, userId, alternatives, trace);
    if (aiWine) {
      const imageAdded = aiWine.created || await this.attachScanImage(aiWine.wineId, file);
      await this.addToPhotoPool(aiWine.wineId, file, userId);
      if (!aiWine.created) await this.proposeCatalogUpdate(aiWine.wineId, data, trace, userId);
      return { status: "matched", wineId: aiWine.wineId, imageAdded, created: aiWine.created, alternatives };
    }

    // The reading names no wine (or the catalog could not be written): old review queue.
    // Same photo already waiting in the queue (or rejected): reuse its code instead of storing it again.
    if (identical) {
      await this.countResubmission(identical.unlisted_code);
      return { status: "needs_registration", code: identical.unlisted_code, alternatives };
    }

    const logged = await this.logUnlistedScan(file, userId, { ...data, catalogCandidates: alternatives });
    return { ...logged, alternatives };
  }

  /**
   * Creates the wine from the AI reading (data_source 'ai_scan', curation_status
   * 'pending') and its 'new_wine' proposal for the admin. A wine with the same name
   * and vintage is reused instead, so repeated scans never duplicate it.
   * Returns null when the reading names no wine or the catalog cannot be written.
   */
  private async createAiWine(data: ScannedWineData, file: Express.Multer.File, userId: string | undefined, alternatives: { wineId: string; displayName: string }[], trace?: ScanTrace) {
    const fields = readingToCatalogFields(data);
    // Too little was read ("La Flor", "Eterno"): creating a wine would invent one.
    // The app offers the similar catalog wines instead.
    if (!canCreateWine(fields) || !readingIdentity(data).sufficient) return null;
    try {
      const existing = await this.pool.query<{ id: string }>(
        `SELECT coalesce(merged_into, id) AS id FROM catalog_wines
         WHERE lower(btrim(display_name)) = lower(btrim($1))
           AND (vintage = $2::smallint OR (vintage IS NULL AND $2::smallint IS NULL))
           AND (curation_status <> 'rejected' OR merged_into IS NOT NULL)
         ORDER BY (merged_into IS NULL AND data_source = 'catalog') DESC, created_at
         LIMIT 1`,
        [fields.displayName, fields.vintage ?? null],
      );
      if (existing.rows[0]) return { wineId: existing.rows[0].id, created: false };

      const created = await this.pool.query<{ id: string }>(
        `INSERT INTO catalog_wines (display_name, wine_name, producer_manufacturer, country, region, sub_region, color, wine_type,
                                    designation, classification, vintage, alcohol_percent, grapes, description, pairings, images,
                                    data_source, curation_status, aging_potential)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15::jsonb,
                 jsonb_build_array(jsonb_build_object('url', $16::text, 'source', 'user_scan', 'role', 'front',
                   'review_status', 'pending', 'captured_at', now())),
                 'ai_scan', 'pending', $17)
         RETURNING id`,
        [
          fields.displayName, fields.wineName, fields.producer ?? null, fields.country ?? null, fields.region ?? null,
          fields.subRegion ?? null, fields.colour ?? null, fields.wineType ?? null, fields.designation ?? null,
          fields.classification ?? null, fields.vintage ?? null, fields.alcoholPercent ?? null,
          JSON.stringify((fields.grapes ?? []).map((name) => ({ name, percentage: null }))),
          fields.description ?? null,
          JSON.stringify({ dishes: fields.pairings ?? [], ingredients: [] }),
          scanImageDataUrl(file),
          fields.agingPotential ?? null,
        ],
      );
      const wineId = created.rows[0].id;
      await this.pool.query(
        `INSERT INTO wine_ai_proposals (wine_id, kind, proposed, reading, candidates, model, confidence, user_id)
         VALUES ($1, 'new_wine', $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7)`,
        [wineId, JSON.stringify(fields), JSON.stringify(data), JSON.stringify(alternatives), trace?.modelUsed ?? null, data.confidence, userId ?? null],
      );
      return { wineId, created: true };
    } catch (error) {
      console.error("[wine-scanner] could not create the wine from the AI reading", error);
      return null;
    }
  }

  /**
   * Records what the AI would fill or change on a wine it matched, for curation.
   * Pending proposals of a wine accumulate in one row (newest values win).
   * A wine still awaiting curation only counts the new scan. Best effort.
   */
  private async proposeCatalogUpdate(wineId: string, data: ScannedWineData, trace?: ScanTrace, userId?: string, autoFill = false) {
    try {
      const row = (await this.pool.query<CatalogFieldsRow>(`SELECT ${CATALOG_FIELDS_SELECT} FROM catalog_wines WHERE id = $1`, [wineId])).rows[0];
      if (!row) return;
      if (row.data_source === "ai_scan" && row.curation_status === "pending") {
        await this.pool.query(
          `UPDATE wine_ai_proposals SET times_proposed = times_proposed + 1, last_proposed_at = now()
           WHERE wine_id = $1 AND kind = 'new_wine' AND status = 'pending'`,
          [wineId],
        );
        return;
      }
      const current = catalogFieldsFromRow(row);
      const all = proposedUpdates(current, readingToCatalogFields(data));
      // Empty catalog fields ("Produtor não informado") are filled at once after a
      // very strong match, and kept as an applied proposal for the audit.
      const { fills, replacements } = splitFills(current, all);
      const fillKeys = Object.keys(fills) as (keyof CatalogFields)[];
      if (autoFill && fillKeys.length) {
        const { sets, values } = fillAssignments(fills, 1);
        await this.pool.query(`UPDATE catalog_wines SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, [wineId, ...values]);
        await this.pool.query(
          `INSERT INTO wine_ai_proposals (wine_id, kind, status, proposed, current_values, reading, model, confidence, user_id, reviewed_at, decisions)
           VALUES ($1, 'update', 'applied', $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7, now(), $8::jsonb)`,
          [wineId, JSON.stringify(fills), JSON.stringify(Object.fromEntries(fillKeys.map((key) => [key, null]))), JSON.stringify(data), trace?.modelUsed ?? null, data.confidence, userId ?? null,
            JSON.stringify({ auto: true, accepted: fillKeys, reason: "campos vazios preenchidos após correspondência forte" })],
        );
      }
      const changes = autoFill ? replacements : all;
      const keys = Object.keys(changes) as (keyof CatalogFields)[];
      if (!keys.length) return;
      const snapshot = Object.fromEntries(keys.map((key) => [key, current[key] ?? null]));
      await this.pool.query(
        `INSERT INTO wine_ai_proposals (wine_id, kind, proposed, current_values, reading, model, confidence, user_id)
         VALUES ($1, 'update', $2::jsonb, $3::jsonb, $4::jsonb, $5, $6, $7)
         ON CONFLICT (wine_id, kind) WHERE status = 'pending' DO UPDATE SET
           proposed = wine_ai_proposals.proposed || EXCLUDED.proposed,
           current_values = wine_ai_proposals.current_values || EXCLUDED.current_values,
           reading = EXCLUDED.reading, model = EXCLUDED.model, confidence = EXCLUDED.confidence,
           times_proposed = wine_ai_proposals.times_proposed + 1, last_proposed_at = now()`,
        [wineId, JSON.stringify(changes), JSON.stringify(snapshot), JSON.stringify(data), trace?.modelUsed ?? null, data.confidence, userId ?? null],
      );
    } catch (error) {
      console.error("[wine-scanner] could not record the AI proposal", error);
    }
  }

  async listUnlistedScans() {
    const result = await this.pool.query(
      `SELECT unlisted_code AS code, status, image_data_url AS "imageUrl", extracted_data AS "extractedData",
              user_id AS "userId", registered_wine_id AS "registeredWineId", admin_notes AS "adminNotes",
              created_at AS "createdAt", reviewed_at AS "reviewedAt"
       FROM unlisted_wine_scans ORDER BY (status = 'needs_registration') DESC, created_at DESC LIMIT 500`,
    );
    return result.rows;
  }

  async reviewUnlistedScan(code: string, status: "reviewing" | "registered" | "rejected", registeredWineId?: string) {
    const result = await this.pool.query(
      `UPDATE unlisted_wine_scans
       SET status = $2, registered_wine_id = $3, reviewed_at = now()
       WHERE unlisted_code = $1
       RETURNING unlisted_code AS code, status, registered_wine_id AS "registeredWineId", reviewed_at AS "reviewedAt"`,
      [code, status, registeredWineId ?? null],
    );
    return result.rows[0] ?? null;
  }

  async findAll(query: WineListQuery): Promise<PaginatedWines> {
    const { whereSql, params } = buildWhere(query);
    const offset = (query.page - 1) * query.limit;
    const countResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::int AS total FROM catalog_wines ${whereSql}`,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);
    const dataResult = await this.pool.query<WineRow>(
      `${baseSelect} ${whereSql} ORDER BY display_name ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, offset],
    );

    return {
      data: dataResult.rows.map(mapWineRow),
      total,
      page: query.page,
      limit: query.limit,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async autocomplete(term: string): Promise<AutocompleteWine[]> {
    const normalizedTerm = `%${term}%`;
    const result = await this.pool.query<WineRow>(
      `${baseSelect} WHERE (normalized_search ILIKE $1 OR display_name ILIKE $1) AND curation_status <> 'rejected' ORDER BY display_name ASC LIMIT 20`,
      [normalizedTerm],
    );

    return result.rows.map(mapWineRow).map((wine) => ({
      id: wine.id,
      lwin: wine.lwin,
      displayName: wine.displayName,
      country: wine.country,
      colour: wine.colour,
      imageUrl: wine.imageUrl,
      rating: wine.rating,
      grapes: wine.grapes,
      reviewCount: wine.reviewCount,
    }));
  }

  async findById(id: string): Promise<Wine | null> {
    // A duplicate merged by the curators (vinato-web migration 0012) opens the wine that replaced it.
    const result = await this.pool.query<WineRow>(
      `${baseSelect} WHERE id = COALESCE((SELECT merged_into FROM catalog_wines WHERE id = $1), $1) LIMIT 1`,
      [id],
    );

    return result.rows[0] ? mapWineRow(result.rows[0]) : null;
  }

  async findByLwin(lwin: string): Promise<Wine | null> {
    const result = await this.pool.query<WineRow>(
      `${baseSelect} WHERE scan_code = $1 OR 'catalog-' || id::text = $1 LIMIT 1`,
      [lwin],
    );

    return result.rows[0] ? mapWineRow(result.rows[0]) : null;
  }

  async explore(): Promise<ExploreCatalog> {
    if (this.exploreCache && this.exploreCache.expiresAt > Date.now()) return this.exploreCache.value;
    const [countries, regions, grapes, styles, awarded] = await Promise.all([
      this.pool.query(`
        SELECT country AS name, COUNT(*)::int AS count
        FROM catalog_wines WHERE length(btrim(country)) > 0 AND curation_status <> 'rejected'
        GROUP BY country ORDER BY COUNT(*) DESC, country ASC LIMIT 100
      `),
      this.pool.query(`
        WITH region_counts AS (
          SELECT region AS name, country, COUNT(*)::int AS count,
                 MAX(CASE
                   WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 AND jsonb_typeof(images->0) = 'string' AND images->>0 NOT ILIKE '%logo%' THEN images->>0
                   WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 AND COALESCE(images->0->>'url', images->0->>'image_url') NOT ILIKE '%logo%' THEN COALESCE(images->0->>'url', images->0->>'image_url')
                 END) AS image_url
          FROM catalog_wines WHERE length(btrim(region)) > 0 AND length(btrim(country)) > 0 AND curation_status <> 'rejected'
          GROUP BY region, country
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY country ORDER BY count DESC, name ASC) AS position
          FROM region_counts
        )
        SELECT name, country, count, image_url FROM ranked
        WHERE position <= 4 ORDER BY count DESC, name ASC
      `),
      this.pool.query(`
        SELECT grape.name, COUNT(*)::int AS count
        FROM catalog_wines wines
        CROSS JOIN LATERAL (
          SELECT CASE
            WHEN jsonb_typeof(item) = 'object' THEN item->>'name'
            WHEN jsonb_typeof(item) = 'string' THEN item#>>'{}'
          END AS name
          FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(wines.grapes) = 'array' THEN wines.grapes ELSE '[]'::jsonb END
          ) item
        ) grape
        WHERE length(btrim(grape.name)) > 0 AND wines.curation_status <> 'rejected'
        GROUP BY grape.name ORDER BY COUNT(*) DESC, grape.name ASC LIMIT 60
      `),
      this.pool.query(`
        SELECT ${STYLE_SQL} AS name, COUNT(*)::int AS count
        FROM catalog_wines
        WHERE COALESCE(NULLIF(btrim(color), ''), NULLIF(btrim(wine_type), '')) IS NOT NULL AND curation_status <> 'rejected'
        GROUP BY 1 ORDER BY COUNT(*) DESC, 1 ASC LIMIT 20
      `),
      this.pool.query(`SELECT COUNT(*)::int AS count FROM catalog_awarded_wines`),
    ]);
    const value = {
      countries: countries.rows.map(mapFacet),
      regions: regions.rows.map(mapFacet),
      grapes: grapes.rows.map(mapFacet),
      styles: styles.rows.map(mapFacet),
      awarded: { ready: true, count: Number(awarded.rows[0]?.count ?? 0) },
    };
    this.exploreCache = { value, expiresAt: Date.now() + 10 * 60 * 1000 };
    return value;
  }
}

function mapFacet(row: Record<string, unknown>) {
  return { name: String(row.name), count: Number(row.count), ...(row.country ? { country: String(row.country) } : {}), ...(row.image_url ? { imageUrl: String(row.image_url) } : {}) };
}

function buildWhere(query: WineListQuery) {
  // Wines the curators rejected (AI-created from a bad reading) stay out of every list.
  const clauses: string[] = ["curation_status <> 'rejected'"];
  const params: string[] = [];

  const addExactFilter = (column: string, value?: string) => {
    if (!value) return;
    params.push(value);
    clauses.push(`lower(${column}) = lower($${params.length})`);
  };

  addExactFilter("country", query.country);
  if (query.colour) {
    params.push(query.colour);
    clauses.push(`lower(${STYLE_SQL}) = lower($${params.length})`);
  }
  addExactFilter("region", query.region);
  addExactFilter("wine_type", query.type);

  if (query.awarded) clauses.push("EXISTS (SELECT 1 FROM catalog_awarded_wines awarded WHERE awarded.id = catalog_wines.id)");

  if (query.grape) {
    params.push(query.grape);
    clauses.push(`EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(grapes) = 'array' THEN grapes ELSE '[]'::jsonb END
      ) grape
      WHERE lower(CASE
        WHEN jsonb_typeof(grape) = 'object' THEN grape->>'name'
        WHEN jsonb_typeof(grape) = 'string' THEN grape#>>'{}'
      END) = lower($${params.length})
    )`);
  }

  if (query.search) {
    params.push(`%${query.search}%`);
    clauses.push(`(normalized_search ILIKE $${params.length} OR display_name ILIKE $${params.length})`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
