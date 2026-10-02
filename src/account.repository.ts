import { photoRefSql, photoUrl } from "./photo-url.js";
import { createHash, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type pg from "pg";

const SESSION_DAYS = 30;

export type Subscription = {
  plan: "free" | "premium"; startedAt: string | null; expiresAt: string | null;
  /** "vinato" = granted by the team in the panel; otherwise the store of the last purchase. */
  source: string | null;
  prices: { currency: "BRL"; monthlyCents: number; yearlyCents: number };
  /** Purchase through the App Store / Google Play: not available yet. */
  storePurchase: boolean;
};
// Used until vinato-web migration 0019 adds the prices to finance_settings.
const DEFAULT_PRICES = { monthlyCents: 2990, yearlyCents: 23990 };

export type PublicUser = { id: string; email: string; displayName: string; role: string; plan: "free" | "premium"; planExpiresAt: string | null; status: string; avatarUrl: string | null };

export class AccountRepository {
  constructor(private readonly pool: pg.Pool) {}

  async register(displayName: string, email: string, password: string) {
    const passwordHash = hashPassword(password);
    try {
      const result = await this.pool.query(
        `INSERT INTO app_users (display_name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id, email::text, display_name, role, plan, plan_expires_at, status, avatar_url`,
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
      `SELECT id, email::text, display_name, role, plan, plan_expires_at, status, password_hash, avatar_url FROM app_users WHERE email = $1 LIMIT 1`,
      [normalizedEmail],
    );
    const row = result.rows[0];
    if (row) {
      if (row.status !== "active") throw new Error("ACCOUNT_BLOCKED");
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
       RETURNING id, email::text, display_name, role, plan, plan_expires_at, status, avatar_url`,
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

  async socialLogin(provider: "apple" | "google", subject: string, email: string, displayName?: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const identity = await client.query(
        `SELECT users.id, users.email::text, users.display_name, users.role, users.plan, users.plan_expires_at, users.status, users.avatar_url
         FROM user_identities identities JOIN app_users users ON users.id = identities.user_id
         WHERE identities.provider = $1 AND identities.provider_subject = $2 LIMIT 1`,
        [provider, subject],
      );
      let row = identity.rows[0];
      if (!row) {
        const existing = await client.query(
          `SELECT id, email::text, display_name, role, plan, plan_expires_at, status, avatar_url FROM app_users WHERE email = $1 LIMIT 1`,
          [email.toLowerCase()],
        );
        if (existing.rows[0]) row = existing.rows[0];
        else {
          const created = await client.query(
            `INSERT INTO app_users (email, display_name, password_hash, role, plan, status)
             VALUES ($1, $2, $3, 'user', 'free', 'active')
             RETURNING id, email::text, display_name, role, plan, plan_expires_at, status, avatar_url`,
            [email.toLowerCase(), displayName?.trim() || email.split("@")[0], `social:${provider}`],
          );
          row = created.rows[0];
        }
        await client.query(
          `INSERT INTO user_identities (provider, provider_subject, user_id, provider_email)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (provider, provider_subject) DO UPDATE SET provider_email = EXCLUDED.provider_email, updated_at = now()`,
          [provider, subject, row.id, email.toLowerCase()],
        );
      }
      if (row.status !== "active") throw new Error("ACCOUNT_BLOCKED");
      await client.query("COMMIT");
      return this.createSession(mapUser(row));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getUser(token: string): Promise<PublicUser | null> {
    const result = await this.pool.query(
      `SELECT users.id, users.email::text, users.display_name, users.role, users.plan, users.plan_expires_at, users.status, users.avatar_url
       FROM user_sessions sessions
       JOIN app_users users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $1 AND sessions.expires_at > now() AND users.status = 'active'
       LIMIT 1`,
      [tokenHash(token)],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  /**
   * The user deletes their own account (App Store guideline 5.1.1(v)). Everything tied
   * to app_users goes with it (sessions, cellar, favorites, history, Sommelier
   * conversations; the database cascades and the audit trigger logs the deletion).
   * The legacy login row goes too, so the account cannot come back at the next login.
   * Team accounts are managed in the panel and cannot be deleted here.
   */
  async deleteAccount(userId: string) {
    const row = (await this.pool.query(`SELECT role, email::text AS email FROM app_users WHERE id = $1`, [userId])).rows[0];
    if (!row) return false;
    if (isTeamAccount(row.role, row.email)) throw new Error("PROTECTED_ACCOUNT");
    const deleted = await this.pool.query(`DELETE FROM app_users WHERE id = $1`, [userId]);
    if (!deleted.rowCount) return false;
    // Only an app customer's legacy login: panel users (admins) live in the same tables.
    // Separate statements: a missing legacy table must never undo the deletion above.
    const customer = `EXISTS (SELECT 1 FROM users WHERE id = $1 AND lower(role::text) NOT IN ('admin', 'super_admin', 'owner', 'editor'))`;
    await this.pool.query(`DELETE FROM password_credentials WHERE user_id = $1 AND ${customer}`, [userId]).catch(() => undefined);
    await this.pool.query(`DELETE FROM users WHERE id = $1 AND lower(role::text) NOT IN ('admin', 'super_admin', 'owner', 'editor')`, [userId]).catch(() => undefined);
    return true;
  }

  async logout(token: string) {
    await this.pool.query(`DELETE FROM user_sessions WHERE token_hash = $1`, [tokenHash(token)]);
  }

  async updateAvatar(userId: string, avatarUrl: string | null) {
    const result = await this.pool.query(
      `UPDATE app_users SET avatar_url = $2, updated_at = now()
       WHERE id = $1 RETURNING id, email::text, display_name, role, plan, plan_expires_at, status, avatar_url`,
      [userId, avatarUrl],
    );
    return mapUser(result.rows[0]);
  }

  async getFavorites(userId: string) {
    const result = await this.pool.query(
      `SELECT favorites.created_at, wines.id,
              COALESCE(wines.scan_code, 'catalog-' || wines.id::text) AS lwin,
              wines.display_name, wines.producer_manufacturer, wines.country, wines.region,
              wines.color, wines.vintage, wines.grapes, ${photoRefSql(0, "wines.images")} AS image_ref
       FROM user_favorites favorites
       JOIN catalog_wines wines ON wines.id = favorites.wine_id
       WHERE favorites.user_id = $1 ORDER BY favorites.created_at DESC`,
      [userId],
    );
    return result.rows.map((row) => ({
      favoritedAt: row.created_at,
      wine: mapCatalogWine(row),
    }));
  }

  async addFavorite(userId: string, wineId: string) {
    const result = await this.pool.query(
      `INSERT INTO user_favorites (user_id, wine_id)
       SELECT $1, id FROM catalog_wines WHERE id = $2
       ON CONFLICT (user_id, wine_id) DO NOTHING RETURNING wine_id`,
      [userId, wineId],
    );
    if (result.rowCount) return true;
    const exists = await this.pool.query(`SELECT 1 FROM catalog_wines WHERE id = $1`, [wineId]);
    return Boolean(exists.rowCount);
  }

  async removeFavorite(userId: string, wineId: string) {
    await this.pool.query(`DELETE FROM user_favorites WHERE user_id = $1 AND wine_id = $2`, [userId, wineId]);
  }

  async getCellar(userId: string) {
    const result = await this.pool.query(
      `SELECT cellars.quantity, cellars.added_at, cellars.updated_at,
              wines.id, COALESCE(wines.scan_code, 'catalog-' || wines.id::text) AS lwin,
              wines.display_name, wines.producer_manufacturer,
              wines.country, wines.region, wines.color, wines.vintage,
              wines.grapes, ${photoRefSql(0, "wines.images")} AS image_ref
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
      wine: mapCatalogWine(row),
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

  async deleteCellarWine(userId: string, wineId: string) {
    await this.pool.query(`DELETE FROM user_cellars WHERE user_id = $1 AND wine_id = $2`, [userId, wineId]);
  }

  async getHistory(userId: string) {
    const result = await this.pool.query(
      `SELECT history.id, history.wine_id, history.status, history.image_uri,
              history.result, history.scanned_at, wines.display_name, wines.country, wines.region,
              ${photoRefSql(0, "wines.images")} AS image_ref
       FROM user_scan_history history
       LEFT JOIN catalog_wines wines ON wines.id = history.wine_id
       WHERE history.user_id = $1 ORDER BY history.scanned_at DESC LIMIT 250`,
      [userId],
    );
    return result.rows.map((row) => ({
      id: row.id, wineId: row.wine_id, status: row.status, imageUri: row.image_uri,
      result: row.result, scannedAt: row.scanned_at, wineName: row.display_name,
      wineMeta: [row.region, row.country].filter(Boolean).join(" • "),
      // The catalog photo as a cacheable link: the scan's imageUri is a file on the phone that may be gone.
      wineImageUrl: row.wine_id ? photoUrl(String(row.wine_id), row.image_ref) : null,
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

  async listUsers() {
    const result = await this.pool.query(
      `SELECT id, email::text, display_name, role, plan, plan_expires_at, status, avatar_url, created_at, updated_at
       FROM app_users ORDER BY created_at DESC LIMIT 500`,
    );
    return result.rows.map((row) => ({ ...mapUser(row), createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  async updateAccess(userId: string, access: { status?: "active" | "blocked"; plan?: "free" | "premium" }) {
    // plan_started_at: set when the account becomes Premium, kept while it stays Premium.
    const result = await this.pool.query(
      `UPDATE app_users SET status = COALESCE($2, status), plan = COALESCE($3, plan),
         plan_started_at = CASE WHEN $3 = 'premium' AND plan <> 'premium' THEN now() WHEN $3 = 'free' THEN NULL ELSE plan_started_at END,
         updated_at = now()
       WHERE id = $1 RETURNING id, email::text, display_name, role, plan, plan_expires_at, status, avatar_url`,
      [userId, access.status ?? null, access.plan ?? null],
    );
    if (!result.rows[0]) return null;
    if (access.status === "blocked") await this.pool.query(`DELETE FROM user_sessions WHERE user_id = $1`, [userId]);
    await this.pool.query(
      `UPDATE users SET status = CASE WHEN $2 = 'blocked' THEN 'suspended' ELSE COALESCE($2, status) END, updated_at = now()
       WHERE id = $1`,
      [userId, access.status ?? null],
    );
    return mapUser(result.rows[0]);
  }

  /** "Assinatura Premium" in the app: the member's period and the prices of the plans. */
  async getSubscription(user: PublicUser): Promise<Subscription> {
    const account = (await this.pool.query(`SELECT plan_started_at FROM app_users WHERE id = $1`, [user.id])).rows[0];
    const purchase = (await this.pool.query(
      `SELECT provider, product_id, purchased_at, expires_at FROM app_purchases
       WHERE user_id = $1 AND status = 'completed' ORDER BY purchased_at DESC LIMIT 1`,
      [user.id],
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0];
    const prices = (await this.pool.query(
      `SELECT premium_monthly_cents, premium_yearly_cents FROM finance_settings WHERE id = 1`,
    ).catch(() => ({ rows: [] as Record<string, unknown>[] }))).rows[0];
    const iso = (value: unknown) => (value ? new Date(String(value)).toISOString() : null);
    const premium = user.plan === "premium";
    return {
      plan: user.plan,
      startedAt: premium ? iso(account?.plan_started_at) ?? iso(purchase?.purchased_at) : null,
      expiresAt: premium ? user.planExpiresAt : null,
      source: !premium ? null : purchase ? String(purchase.provider) : "vinato",
      prices: {
        currency: "BRL",
        monthlyCents: Number(prices?.premium_monthly_cents ?? DEFAULT_PRICES.monthlyCents),
        yearlyCents: Number(prices?.premium_yearly_cents ?? DEFAULT_PRICES.yearlyCents),
      },
      storePurchase: false,
    };
  }

  async getNews() {
    // The editorial CMS (vinato-web) writes full articles to news_articles: video,
    // body blocks, subtitle. The news_posts mirror only keeps title/summary/image,
    // so read the articles and fall back to the mirror on older databases.
    const articles = await this.pool.query(`SELECT to_regclass('public.news_articles') IS NOT NULL AS ready`);
    if (articles.rows[0]?.ready) {
      const result = await this.pool.query(
        `SELECT id, title, subtitle, summary, content, author_name, category, cover_image, cover_caption,
                video_url, video_thumbnail, video_caption, published_at,
                -- 'notifications' = "Atualização do app" (web migration 0019): only in the app's notifications.
                coalesce(to_jsonb(news_articles) ->> 'audience', 'feed') AS audience
         FROM news_articles
         WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= now()
         ORDER BY featured DESC, published_at DESC LIMIT 20`,
      );
      return result.rows.map((row) => ({
        id: row.id, title: row.title, subtitle: row.subtitle, summary: row.summary ?? "",
        content: Array.isArray(row.content) ? row.content : [], authorName: row.author_name, category: row.category,
        imageUrl: row.cover_image ?? row.video_thumbnail, imageCaption: row.cover_caption,
        videoUrl: row.video_url, videoThumbnail: row.video_thumbnail, videoCaption: row.video_caption,
        linkUrl: null, publishedAt: row.published_at, audience: row.audience === "notifications" ? "notifications" : "feed",
      }));
    }
    const result = await this.pool.query(
      `SELECT id, title, summary, image_url, link_url, published_at
       FROM news_posts WHERE published = true AND published_at <= now()
       ORDER BY published_at DESC LIMIT 20`,
    );
    return result.rows.map((row) => ({
      id: row.id, title: row.title, summary: row.summary,
      imageUrl: row.image_url, linkUrl: row.link_url, publishedAt: row.published_at, audience: "feed",
    }));
  }

  async getSommelierSelection() {
    const result = await this.pool.query(
      `SELECT selections.id, selections.wine_id, selections.eyebrow, selections.title,
              selections.summary, selections.image_url, selections.cta_label,
              wines.display_name AS wine_name
       FROM sommelier_selections selections
       LEFT JOIN catalog_wines wines ON wines.id = selections.wine_id
       WHERE selections.published = true
       ORDER BY selections.sort_order ASC, selections.updated_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? { id: row.id, wineId: row.wine_id, eyebrow: row.eyebrow, title: row.title,
      summary: row.summary, imageUrl: row.image_url, ctaLabel: row.cta_label, wineName: row.wine_name } : null;
  }

  async listEditorialNews() {
    return (await this.pool.query(`SELECT * FROM news_posts ORDER BY published_at DESC`)).rows;
  }

  async createNews(input: { title: string; summary: string; imageUrl?: string; linkUrl?: string; published?: boolean }) {
    return (await this.pool.query(
      `INSERT INTO news_posts (title, summary, image_url, link_url, published, published_at)
       VALUES ($1,$2,$3,$4,COALESCE($5,true),now()) RETURNING *`,
      [input.title, input.summary, input.imageUrl ?? null, input.linkUrl ?? null, input.published ?? true],
    )).rows[0];
  }

  async updateNews(id: string, input: { title?: string; summary?: string; imageUrl?: string | null; linkUrl?: string | null; published?: boolean }) {
    return (await this.pool.query(
      `UPDATE news_posts SET title = COALESCE($2,title), summary = COALESCE($3,summary),
       image_url = CASE WHEN $6 THEN $4 ELSE image_url END, link_url = CASE WHEN $7 THEN $5 ELSE link_url END,
       published = COALESCE($8,published), published_at = CASE WHEN $8 = true AND published = false THEN now() ELSE published_at END
       WHERE id = $1 RETURNING *`,
      [id, input.title ?? null, input.summary ?? null, input.imageUrl ?? null, input.linkUrl ?? null,
       Object.prototype.hasOwnProperty.call(input, "imageUrl"), Object.prototype.hasOwnProperty.call(input, "linkUrl"), input.published ?? null],
    )).rows[0] ?? null;
  }

  async upsertSommelierSelection(input: { wineId?: string; eyebrow: string; title: string; summary: string; imageUrl?: string; ctaLabel: string; published?: boolean }) {
    if (input.published !== false) await this.pool.query(`UPDATE sommelier_selections SET published = false WHERE published = true`);
    return (await this.pool.query(
      `INSERT INTO sommelier_selections (wine_id, eyebrow, title, summary, image_url, cta_label, published)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,true)) RETURNING *`,
      [input.wineId ?? null, input.eyebrow, input.title, input.summary, input.imageUrl ?? null, input.ctaLabel, input.published ?? true],
    )).rows[0];
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
  const expiresAt = row.plan_expires_at ? new Date(String(row.plan_expires_at)) : null;
  return {
    id: String(row.id), email: String(row.email), displayName: String(row.display_name), role: String(row.role),
    plan: effectivePlan(row.plan, expiresAt), planExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    status: String(row.status ?? "active"), avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
  };
}

/** Premium set by the admin panel is permanent (no date) or lasts until plan_expires_at. */
export function effectivePlan(plan: unknown, expiresAt: Date | null, now = new Date()): "free" | "premium" {
  if (plan !== "premium") return "free";
  return !expiresAt || expiresAt.getTime() > now.getTime() ? "premium" : "free";
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
function mapCatalogWine(row: Record<string, unknown>) {
  return {
    id: String(row.id), lwin: String(row.lwin), displayName: String(row.display_name),
    producerName: typeof row.producer_manufacturer === "string" ? row.producer_manufacturer : null,
    country: typeof row.country === "string" ? row.country : null,
    region: typeof row.region === "string" ? row.region : null,
    colour: typeof row.color === "string" ? row.color : null,
    vintageYear: typeof row.vintage === "number" ? row.vintage : null,
    rating: null,
    grapes: formatGrapes(row.grapes),
    imageUrl: photoUrl(String(row.id), row.image_ref), imagePath: null,
  };
}

function formatGrapes(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object" || !("name" in item)) return "";
    const grape = item as { name: unknown; percentage?: unknown };
    const name = typeof grape.name === "string" ? grape.name : "";
    const percentage = typeof grape.percentage === "number" || typeof grape.percentage === "string" ? String(grape.percentage) : "";
    return name ? `${percentage ? `${percentage}% ` : ""}${name}` : "";
  }).filter(Boolean).join(", ");
}

/** Accounts of the VINATO team: managed in the panel, never deleted from the app. */
export function isTeamAccount(role: unknown, email: unknown) {
  const normalized = String(role ?? "").toLowerCase();
  return ["admin", "super_admin", "owner"].includes(normalized) || String(email ?? "").toLowerCase() === "contato@vinatoapp.com";
}
