import type {
  AutocompleteWine,
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
    lwin,
    status,
    display_name,
    producer_title,
    producer_name,
    wine,
    country,
    region,
    sub_region,
    site,
    parcel,
    colour,
    type,
    sub_type,
    designation,
    classification,
    vintage_config,
    first_vintage,
    final_vintage,
    date_added,
    date_updated,
    reference,
    created_at,
    updated_at
  FROM wines
`;

export class PgWineRepository implements WineRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findAll(query: WineListQuery): Promise<PaginatedWines> {
    const { whereSql, params } = buildWhere(query);
    const offset = (query.page - 1) * query.limit;
    const countResult = await this.pool.query<{ total: string }>(
      `SELECT COUNT(*)::int AS total FROM wines ${whereSql}`,
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
      `${baseSelect} WHERE display_name ILIKE $1 ORDER BY id ASC LIMIT 10`,
      [normalizedTerm],
    );

    return result.rows.map(mapWineRow).map((wine) => ({
      id: wine.id,
      lwin: wine.lwin,
      displayName: wine.displayName,
      country: wine.country,
      colour: wine.colour,
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
      `${baseSelect} WHERE lwin = $1 LIMIT 1`,
      [lwin],
    );

    return result.rows[0] ? mapWineRow(result.rows[0]) : null;
  }
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
  addExactFilter("colour", query.colour);
  addExactFilter("region", query.region);
  addExactFilter("type", query.type);

  if (query.search) {
    params.push(`%${query.search}%`);
    clauses.push(`display_name ILIKE $${params.length}`);
  }

  return {
    whereSql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}
