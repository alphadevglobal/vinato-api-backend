import type pg from "pg";

export type MerchantPriority = "high" | "medium" | "low";
export type WineOffer = {
  id: string;
  merchant: { id: string; name: string; logoUrl: string | null; priority: MerchantPriority };
  productName: string;
  url: string;
  price: number;
  currency: string;
  bottleSizeMl: number | null;
  checkedAt: string;
};
export type WineOffers = { featured: WineOffer[]; all: WineOffer[]; total: number; checkedAt: string | null };

// The agent runs every 6 h; an offer not seen for a day is considered gone.
const FRESH_FOR = "24 hours";
const FEATURED = 4;

/**
 * Display order agreed with the VINATO team:
 * 1. high-priority stores always first, cheapest first among them;
 * 2. then medium and low together, cheapest first (medium wins a tie).
 */
export function sortOffers<T extends { price: number; merchant: { priority: MerchantPriority } }>(offers: T[]): T[] {
  const tier = (offer: T) => (offer.merchant.priority === "high" ? 0 : 1);
  const tieBreak = (offer: T) => (offer.merchant.priority === "low" ? 1 : 0);
  return [...offers].sort((a, b) => tier(a) - tier(b) || a.price - b.price || tieBreak(a) - tieBreak(b));
}

export class OfferRepository {
  constructor(private readonly pool: pg.Pool) {}

  async forWine(wineId: string): Promise<WineOffers> {
    const result = await this.pool.query(
      `SELECT o.id, o.product_name, o.product_url, o.price::float AS price, o.currency, o.bottle_size_ml, o.last_seen_at,
              m.id AS merchant_id, m.name AS merchant_name, m.logo_url, m.priority
       FROM wine_offers o JOIN wine_merchants m ON m.id = o.merchant_id
       WHERE o.wine_id = $1 AND m.active AND NOT o.hidden AND o.in_stock AND o.last_seen_at >= now() - $2::interval`,
      [wineId, FRESH_FOR],
    );
    // One offer per store: its cheapest product for this wine.
    const cheapestPerStore = new Map<string, WineOffer>();
    for (const row of result.rows) {
      const offer: WineOffer = {
        id: row.id, productName: row.product_name, url: row.product_url, price: Number(row.price), currency: row.currency,
        bottleSizeMl: row.bottle_size_ml, checkedAt: new Date(row.last_seen_at).toISOString(),
        merchant: { id: row.merchant_id, name: row.merchant_name, logoUrl: row.logo_url, priority: row.priority },
      };
      const current = cheapestPerStore.get(offer.merchant.id);
      if (!current || offer.price < current.price) cheapestPerStore.set(offer.merchant.id, offer);
    }
    const all = sortOffers([...cheapestPerStore.values()]);
    const checkedAt = all.reduce<string | null>((latest, offer) => (!latest || offer.checkedAt > latest ? offer.checkedAt : latest), null);
    return { featured: all.slice(0, FEATURED), all, total: all.length, checkedAt };
  }
}
