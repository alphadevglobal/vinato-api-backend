import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { sortOffers } from "../src/offers.repository.js";
import { publicAuthorName, validRating } from "../src/reviews.repository.js";

const WINE = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

describe("wine reviews", () => {
  it("accepts ratings from 1 to 5 in half points only", () => {
    expect([1, 1.5, 4.5, 5].map(validRating)).toEqual([1, 1.5, 4.5, 5]);
    expect([0, 0.5, 5.5, 4.3, "x", null].map(validRating)).toEqual([null, null, null, null, null, null]);
  });

  it("shows only the first name and last initial", () => {
    expect(publicAuthorName("Gabriel Lopes Ferreira")).toBe("Gabriel F.");
    expect(publicAuthorName("Flavio")).toBe("Flavio");
    expect(publicAuthorName("  ")).toBe("Membro VINATO");
  });

  const appWith = (user: object | null) => {
    const upsert = vi.fn(async () => ({ id: "r1", rating: 4.5 }));
    const list = vi.fn(async () => ({ average: 4.5, count: 1, reviews: [], myReview: null }));
    const app = createApp({
      wineRepository: { findById: vi.fn(async () => ({ id: WINE })) } as never,
      wineScanner: {} as never,
      accountRepository: { getUser: vi.fn(async () => user) } as never,
      reviews: { upsert, list } as never,
    });
    return { app, upsert, list };
  };
  const member = { id: "user-1", plan: "free", status: "active" };

  it("requires a session to review and validates the rating", async () => {
    await request(appWith(null).app).put(`/wines/${WINE}/reviews/me`).send({ rating: 4 }).expect(401);
    const { app, upsert } = appWith(member);
    await request(app).put(`/wines/${WINE}/reviews/me`).set("Authorization", "Bearer t").send({ rating: 7 }).expect(400);
    await request(app).put(`/wines/${WINE}/reviews/me`).set("Authorization", "Bearer t").send({ rating: 4.5, comment: "  Ótimo  " }).expect(200);
    expect(upsert).toHaveBeenCalledWith(WINE, "user-1", 4.5, "Ótimo");
  });

  it("lists reviews publicly and includes the viewer's own review when logged in", async () => {
    const { app, list } = appWith(member);
    await request(app).get(`/wines/${WINE}/reviews`).expect(200);
    expect(list).toHaveBeenLastCalledWith(WINE, undefined);
    await request(app).get(`/wines/${WINE}/reviews`).set("Authorization", "Bearer t").expect(200);
    expect(list).toHaveBeenLastCalledWith(WINE, "user-1");
  });
});

describe("where to buy ordering", () => {
  const offer = (store: string, priority: "high" | "medium" | "low", price: number) => ({ store, price, merchant: { priority } });

  it("puts high-priority stores first, then medium and low together by price", () => {
    const sorted = sortOffers([
      offer("C", "medium", 990), offer("D", "low", 890), offer("A", "high", 1050), offer("E", "low", 920), offer("B", "high", 1100),
    ]);
    expect(sorted.map((item) => item.store)).toEqual(["A", "B", "D", "E", "C"]);
  });

  it("lets medium win a price tie against low", () => {
    expect(sortOffers([offer("low", "low", 100), offer("medium", "medium", 100)]).map((item) => item.store)).toEqual(["medium", "low"]);
  });
});
