import { createHash, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type pg from "pg";

const SESSION_DAYS = 30;

export type PublicUser = { id: string; email: string; displayName: string; role: string };

export class AccountRepository {
  constructor(private readonly pool: pg.Pool) {}

  async register(displayName: string, email: string, password: string) {
    const passwordHash = hashPassword(password);
    try {
      const result = await this.pool.query(
        `INSERT INTO app_users (display_name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email::text, display_name, role`,
        [displayName.trim(), email.trim().toLowerCase(), passwordHash],
      );
      return this.createSession(mapUser(result.rows[0]));
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new Error("EMAIL_ALREADY_EXISTS");
      throw error;
    }
  }

  async login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const result = await this.pool.query(
      `SELECT id, email::text, display_name, role, password_hash FROM app_users WHERE email = $1 LIMIT 1`,
      [normalizedEmail],
    );
    const row = result.rows[0];
    if (row) {
      if (!verifyPassword(password, row.password_hash)) return null;
      return this.createSession(mapUser(row));
    }

    return this.loginLegacyAccount(normalizedEmail, password);
  }

  private async loginLegacyAccount(email: string, password: string) {
    const legacyResult = await this.pool.query(
      `SELECT users.id, users.email, users.display_name, users.role, credentials.password_hash
       FROM users
       JOIN password_credentials credentials ON credentials.user_id = users.id
       WHERE lower(users.email) = $1
         AND users.status = 'active'
         AND (credentials.locked_until IS NULL OR credentials.locked_until <= now())
       LIMIT 1`,
      [email],
    );
    const legacy = legacyResult.rows[0];
    if (!legacy || !verifyLegacyPassword(password, legacy.password_hash)) return null;

    const migrated = await this.pool.query(
      `INSERT INTO app_users (id, email, display_name, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         updated_at = now()
       RETURNING id, email::text, display_name, role`,
      [legacy.id, email, legacy.display_name, hashPassword(password), mapLegacyRole(legacy.role)],
    );

    await this.pool.query(
      `UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1`,
      [legacy.id],
    );
    await this.pool.query(
      `UPDATE password_credentials SET failed_attempts = 0 WHERE user_id = $1`,
      [legacy.id],
    );

    return this.createSession(mapUser(migrated.rows[0]));
  }

  async getUser(token: string): Promise<PublicUser | null> {
    const result = await this.pool.query(
      `SELECT users.id, users.email::text, users.display_name, users.role
       FROM user_sessions sessions
       JOIN app_users users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $1 AND sessions.expires_at > now()
       LIMIT 1`,
      [tokenHash(token)],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async logout(token: string) {
    await this.pool.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [tokenHash(token)]);
  }

  async getCellar(userId: string) {
    const result = await this.pool.query(
      `SELECT cellars.quantity, cellars.added_at, cellars.updated_at,
              wines.id, COALESCE(wines.scan_code, 'catalog-' || wines.id::text) AS lwin,
              wines.display_name, wines.producer_manufacturer,
              wines.country, wines.region, wines.color, wines.vintage,
              wines.grapes, wines.images
       FROM user_cellars cellars
       JOIN catalog_wines wines ON wines.id = cellars.wine_id
       WHERE cellars.user_id = $1
       ORDER BY (cellars.quantity = 0), cellars.updated_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      quantity: row.quantity,
      addedAt: row.added_at,
      updatedAt: row.updated_at,
      wine: {
        id: row.id, lwin: row.lwin, displayName: row.display_name,
        producerName: row.producer_manufacturer, country: row.country, region: row.region,
        colour: row.color, vintageYear: row.vintage,
        rating: null, grapes: Array.isArray(row.grapes) ? row.grapes.join(", ") : null,
        imageUrl: firstImage(row.images), imagePath: null,
      },
    }));
  }

  async setCellarQuantity(userId: string, wineId: string, quantity: number) {
    const result = await this.pool.query(
      `INSERT INTO user_cellars (user_id, wine_id, quantity)
       SELECT $1, id, $3 FROM catalog_wines WHERE id = $2
       ON CONFLICT (user_id, wine_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, updated_at = now()
       RETURNING quantity`,
      [userId, wineId, quantity],
    );
    return result.rows[0]?.quantity ?? null;
  }

  async getHistory(userId: string) {
    const result = await this.pool.query(
      `SELECT history.id, history.wine_id, history.status, history.image_uri,
              history.result, history.scanned_at, wines.display_name, wines.country, wines.region
       FROM user_scan_history history
       LEFT JOIN catalog_wines wines ON wines.id = history.wine_id
       WHERE history.user_id = $1 ORDER BY history.scanned_at DESC LIMIT 250`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id, wineId: row.wine_id, status: row.status, imageUri: row.image_uri,
      result: row.result, scannedAt: row.scanned_at, wineName: row.display_name,
      wineMeta: [row.region, row.country].filter(Boolean).join(" • "),
    }));
  }

  async addHistory(userId: string, entry: { wineId?: string | null; status: string; imageUri?: string | null; result?: unknown }) {
    const result = await this.pool.query(
      `INSERT INTO user_scan_history (user_id, wine_id, status, image_uri, result)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, wine_id, status, image_uri, result, scanned_at`,
      [userId, entry.wineId ?? null, entry.status, entry.imageUri ?? null, JSON.stringify(entry.result ?? null)],
    );
    return result.rows[0];
  }

  async clearHistory(userId: string) {
    await this.pool.query(`DELETE FROM user_scan_history WHERE user_id = $1`, [userId]);
  }

  async getNews() {
    const result = await this.pool.query(
      `SELECT id, title, summary, image_url, link_url, published_at
       FROM news_posts WHERE published = true AND published_at <= now()
       ORDER BY published_at DESC LIMIT 20`,
    );
    return result.rows.map((row) => ({
      id: row.id, title: row.title, summary: row.summary,
      imageUrl: row.image_url, linkUrl: row.link_url, publishedAt: row.published_at,
    }));
  }

  private async createSession(user: PublicUser) {
    const token = randomBytes(32).toString("base64url");
    await this.pool.query(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      [user.id, tokenHash(token), String(SESSION_DAYS)],
    );
    return { token, user };
  }
}

function mapUser(row: Record<string, unknown>): PublicUser {
  return { id: String(row.id), email: String(row.email), displayName: String(row.display_name), role: String(row.role) };
}
function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password: string, stored: string) {
  const [, salt, expectedHex] = stored.split(":");
  if (!salt || !expectedHex) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyLegacyPassword(password: string, stored: string) {
  const [algorithm, iterationsText, saltText, expectedText] = stored.split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== "pbkdf2_sha256" || !Number.isSafeInteger(iterations) || iterations < 1 || !saltText || !expectedText) {
    return false;
  }

  const expected = Buffer.from(expectedText, "base64url");
  if (expected.length === 0) return false;

  // The original service stored a URL-safe salt. Support both common PBKDF2
  // conventions: using the encoded salt text or its decoded bytes.
  const candidates = [
    pbkdf2Sync(password, saltText, iterations, expected.length, "sha256"),
    pbkdf2Sync(password, Buffer.from(saltText, "base64url"), iterations, expected.length, "sha256"),
  ];
  return candidates.some((actual) => actual.length === expected.length && timingSafeEqual(actual, expected));
}

function mapLegacyRole(role: unknown): PublicUser["role"] {
  const normalized = String(role).toLowerCase();
  if (normalized === "super_admin" || normalized === "admin" || normalized === "owner") return "owner";
  if (normalized === "editor") return "editor";
  return "user";
}
function firstImage(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (typeof first === "string") return first;
  if (first && typeof first === "object") {
    const item = first as { url?: unknown; image_url?: unknown };
    const url = item.url ?? item.image_url;
    return typeof url === "string" && url ? url : null;
  }
  return null;
}
