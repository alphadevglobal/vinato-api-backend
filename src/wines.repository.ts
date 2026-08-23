import type {
  AutocompleteWine,
  ExploreCatalog,
  PaginatedWines,
  Wine,
  WineListQuery,
  WineRepository,
  WineRow,
} from "./types.js";
import { mapWineRow } from "./wine-mapper.js";
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
    NULL::numeric AS price_usd,
    NULL::numeric AS rating,
    CASE WHEN jsonb_typeof(grapes) = 'array' THEN array_to_string(ARRAY(SELECT jsonb_array_elements_text(grapes)), ', ') ELSE grapes #>> '{}' END AS grapes,
    NULL::text AS image_path,
    CASE
      WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 AND jsonb_typeof(images->0) = 'string' THEN images->>0
      WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 THEN COALESCE(images->0->>'url', images->0->>'image_url')
      ELSE NULL
    END AS image_url,
    NULL::text AS source_url,
    0::integer AS review_count,
    COALESCE((SELECT awarded.awards_count FROM catalog_awarded_wines awarded WHERE awarded.id = catalog_wines.id), 0)::integer AS awards_count,
    (SELECT awarded.latest_award_year FROM catalog_awarded_wines awarded WHERE awarded.id = catalog_wines.id) AS latest_award_year,
    (SELECT awarded.award_symbol FROM catalog_awarded_wines awarded WHERE awarded.id = catalog_wines.id) AS award_symbol,
    created_at,
    updated_at
  FROM catalog_wines
`;

export class PgWineRepository implements WineRepository {
  private exploreCache?: { value: ExploreCatalog; expiresAt: number };

  constructor(private readonly pool: pg.Pool) {}

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
      `${baseSelect} WHERE normalized_search ILIKE $1 OR display_name ILIKE $1 ORDER BY display_name ASC LIMIT 20`,
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
    const result = await this.pool.query<WineRow>(
      `${baseSelect} WHERE id = $1 LIMIT 1`,
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
        FROM catalog_wines WHERE length(btrim(country)) > 0
        GROUP BY country ORDER BY COUNT(*) DESC, country ASC LIMIT 100
      `),
      this.pool.query(`
        WITH region_counts AS (
          SELECT region AS name, country, COUNT(*)::int AS count,
                 MAX(CASE
                   WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 AND jsonb_typeof(images->0) = 'string' AND images->>0 NOT ILIKE '%logo%' THEN images->>0
                   WHEN jsonb_typeof(images) = 'array' AND jsonb_array_length(images) > 0 AND COALESCE(images->0->>'url', images->0->>'image_url') NOT ILIKE '%logo%' THEN COALESCE(images->0->>'url', images->0->>'image_url')
                 END) AS image_url
          FROM catalog_wines WHERE length(btrim(region)) > 0 AND length(btrim(country)) > 0
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
        WHERE length(btrim(grape.name)) > 0
        GROUP BY grape.name ORDER BY COUNT(*) DESC, grape.name ASC LIMIT 60
      `),
      this.pool.query(`
        SELECT COALESCE(NULLIF(btrim(color), ''), NULLIF(btrim(wine_type), '')) AS name,
               COUNT(*)::int AS count
        FROM catalog_wines
        WHERE COALESCE(NULLIF(btrim(color), ''), NULLIF(btrim(wine_type), '')) IS NOT NULL
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
  const clauses: string[] = [];
  const params: string[] = [];

  const addExactFilter = (column: string, value?: string) => {
    if (!value) return;
    params.push(value);
    clauses.push(`lower(${column}) = lower($${params.length})`);
  };

  addExactFilter("country", query.country);
  addExactFilter("color", query.colour);
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
