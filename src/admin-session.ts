import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Validates a vinato-web admin session token (the admin panel shares this
 * database: sessions/users, token stored as a SHA-256 hash). Lets the panel use
 * server-side AI (the OpenRouter key lives only here) without its own secret.
 */
export class AdminSessions {
  constructor(private readonly pool: pg.Pool) {}

  async adminFor(token: string): Promise<{ userId: string; role: string } | null> {
    if (!token) return null;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const result = await this.pool.query<{ userId: string; role: string }>(
      `SELECT u.id AS "userId", u.role FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND u.status = 'active' AND u.role IN ('admin', 'super_admin')
       LIMIT 1`,
      [tokenHash],
    );
    return result.rows[0] ?? null;
  }
}
