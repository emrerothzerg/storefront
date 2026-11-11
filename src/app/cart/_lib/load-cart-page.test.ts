import { beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { cartSummaryTotalCheck } from "@/components/organisms/CartSummary";
import type { Product } from "@/lib/types";
import { createCartService, SHIPPING_METHOD_DROPPED_NOTICE, type CartServiceV2 } from "@/server/cart/cart-service";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { createListingService } from "@/server/catalog/listing-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createListService } from "@/server/lists/list-service";
import { estimateDelivery } from "@/server/pricing/shipping-service";
import { createRecommendationService } from "@/server/recommendations/recommendation-service";

import {
  CART_RAIL_LIMIT,
  computeArrivals,
  emptyCartPageData,
  loadCartPageV2,
  toCartSummaryCart,
  type CartPageData,
  type CartPageDeps,
} from "./load-cart-page";

const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PINS = "prod_enamel-pin-set"; // 50, stock 100
const DESK = "prod_walnut-desk"; // 125000, stock 3
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-11-09T10:00:00.000Z"); // a Monday

let db: Database;
let cart: CartServiceV2;
let calls: string[];

function deps(overrides: Partial<CartPageDeps> = {}): CartPageDeps {
  const products = new SqliteProductRepository(db);
  const recos = createRecommendationService({ db, now: () => NOW });
  const lists = createListService({ db });
  const listing = createListingService({ db });
  return {
    now: NOW,
    getCart: () => {
      calls.push("cart");
      return cart;
    },
    getProducts: () => ({
      getManyByIds: (ids) => {
        calls.push(`getManyByIds:${ids.length}`);
        return products.getManyByIds(ids);
      },
    }),
    getLists: () => {
      calls.push("lists");
      return lists;
    },
    getRecommendations: () => {
      calls.push("recos");
      return recos;
    },
    getListing: () => {
      calls.push("listing");
      return listing;
    },
    ...overrides,
  };
}

function throwingDeps(): CartPageDeps {
  const boom = (name: string) => () => {
    throw new Error(`${name} must not be called`);
  };
  return {
    now: NOW,
    getCart: boom("getCart"),
    getProducts: boom("getProducts"),
    getLists: boom("getLists"),
    getRecommendations: boom("getRecommendations"),
    getListing: boom("getListing"),
  };
}

function mustOk<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

beforeEach(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  cart = createCartService(db, { now: () => NOW });
  calls = [];
});

describe("loadCartPageV2: no cookie (D-T108-1)", () => {
  function withoutSuggestions(data: CartPageData): CartPageData {
    return { ...data, bestSellers: [] };
  }

  /** Every dep throws except one counted best-seller reader (canned catalogue products). */
  function noCookieDeps(): { deps: CartPageDeps; reads: Array<{ limit: number | undefined; now: number | undefined }> } {
    const reads: Array<{ limit: number | undefined; now: number | undefined }> = [];
    const products = new SqliteProductRepository(db).getManyByIds([TOTE, PINS, DESK]);
    return {
      reads,
      deps: {
        ...throwingDeps(),
        getListing: () => ({
          bestSellers: (limit, opts) => {
            reads.push({ limit, now: opts?.now });
            return products;
          },
        }),
      },
    };
  }

  test("null session: the empty data plus best sellers from exactly one bestSellers read; no other service", () => {
    const { deps: d, reads } = noCookieDeps();
    const data = loadCartPageV2(null, d);
    expect(reads).toEqual([{ limit: CART_RAIL_LIMIT, now: NOW }]);
    expect(data.bestSellers.map((p) => p.id).sort()).toEqual([DESK, TOTE, PINS].sort());
    expect(withoutSuggestions(data)).toEqual(emptyCartPageData(NOW));
    expect(data.table.items).toEqual([]);
    expect(data.summary.canCheckout).toBe(false);
  });

  test("a malformed session id is treated like no cookie", () => {
    for (const bad of ["", "not-a-uuid", "../../etc", `${SESSION}x`]) {
      const { deps: d, reads } = noCookieDeps();
      const data = loadCartPageV2(bad, d);
      expect(reads).toHaveLength(1);
      expect(withoutSuggestions(data)).toEqual(emptyCartPageData(NOW));
      expect(data.bestSellers.length).toBeGreaterThan(0);
    }
  });

  test("a throwing listing service only empties the rail", () => {
    const data = loadCartPageV2(null, throwingDeps());
    expect(data).toEqual(emptyCartPageData(NOW));
  });
});

describe("loadCartPageV2: seeded :memory: DB", () => {
  test("D-T108-3: the cart view is read with the loader's now (options form); the service clock is never read", () => {
    let serviceClockReads = 0;
    let serviceNow = NOW;
    const clocked = createCartService(db, {
      now: () => {
        serviceClockReads += 1;
        return serviceNow;
      },
    });
    mustOk(clocked.addItem(SESSION, TOTE, 1));
    mustOk(clocked.addItem(SESSION, PINS, 1));
    mustOk(clocked.saveForLater(SESSION, PINS));
    // Published just before the loader's now but after a (stale) service clock:
    // judged at the service clock both would read as unavailable.
    db.run("UPDATE products SET published_at = ? WHERE id IN (?, ?)", [new Date(NOW - 1000).toISOString(), TOTE, PINS]);
    serviceNow = NOW - 86_400_000;
    const seen: unknown[] = [];
    serviceClockReads = 0;
    const data = loadCartPageV2(
      SESSION,
      deps({
        getCart: () => ({
          getCartView: (id, opts) => {
            seen.push(opts);
            return clocked.getCartView(id, opts);
          },
        }),
      }),
    );
    expect(seen).toEqual([{ now: NOW }]);
    expect(serviceClockReads).toBe(0);
    expect(data.table.items[0]?.status).toBe("ok");
    expect(data.saved.items[0]?.reason).toBeNull();
  });

  test("empty cart with a session: no lines, no summary data, best sellers only, no catalogue/list reads", () => {
    const data = loadCartPageV2(SESSION, deps());
    expect(data.table.items).toEqual([]);
    expect(data.alsoBought).toEqual([]);
    expect(data.arrivals).toEqual({});
    expect(data.saved).toEqual({ items: [], listId: null });
    expect(data.savedListHref).toBeNull();
    expect(calls).toContain("listing");
    expect(calls.some((c) => c.startsWith("getManyByIds"))).toBe(false);
    expect(calls).not.toContain("lists");
  });

  test("lines + saved: list prices from ONE getManyByIds call, saved list id + href, arrivals from one now", () => {
    db.run("UPDATE products SET list_price_cents = 2999 WHERE id = ?", [TOTE]);
    mustOk(cart.addItem(SESSION, TOTE, 2));
    mustOk(cart.addItem(SESSION, DESK, 1));
    mustOk(cart.addItem(SESSION, PINS, 3));
    mustOk(cart.saveForLater(SESSION, PINS));

    const data = loadCartPageV2(SESSION, deps());

    expect(calls.filter((c) => c.startsWith("getManyByIds"))).toEqual(["getManyByIds:2"]);
    const tote = data.table.items.find((l) => l.productId === TOTE);
    const desk = data.table.items.find((l) => l.productId === DESK);
    expect(tote?.listPriceCents).toBe(2999);
    expect(desk?.listPriceCents ?? null).toBeNull();
    expect(data.table.subtotalCents).toBe(2 * 1999 + 125000);

    expect(data.saved.items.map((s) => s.productId)).toEqual([PINS]);
    const sfl = createListService({ db })
      .listLists(SESSION)
      .find((l) => l.kind === "save_for_later");
    expect(data.saved.listId).toBe(sfl?.id ?? "missing");
    expect(data.savedListHref).toBe(`/lists/${sfl?.id ?? ""}`);

    expect(data.summary.shippingOptions.length).toBeGreaterThan(0);
    for (const option of data.summary.shippingOptions) {
      expect(data.arrivals[option.method.id]).toEqual(estimateDelivery(option.method, NOW, NOW));
    }
    expect(data.now).toBe(NOW);
    expect(cartSummaryTotalCheck(data.summary)).toBe("match");
  });

  test("no owner key or session field leaks into the organism props", () => {
    mustOk(cart.addItem(SESSION, TOTE, 1));
    const data = loadCartPageV2(SESSION, deps());
    expect(JSON.stringify(data)).not.toContain(SESSION);
    expect(data.table).not.toHaveProperty("sessionId");
    expect(data.summary).not.toHaveProperty("sessionId");
  });

  test("coupon applied: totals carry the discount, summary total check matches, no notice", () => {
    mustOk(cart.addItem(SESSION, TOTE, 2)); // 3998
    mustOk(cart.applyCoupon(SESSION, "SAVE5", NOW));
    const data = loadCartPageV2(SESSION, deps());
    expect(data.summary.coupon?.code).toBe("SAVE5");
    expect(data.summary.totals.discountCents).toBe(500);
    expect(data.summary.totals.totalCents).toBe(
      data.summary.totals.subtotalCents - 500 + data.summary.totals.shippingCents,
    );
    expect(cartSummaryTotalCheck(data.summary)).toBe("match");
    expect(data.couponNotice).toBeNull();
  });

  test("a dropped coupon surfaces once as the page notice and never inside the summary", () => {
    mustOk(cart.addItem(SESSION, TOTE, 2));
    mustOk(cart.applyCoupon(SESSION, "SAVE5", NOW));
    mustOk(cart.setQuantity(SESSION, TOTE, 1)); // 1999 < 2500 minimum
    const first = loadCartPageV2(SESSION, deps());
    expect(first.couponNotice).toContain("SAVE5");
    expect(first.summary.couponNotice).toBeNull();
    expect(first.summary.coupon).toBeNull();
    expect(loadCartPageV2(SESSION, deps()).couponNotice).toBeNull();
  });

  test("an inactive stored shipping method surfaces once as shippingNotice", () => {
    mustOk(cart.addItem(SESSION, TOTE, 1));
    mustOk(cart.selectShippingMethod(SESSION, "express"));
    db.run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    const first = loadCartPageV2(SESSION, deps());
    expect(first.shippingNotice).toBe(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(first.arrivals).not.toHaveProperty("express");
    expect(loadCartPageV2(SESSION, deps()).shippingNotice).toBeNull();
  });

  test("selecting a method changes shipping and total", () => {
    mustOk(cart.addItem(SESSION, TOTE, 1)); // 1999, below the free-standard threshold
    const before = loadCartPageV2(SESSION, deps()).summary.totals;
    mustOk(cart.selectShippingMethod(SESSION, "next_day"));
    const after = loadCartPageV2(SESSION, deps()).summary;
    expect(after.shipping?.method.id).toBe("next_day");
    expect(after.totals.shippingCents).toBe(1999);
    expect(after.totals.totalCents).toBe(before.totalCents - before.shippingCents + 1999);
  });

  test("blocked checkout: out-of-stock line keeps the view but canCheckout is false", () => {
    mustOk(cart.addItem(SESSION, TOTE, 1));
    db.run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    const data = loadCartPageV2(SESSION, deps());
    expect(data.table.items[0]?.status).toBe("unavailable");
    expect(data.table.canCheckout).toBe(false);
    expect(data.summary.canCheckout).toBe(false);
    expect(cartSummaryTotalCheck(data.summary)).toBe("match");
  });

  test("an unpublished line arrives unavailable with an empty slug and gets no list price", () => {
    db.run("UPDATE products SET list_price_cents = 2999 WHERE id = ?", [TOTE]);
    mustOk(cart.addItem(SESSION, TOTE, 1));
    db.run("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    const line = loadCartPageV2(SESSION, deps()).table.items[0];
    expect(line?.status).toBe("unavailable");
    expect(line?.slug).toBe("");
    expect(line?.listPriceCents ?? null).toBeNull();
  });

  test("also-bought rail excludes cart items and is capped", () => {
    mustOk(cart.addItem(SESSION, TOTE, 1));
    mustOk(cart.addItem(SESSION, DESK, 1));
    const data = loadCartPageV2(SESSION, deps());
    expect(data.alsoBought.length).toBeGreaterThan(0);
    expect(data.alsoBought.length).toBeLessThanOrEqual(CART_RAIL_LIMIT);
    expect(data.alsoBought.some((p) => p.id === TOTE || p.id === DESK)).toBe(false);
    expect(data.bestSellers).toEqual([]);
  });

  test("recently viewed is per session", () => {
    const recos = createRecommendationService({ db, now: () => NOW });
    mustOk(recos.recordView(SESSION, DESK, NOW - 1000));
    expect(loadCartPageV2(SESSION, deps()).recentlyViewed.map((p) => p.id)).toEqual([DESK]);
    expect(loadCartPageV2(OTHER, deps()).recentlyViewed).toEqual([]);
  });

  test("carts are isolated per session", () => {
    mustOk(cart.addItem(SESSION, TOTE, 2));
    expect(loadCartPageV2(OTHER, deps()).table.items).toEqual([]);
  });

  test("a failing recommender empties the rails but the cart still loads", () => {
    mustOk(cart.addItem(SESSION, TOTE, 1));
    const failing = deps({
      getRecommendations: () => ({
        forCart: (): readonly Product[] => {
          throw new Error("reco down");
        },
        recentlyViewed: (): readonly Product[] => {
          throw new Error("reco down");
        },
      }),
    });
    const data = loadCartPageV2(SESSION, failing);
    expect(data.table.items).toHaveLength(1);
    expect(data.alsoBought).toEqual([]);
    expect(data.recentlyViewed).toEqual([]);
  });

  test("a cart view error is thrown (error boundary), not rendered as an empty cart", () => {
    const failing = deps({
      getCart: () => ({
        getCartView: () => ({ ok: false, error: { code: "INTERNAL_ERROR", message: "boom" } }),
      }),
    });
    expect(() => loadCartPageV2(SESSION, failing)).toThrow("Cart could not be loaded: INTERNAL_ERROR");
  });
});

describe("helpers", () => {
  test("computeArrivals skips methods with impossible day counts", () => {
    const view = mustOk(cart.getCartView(SESSION, NOW));
    expect(computeArrivals(view.shippingOptions, NOW)).toEqual({});
    mustOk(cart.addItem(SESSION, TOTE, 1));
    const options = mustOk(cart.getCartView(SESSION, NOW)).shippingOptions;
    const first = options[0];
    if (first === undefined) throw new Error("no shipping options seeded");
    const broken = { ...first, method: { ...first.method, id: "broken", minDays: 5, maxDays: 1 } };
    const arrivals = computeArrivals([...options, broken], NOW);
    expect(Object.keys(arrivals).sort()).toEqual(options.map((o) => o.method.id).sort());
  });

  test("toCartSummaryCart nulls couponNotice and copies totals unchanged", () => {
    mustOk(cart.addItem(SESSION, TOTE, 1));
    const view = mustOk(cart.getCartView(SESSION, NOW));
    const summary = toCartSummaryCart({ ...view, couponNotice: "x" });
    expect(summary.couponNotice).toBeNull();
    expect(summary.totals).toEqual(view.totals);
    expect(Object.keys(summary.items[0] ?? {}).sort()).toEqual([
      "availableStock",
      "productId",
      "quantity",
      "status",
      "unitPriceCents",
    ]);
  });
});
