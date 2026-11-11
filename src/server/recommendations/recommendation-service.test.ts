import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Product } from "@/lib/types";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  BOUGHT_LAST_MONTH_MIN_UNITS,
  FBT_MIN_CO_PURCHASES,
  HISTORY_CAP,
  RECO_DEFAULT_LIMIT,
  RECO_MAX_LIMIT,
  createRecommendationService,
  getRecommendationService,
  type RecommendationService,
} from "./recommendation-service";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";

function setup(): { db: Database; svc: RecommendationService } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  return { db, svc: createRecommendationService({ db, now: () => NOW }) };
}

let orderSeq = 0;
interface OrderOpts {
  readonly session?: string;
  readonly status?: "paid" | "payment_failed";
  readonly fulfillment?: string;
  readonly at?: number;
}
/** Inserts an order; items are product ids (qty 1) or [id, qty]. */
function order(db: Database, items: readonly (string | readonly [string, number])[], o: OrderOpts = {}): string {
  orderSeq += 1;
  const id = `ord_test_${orderSeq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, ?, ?, 100, 100, 'USD', 'Test', 't@example.com', '1 St', 'City', 'RG', '00000', 'US', '4242', ?, ?, ?)`,
  ).run(id, o.session ?? S3, o.status ?? "paid", `idem_${id}`, new Date(o.at ?? NOW - DAY).toISOString(), o.fulfillment ?? "processing");
  const ins = db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 100, ?)");
  for (const item of items) {
    const [pid, qty] = typeof item === "string" ? [item, 1] : item;
    ins.run(id, pid, qty);
  }
  return id;
}

function view(db: Database, session: string, productId: string, at: number): void {
  db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)").run(
    session,
    productId,
    new Date(at).toISOString(),
  );
}

function addToCart(db: Database, session: string, productIds: readonly string[]): void {
  db.query("INSERT OR IGNORE INTO carts (session_id) VALUES (?)").run(session);
  let i = 0;
  for (const pid of productIds) {
    i += 1;
    db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity, created_at) VALUES (?, ?, 1, ?)").run(
      session,
      pid,
      new Date(NOW - 1000 * (100 - i)).toISOString(),
    );
  }
}

interface Row {
  id: string;
  category_id: string | null;
  brand_id: string | null;
  price_cents: number;
}
function available(db: Database): Row[] {
  return db
    .query<Row, [string]>(
      "SELECT id, category_id, brand_id, price_cents FROM products WHERE stock > 0 AND published_at <= ? ORDER BY id",
    )
    .all(new Date(NOW).toISOString());
}
function byId(db: Database, id: string): Row {
  const row = db.query<Row, [string]>("SELECT id, category_id, brand_id, price_cents FROM products WHERE id = ?").get(id);
  if (row === null) throw new Error(`no product ${id}`);
  return row;
}
function setStock(db: Database, id: string, stock: number): void {
  db.query("UPDATE products SET stock = ? WHERE id = ?").run(stock, id);
}
function unpublish(db: Database, id: string): void {
  db.query("UPDATE products SET published_at = ? WHERE id = ?").run(new Date(NOW + DAY).toISOString(), id);
}
const ids = (ps: readonly Product[]) => ps.map((p) => p.id);

/** Invariants every recommender must hold. */
function expectWellFormed(db: Database, ps: readonly Product[], exclude: readonly string[], limit = RECO_DEFAULT_LIMIT) {
  const list = ids(ps);
  expect(new Set(list).size).toBe(list.length);
  expect(list.length).toBeLessThanOrEqual(limit);
  const ok = new Set(available(db).map((r) => r.id));
  for (const id of list) {
    expect(exclude).not.toContain(id);
    expect(ok.has(id)).toBe(true);
  }
}

describe("constants", () => {
  test("contract values", () => {
    expect(RECO_DEFAULT_LIMIT).toBe(12);
    expect(FBT_MIN_CO_PURCHASES).toBe(2);
    expect(BOUGHT_LAST_MONTH_MIN_UNITS).toBe(5);
    expect(HISTORY_CAP).toBe(50);
  });
});

describe("cold start (no orders, no views)", () => {
  test("every recommender returns a full, well-formed list", () => {
    const { db, svc } = setup();
    const [a] = available(db);
    if (a === undefined) throw new Error("seed");
    const cat = a.category_id ?? "";
    for (const [name, list, excl] of [
      ["alsoViewed", svc.alsoViewed(a.id), [a.id]],
      ["alsoBought", svc.alsoBought(a.id), [a.id]],
      ["related", svc.related(a.id), [a.id]],
      ["inspiredBy", svc.inspiredBy(S1), []],
      ["forCart", svc.forCart(S1), []],
      ["popularInCategory", svc.popularInCategory(cat), []],
    ] as const) {
      expect({ name, n: list.length }).toEqual({ name, n: RECO_DEFAULT_LIMIT });
      expectWellFormed(db, list, excl);
    }
  });

  test("product-anchored fallback starts with the source's category", () => {
    const { db, svc } = setup();
    const a = byId(db, "prod_ceramic-pour-over"); // out of stock itself, category coffee-tea
    const sameCat = available(db).filter((r) => r.category_id === a.category_id && r.id !== a.id).map((r) => r.id);
    expect(sameCat.length).toBeGreaterThan(0);
    const got = ids(svc.alsoBought(a.id));
    expect(got.slice(0, sameCat.length)).toEqual(sameCat);
  });

  test("unknown / malformed product ids fall back to global lists, never throw", () => {
    const { db, svc } = setup();
    for (const bad of ["prod_nope", "", "x".repeat(10_000), "' OR 1=1 --"]) {
      expect(svc.alsoBought(bad).length).toBe(RECO_DEFAULT_LIMIT);
      expect(svc.alsoViewed(bad).length).toBe(RECO_DEFAULT_LIMIT);
      expect(svc.related(bad).length).toBe(RECO_DEFAULT_LIMIT);
      expect(svc.frequentlyBoughtTogether(bad)).toBeNull();
      expect(svc.boughtLastMonth(bad)).toBeNull();
    }
    expectWellFormed(db, svc.popularInCategory("cat_nope"), []);
    expect(svc.popularInCategory("cat_nope").length).toBe(RECO_DEFAULT_LIMIT);
  });

  test("history lists are empty without history", () => {
    const { svc } = setup();
    expect(svc.recentlyViewed(S1)).toEqual([]);
    expect(svc.buyAgain(S1)).toEqual([]);
  });

  test("an empty catalogue yields empty lists, not errors", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    const svc = createRecommendationService({ db, now: () => NOW });
    expect(svc.alsoBought("prod_x")).toEqual([]);
    expect(svc.popularInCategory("cat_x")).toEqual([]);
    expect(svc.inspiredBy(S1)).toEqual([]);
  });
});

describe("limit option", () => {
  test("default 12, custom, capped, and non-positive / fractional → []", () => {
    const { db, svc } = setup();
    const [a] = available(db);
    if (a === undefined) throw new Error("seed");
    expect(svc.related(a.id).length).toBe(12);
    expect(svc.related(a.id, { limit: 3 }).length).toBe(3);
    const big = svc.related(a.id, { limit: 10_000 });
    expect(big.length).toBe(Math.min(RECO_MAX_LIMIT, available(db).length - 1));
    expectWellFormed(db, big, [a.id], RECO_MAX_LIMIT);
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(svc.related(a.id, { limit })).toEqual([]);
      expect(svc.recentlyViewed(S1, { limit })).toEqual([]);
    }
  });
});

describe("alsoBought", () => {
  test("3 co-purchases rank above 1 (even when the 1-count id sorts first); ties by id", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, low, high, tie1, tie2] = [av[0], av[1], av[50], av[10], av[11]] as string[];
    if (!a || !low || !high || !tie1 || !tie2) throw new Error("seed");
    order(db, [a, high]);
    order(db, [a, high]);
    order(db, [a, high]);
    order(db, [a, low]);
    order(db, [a, tie2, tie1]);
    order(db, [a, tie2, tie1]);
    const got = ids(svc.alsoBought(a));
    expect(got.slice(0, 4)).toEqual([high, tie1, tie2, low]);
    expect(got).not.toContain(a);
    expectWellFormed(db, svc.alsoBought(a), [a]);
  });

  test("only paid, non-cancelled orders count", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, paid, failed, cancelled] = [av[0], av[40], av[41], av[42]] as string[];
    if (!a || !paid || !failed || !cancelled) throw new Error("seed");
    order(db, [a, paid]);
    for (let i = 0; i < 5; i += 1) {
      order(db, [a, failed], { status: "payment_failed" });
      order(db, [a, cancelled], { fulfillment: "cancelled" });
    }
    const got = ids(svc.alsoBought(a));
    expect(got[0]).toBe(paid);
    // failed/cancelled may only appear later via fallbacks, never ahead of the real co-purchase
    expect(got.indexOf(failed) === -1 || got.indexOf(failed) > 0).toBe(true);
    expect(got.indexOf(cancelled) === -1 || got.indexOf(cancelled) > 0).toBe(true);
    for (const st of ["delivered", "shipped", "packed", "out_for_delivery"]) {
      order(db, [a, cancelled], { fulfillment: st });
      order(db, [a, cancelled], { fulfillment: st });
    }
    expect(ids(svc.alsoBought(a))[0]).toBe(cancelled);
  });

  test("excludes out-of-stock and unpublished co-purchases", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, oos, unpub, okp] = [av[0], av[20], av[21], av[22]] as string[];
    if (!a || !oos || !unpub || !okp) throw new Error("seed");
    order(db, [a, oos, unpub, okp]);
    order(db, [a, oos, unpub]);
    setStock(db, oos, 0);
    unpublish(db, unpub);
    const got = svc.alsoBought(a);
    expect(ids(got)[0]).toBe(okp);
    expect(ids(got)).not.toContain(oos);
    expect(ids(got)).not.toContain(unpub);
    expectWellFormed(db, got, [a]);
  });

  test("the `now` option controls the published check", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, b] = [av[0], av[30]] as string[];
    if (!a || !b) throw new Error("seed");
    order(db, [a, b]);
    unpublish(db, b);
    expect(ids(svc.alsoBought(a))).not.toContain(b);
    expect(ids(svc.alsoBought(a, { now: NOW + 2 * DAY }))[0]).toBe(b);
  });
});

describe("alsoViewed", () => {
  test("ranks by number of sessions that viewed both; excludes the source", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, x, y] = [av[3], av[40], av[5]] as string[];
    if (!a || !x || !y) throw new Error("seed");
    for (const s of [S1, S2]) {
      view(db, s, a, NOW - 10);
      view(db, s, x, NOW - 5);
    }
    view(db, S3, a, NOW - 10);
    view(db, S3, y, NOW - 5);
    const got = svc.alsoViewed(a);
    expect(ids(got).slice(0, 2)).toEqual([x, y]);
    expectWellFormed(db, got, [a]);
  });
});

describe("frequentlyBoughtTogether", () => {
  test("top 2 companions co-purchased >= 2 times; total is the exact sum of current prices", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, b, c, d] = [av[0], av[45], av[46], av[1]] as string[];
    if (!a || !b || !c || !d) throw new Error("seed");
    for (let i = 0; i < 3; i += 1) order(db, [a, b]);
    for (let i = 0; i < 2; i += 1) order(db, [a, c]);
    order(db, [a, d]);
    const bundle = svc.frequentlyBoughtTogether(a);
    if (bundle === null) throw new Error("expected a bundle");
    expect(ids(bundle.items)).toEqual([a, b, c]);
    const sum = [a, b, c].reduce((s, id) => s + byId(db, id).price_cents, 0);
    expect(bundle.totalCents).toBe(sum);
    expect(Number.isInteger(bundle.totalCents)).toBe(true);
    // price change is reflected (current prices, not order snapshots)
    db.query("UPDATE products SET price_cents = 1234, list_price_cents = NULL WHERE id = ?").run(b);
    const again = svc.frequentlyBoughtTogether(a);
    expect(again?.totalCents).toBe(byId(db, a).price_cents + 1234 + byId(db, c).price_cents);
  });

  test("a single qualifying companion: bundle has exactly one; 1-time co-purchases never qualify", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, b, d] = [av[0], av[45], av[1]] as string[];
    if (!a || !b || !d) throw new Error("seed");
    order(db, [a, b]);
    order(db, [a, b]);
    order(db, [a, d]);
    expect(ids(svc.frequentlyBoughtTogether(a)?.items ?? [])).toEqual([a, b]);
  });

  test("no qualifying companion → falls back to related (2 companions)", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, d] = [av[0], av[1]] as string[];
    if (!a || !d) throw new Error("seed");
    order(db, [a, d]);
    const bundle = svc.frequentlyBoughtTogether(a);
    if (bundle === null) throw new Error("expected bundle");
    expect(ids(bundle.items)).toEqual([a, ...ids(svc.related(a, { limit: 2 }))]);
    expect(bundle.items.length).toBe(3);
    expect(bundle.totalCents).toBe(bundle.items.reduce((s, p) => s + p.priceCents, 0));
  });

  test("null for unknown, out-of-stock or unpublished main product", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, b] = [av[0], av[1]] as string[];
    if (!a || !b) throw new Error("seed");
    expect(svc.frequentlyBoughtTogether("prod_missing")).toBeNull();
    setStock(db, a, 0);
    expect(svc.frequentlyBoughtTogether(a)).toBeNull();
    unpublish(db, b);
    expect(svc.frequentlyBoughtTogether(b)).toBeNull();
  });

  test("companions never include unavailable products", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [a, b, c] = [av[0], av[45], av[46]] as string[];
    if (!a || !b || !c) throw new Error("seed");
    for (let i = 0; i < 3; i += 1) order(db, [a, b, c]);
    setStock(db, b, 0);
    const got = ids(svc.frequentlyBoughtTogether(a)?.items ?? []);
    expect(got[0]).toBe(a);
    expect(got[1]).toBe(c);
    expect(got).not.toContain(b);
  });
});

describe("related", () => {
  test("same category first, then same brand, each rating-weighted; ties by id", () => {
    const { db, svc } = setup();
    const a = byId(db, available(db).find((r) => available(db).filter((x) => x.category_id === r.category_id).length >= 3)?.id ?? "");
    const all = available(db);
    const sameCat = all.filter((r) => r.category_id === a.category_id && r.id !== a.id).map((r) => r.id);
    const sameBrand = all
      .filter((r) => r.brand_id === a.brand_id && r.category_id !== a.category_id && r.id !== a.id)
      .map((r) => r.id);
    // Neutralise seeded ratings, then make the last same-category product the best rated.
    db.query("UPDATE products SET rating_count = 0, rating_sum = 0").run();
    const star = sameCat[sameCat.length - 1];
    if (star === undefined) throw new Error("seed");
    db.query("UPDATE products SET rating_count = 20, rating_sum = 100 WHERE id = ?").run(star);
    const got = ids(svc.related(a.id, { limit: 50 }));
    const expectedCat = [star, ...sameCat.filter((id) => id !== star)];
    expect(got.slice(0, sameCat.length)).toEqual(expectedCat);
    expect(got.slice(sameCat.length, sameCat.length + sameBrand.length)).toEqual(sameBrand);
    expectWellFormed(db, svc.related(a.id), [a.id]);
  });

  test("one 5-star review does not outrank many 4.8-star reviews (Bayesian weighting)", () => {
    const { db, svc } = setup();
    const all = available(db);
    const a = all.find((r) => all.filter((x) => x.category_id === r.category_id).length >= 3);
    if (a === undefined) throw new Error("seed");
    const [p1, p2] = all.filter((r) => r.category_id === a.category_id && r.id !== a.id).map((r) => r.id);
    if (!p1 || !p2) throw new Error("seed");
    db.query("UPDATE products SET rating_count = 0, rating_sum = 0").run();
    db.query("UPDATE products SET rating_count = 1, rating_sum = 5 WHERE id = ?").run(p1);
    db.query("UPDATE products SET rating_count = 50, rating_sum = 240 WHERE id = ?").run(p2);
    expect(ids(svc.related(a.id)).slice(0, 2)).toEqual([p2, p1]);
  });
});

describe("inspiredBy", () => {
  test("recommends unviewed products from viewed categories, then brands", () => {
    const { db, svc } = setup();
    const all = available(db);
    const a = all.find((r) => all.filter((x) => x.category_id === r.category_id).length >= 3);
    if (a === undefined) throw new Error("seed");
    view(db, S1, a.id, NOW - 100);
    const sameCat = all.filter((r) => r.category_id === a.category_id && r.id !== a.id).map((r) => r.id);
    const got = svc.inspiredBy(S1);
    expect(ids(got).slice(0, sameCat.length).sort()).toEqual([...sameCat].sort());
    expectWellFormed(db, got, [a.id]);
    // session isolation: S2 has no views → global fallback, which may include a
    expect(svc.inspiredBy(S2).length).toBe(RECO_DEFAULT_LIMIT);
  });

  test("invalid session ids → [] without touching the DB", () => {
    const svc = createRecommendationService({ db: throwingDb(), now: () => NOW });
    for (const s of ["", "nope", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "seed_session_01", `${S1} `]) {
      expect(svc.inspiredBy(s)).toEqual([]);
      expect(svc.forCart(s)).toEqual([]);
      expect(svc.buyAgain(s)).toEqual([]);
      expect(svc.recentlyViewed(s)).toEqual([]);
    }
  });
});

describe("buyAgain", () => {
  test("each product once, newest order first, purchasable only, own paid orders only", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [p1, p2, p3, p4, p5, p6] = [av[1], av[2], av[3], av[4], av[5], av[6]] as string[];
    if (!p1 || !p2 || !p3 || !p4 || !p5 || !p6) throw new Error("seed");
    order(db, [p1, p2], { session: S1, at: NOW - 10 * DAY });
    order(db, [p3, p1], { session: S1, at: NOW - 2 * DAY });
    order(db, [p4], { session: S1, at: NOW - 1 * DAY });
    order(db, [p5], { session: S1, at: NOW - 3 * DAY, status: "payment_failed" });
    order(db, [p6], { session: S1, at: NOW - 3 * DAY, fulfillment: "cancelled" });
    order(db, [p6], { session: S2, at: NOW - DAY });
    setStock(db, p4, 0);
    // p1 & p3 share the order of NOW-2d (tie → id), then p2 (NOW-10d)
    const expected = [...[p1, p3].sort(), p2];
    expect(ids(svc.buyAgain(S1))).toEqual(expected);
    expect(ids(svc.buyAgain(S2))).toEqual([p6]);
    expect(ids(svc.buyAgain(S1, { limit: 1 }))).toEqual([expected[0] ?? ""]);
  });
});

describe("forCart", () => {
  test("co-purchased with cart items (summed), excluding the cart items", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [c1, c2, x, y] = [av[0], av[1], av[40], av[30]] as string[];
    if (!c1 || !c2 || !x || !y) throw new Error("seed");
    order(db, [c1, c2, x]);
    order(db, [c2, x]);
    order(db, [c1, y]);
    addToCart(db, S1, [c1, c2]);
    const got = svc.forCart(S1);
    expect(ids(got).slice(0, 2)).toEqual([x, y]);
    expectWellFormed(db, got, [c1, c2]);
    expect(svc.forCart(S2).length).toBe(RECO_DEFAULT_LIMIT);
  });
});

describe("popularInCategory", () => {
  test("paid units desc; department includes child categories; excludes unavailable", () => {
    const { db, svc } = setup();
    const dept = db
      .query<{ id: string }, []>("SELECT parent_id AS id FROM categories WHERE parent_id IS NOT NULL GROUP BY parent_id ORDER BY parent_id LIMIT 1")
      .get();
    if (dept === null) throw new Error("seed");
    const inDept = db
      .query<{ id: string }, [string, string]>(
        `SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id
          WHERE c.parent_id = ? AND p.stock > 0 AND p.published_at <= ? ORDER BY p.id`,
      )
      .all(dept.id, new Date(NOW).toISOString())
      .map((r) => r.id);
    const [a, b, oos] = [inDept[inDept.length - 1], inDept[inDept.length - 2], inDept[0]];
    if (!a || !b || !oos) throw new Error("seed");
    order(db, [[a, 5]]);
    order(db, [[b, 2]]);
    order(db, [[oos, 9]]);
    setStock(db, oos, 0);
    const got = ids(svc.popularInCategory(dept.id, { limit: 50 }));
    expect(got.slice(0, 2)).toEqual([a, b]);
    expect(got).not.toContain(oos);
    const rest = inDept.filter((id) => id !== a && id !== b && id !== oos);
    expect(got.slice(2, 2 + rest.length)).toEqual(rest);
  });
});

describe("recentlyViewed", () => {
  test("newest first, excludes unavailable, isolated per session", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [p1, p2, p3, p4] = [av[1], av[2], av[3], av[4]] as string[];
    if (!p1 || !p2 || !p3 || !p4) throw new Error("seed");
    expect(svc.recordView(S1, p1, NOW - 4000).ok).toBe(true);
    expect(svc.recordView(S1, p2, NOW - 3000).ok).toBe(true);
    expect(svc.recordView(S1, p3, NOW - 2000).ok).toBe(true);
    expect(svc.recordView(S1, p4, NOW - 1000).ok).toBe(true);
    expect(svc.recordView(S2, p1, NOW).ok).toBe(true);
    setStock(db, p3, 0);
    unpublish(db, p4);
    expect(ids(svc.recentlyViewed(S1))).toEqual([p2, p1]);
    expect(ids(svc.recentlyViewed(S2))).toEqual([p1]);
    expect(ids(svc.recentlyViewed(S1, { limit: 1 }))).toEqual([p2]);
    // re-view moves to the front
    svc.recordView(S1, p1, NOW);
    expect(ids(svc.recentlyViewed(S1))).toEqual([p1, p2]);
  });
});

describe("listHistory", () => {
  test("same rule as recentlyViewed, newest first, with viewedAt", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    const [p1, p2, p3, p4] = [av[1], av[2], av[3], av[4]] as string[];
    if (!p1 || !p2 || !p3 || !p4) throw new Error("seed");
    view(db, S1, p1, NOW - 4000);
    view(db, S1, p2, NOW - 3000);
    view(db, S1, p3, NOW - 2000);
    view(db, S1, p4, NOW - 1000);
    view(db, S2, p3, NOW);
    setStock(db, p3, 0);
    unpublish(db, p4);
    const history = svc.listHistory(S1);
    expect(history.map((h) => h.product.id)).toEqual([p2, p1]);
    expect(history.map((h) => h.viewedAt)).toEqual([new Date(NOW - 3000).toISOString(), new Date(NOW - 4000).toISOString()]);
    expect(history.map((h) => h.product.id)).toEqual(ids(svc.recentlyViewed(S1)));
    expect(svc.listHistory(S2)).toEqual([]);
    expect(svc.listHistory(S1, { limit: 1 }).map((h) => h.product.id)).toEqual([p2]);
  });

  test("now is injected: a product published later appears once now passes it", () => {
    const { db, svc } = setup();
    const [p1] = available(db).map((r) => r.id);
    if (!p1) throw new Error("seed");
    view(db, S1, p1, NOW - 1000);
    unpublish(db, p1);
    expect(svc.listHistory(S1)).toEqual([]);
    expect(svc.listHistory(S1, { now: NOW + 2 * DAY }).map((h) => h.product.id)).toEqual([p1]);
  });

  test("defaults to HISTORY_CAP entries (not RECO_DEFAULT_LIMIT)", () => {
    const { db, svc } = setup();
    const av = available(db).map((r) => r.id);
    av.forEach((id, i) => view(db, S1, id, NOW - 100_000 + i * 10));
    const history = svc.listHistory(S1);
    expect(history.length).toBe(Math.min(HISTORY_CAP, av.length));
    expect(history.length).toBeGreaterThan(RECO_DEFAULT_LIMIT);
    expect(history[0]?.product.id).toBe(av.at(-1));
  });

  test.each([0, -1, 1.5, Number.NaN])("limit %p returns []", (limit) => {
    const { db, svc } = setup();
    const [p1] = available(db).map((r) => r.id);
    if (!p1) throw new Error("seed");
    view(db, S1, p1, NOW - 1000);
    expect(svc.listHistory(S1, { limit })).toEqual([]);
  });

  test.each(["", "not-a-session", "x".repeat(300)])("bad owner key %p returns [] without SQL", (owner) => {
    const svc = createRecommendationService({ db: throwingDb(), now: () => NOW });
    expect(svc.listHistory(owner)).toEqual([]);
  });
});

describe("boughtLastMonth", () => {
  test("units in the last 30 days; null below the threshold", () => {
    const { db, svc } = setup();
    const [a] = available(db).map((r) => r.id);
    if (!a) throw new Error("seed");
    expect(svc.boughtLastMonth(a)).toBeNull();
    order(db, [[a, 4]], { at: NOW - 29 * DAY });
    expect(svc.boughtLastMonth(a)).toBeNull();
    order(db, [[a, 7]], { at: NOW - 31 * DAY }); // too old
    order(db, [[a, 9]], { at: NOW - DAY, status: "payment_failed" });
    order(db, [[a, 9]], { at: NOW - DAY, fulfillment: "cancelled" });
    order(db, [[a, 9]], { at: NOW + DAY }); // after `now`
    expect(svc.boughtLastMonth(a)).toBeNull();
    order(db, [[a, 1]], { at: NOW - DAY });
    expect(svc.boughtLastMonth(a)).toBe(BOUGHT_LAST_MONTH_MIN_UNITS);
    order(db, [[a, 2]], { at: NOW - 2 * DAY });
    expect(svc.boughtLastMonth(a)).toBe(7);
    // explicit `now` shifts the window to [NOW-60d, NOW-30d]: only the 7 units at NOW-31d
    expect(svc.boughtLastMonth(a, NOW - 30 * DAY)).toBe(7);
  });
});

describe("recordView / removeView / clearViews", () => {
  test("upserts without duplicate rows and updates viewed_at", () => {
    const { db, svc } = setup();
    const [a] = available(db).map((r) => r.id);
    if (!a) throw new Error("seed");
    expect(svc.recordView(S1, a, NOW - 5000)).toEqual({ ok: true, value: undefined });
    expect(svc.recordView(S1, a, NOW)).toEqual({ ok: true, value: undefined });
    const rows = db
      .query<{ viewed_at: string }, [string]>("SELECT viewed_at FROM product_views WHERE session_id = ?")
      .all(S1);
    expect(rows).toEqual([{ viewed_at: new Date(NOW).toISOString() }]);
  });

  test("trims to HISTORY_CAP per session, dropping the oldest", () => {
    const { db, svc } = setup();
    const all = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id").all().map((r) => r.id);
    expect(all.length).toBeGreaterThan(HISTORY_CAP + 5);
    all.slice(0, HISTORY_CAP + 5).forEach((id, i) => {
      expect(svc.recordView(S1, id, NOW - 100_000 + i).ok).toBe(true);
    });
    svc.recordView(S2, all[0] ?? "", NOW);
    const kept = db
      .query<{ product_id: string }, [string]>("SELECT product_id FROM product_views WHERE session_id = ? ORDER BY product_id")
      .all(S1)
      .map((r) => r.product_id);
    expect(kept).toEqual(all.slice(5, HISTORY_CAP + 5));
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?").get(S2)?.n).toBe(1);
  });

  test("the row just recorded survives the trim even with an older timestamp", () => {
    const { db, svc } = setup();
    const all = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id").all().map((r) => r.id);
    all.slice(0, HISTORY_CAP).forEach((id, i) => svc.recordView(S1, id, NOW + i));
    const late = all[HISTORY_CAP] ?? "";
    expect(svc.recordView(S1, late, NOW - DAY).ok).toBe(true);
    const n = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?").get(S1)?.n;
    expect(n).toBe(HISTORY_CAP);
    expect(
      db.query("SELECT 1 FROM product_views WHERE session_id = ? AND product_id = ?").get(S1, late),
    ).not.toBeNull();
  });

  test("unknown product → NOT_FOUND, nothing written", () => {
    const { db, svc } = setup();
    const r = svc.recordView(S1, "prod_missing", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    expect(db.query("SELECT COUNT(*) AS n FROM product_views").get()).toEqual({ n: 0 });
  });

  test("invalid session or product id → INVALID_INPUT with no SQL", () => {
    const svc = createRecommendationService({ db: throwingDb(), now: () => NOW });
    for (const [s, p] of [
      ["not-a-uuid", "prod_x"],
      ["", "prod_x"],
      [S1, ""],
      [S1, "x".repeat(201)],
    ] as const) {
      const r = svc.recordView(s, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    // runtime garbage from untyped callers
    const r = svc.recordView(42 as unknown as string, null as unknown as string);
    expect(r.ok ? "ok" : r.error.code).toBe("INVALID_INPUT");
    expect(() => svc.removeView("bad", "prod_x")).not.toThrow();
    expect(() => svc.clearViews("bad")).not.toThrow();
  });

  test("removeView deletes one row; clearViews only the given session", () => {
    const { db, svc } = setup();
    const [a, b] = available(db).map((r) => r.id);
    if (!a || !b) throw new Error("seed");
    svc.recordView(S1, a, NOW - 2);
    svc.recordView(S1, b, NOW - 1);
    svc.recordView(S2, a, NOW);
    svc.removeView(S1, b);
    expect(ids(svc.recentlyViewed(S1))).toEqual([a]);
    svc.removeView(S1, "prod_missing");
    svc.clearViews(S1);
    expect(svc.recentlyViewed(S1)).toEqual([]);
    expect(ids(svc.recentlyViewed(S2))).toEqual([a]);
  });

  test("deleting a product cascades its views away", () => {
    const { db, svc } = setup();
    db.query(
      "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('prod_tmp', 'tmp', 'Tmp', 100, 'USD', '/x.svg', 5)",
    ).run();
    expect(svc.recordView(S1, "prod_tmp", NOW).ok).toBe(true);
    db.query("DELETE FROM products WHERE id = 'prod_tmp'").run();
    expect(svc.recentlyViewed(S1)).toEqual([]);
  });
});

describe("timing: seed + 500 synthetic orders", () => {
  test("every query runs under 50 ms", () => {
    const { db, svc } = setup();
    const all = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id").all().map((r) => r.id);
    // Deterministic pseudo-random baskets (LCG) so the run is reproducible.
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const sessions = Array.from({ length: 120 }, (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    db.transaction(() => {
      for (let i = 0; i < 500; i += 1) {
        const basket = new Set<string>();
        const size = 1 + rand(4);
        while (basket.size < size) basket.add(all[rand(all.length)] ?? "");
        order(db, [...basket].map((id) => [id, 1 + rand(3)] as const), {
          session: sessions[rand(sessions.length)] ?? S1,
          at: NOW - rand(60) * DAY,
        });
      }
      for (const s of sessions) {
        for (let j = 0; j < 15; j += 1) {
          db.query(
            "INSERT OR REPLACE INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)",
          ).run(s, all[rand(all.length)] ?? "", new Date(NOW - rand(100_000)).toISOString());
        }
      }
    })();
    const s0 = sessions[0] ?? S1;
    addToCart(db, s0, all.slice(10, 13));
    const pid = all[7] ?? "";
    const cat = byId(db, pid).category_id ?? "";
    const dept = db.query<{ id: string }, [string]>("SELECT parent_id AS id FROM categories WHERE id = ?").get(cat)?.id ?? "";
    const queries: readonly [string, () => unknown][] = [
      ["alsoViewed", () => svc.alsoViewed(pid)],
      ["alsoBought", () => svc.alsoBought(pid)],
      ["frequentlyBoughtTogether", () => svc.frequentlyBoughtTogether(pid)],
      ["related", () => svc.related(pid)],
      ["inspiredBy", () => svc.inspiredBy(s0)],
      ["buyAgain", () => svc.buyAgain(s0)],
      ["forCart", () => svc.forCart(s0)],
      ["popularInCategory(leaf)", () => svc.popularInCategory(cat)],
      ["popularInCategory(dept)", () => svc.popularInCategory(dept)],
      ["recentlyViewed", () => svc.recentlyViewed(s0)],
      ["boughtLastMonth", () => svc.boughtLastMonth(pid)],
      ["recordView", () => svc.recordView(s0, pid)],
      ["removeView", () => svc.removeView(s0, pid)],
      ["clearViews", () => svc.clearViews(sessions[1] ?? S2)],
    ];
    const report: string[] = [];
    for (const [name, run] of queries) {
      const c0 = Bun.nanoseconds();
      run(); // cold: includes preparing the statements
      const cold = (Bun.nanoseconds() - c0) / 1e6;
      const samples: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const t0 = Bun.nanoseconds();
        run();
        samples.push((Bun.nanoseconds() - t0) / 1e6);
      }
      samples.sort((x, y) => x - y);
      const median = samples[2] ?? Number.POSITIVE_INFINITY;
      const max = samples[4] ?? Number.POSITIVE_INFINITY;
      report.push(`${name.padEnd(26)} cold ${cold.toFixed(3)} ms  median ${median.toFixed(3)} ms  max ${max.toFixed(3)} ms`);
      expect({ name, median: median < 50, cold: cold < 50 }).toEqual({ name, median: true, cold: true });
    }
    console.log(`[T36 timings, 60 products + 500 orders + ${sessions.length * 15} view upserts]\n${report.join("\n")}`);
    // Sanity on the populated data: well-formed outputs
    expectWellFormed(db, svc.alsoBought(pid), [pid]);
    expectWellFormed(db, svc.forCart(s0), all.slice(10, 13));
  });
});

describe("getRecommendationService", () => {
  const previous = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  });

  test("is a singleton over the shared database", () => {
    process.env.DATABASE_PATH = ":memory:";
    const a = getRecommendationService();
    expect(getRecommendationService()).toBe(a);
    expect(a.recentlyViewed(S1)).toEqual([]);
  });
});

/** A Database stand-in that fails the test if any SQL is prepared. */
function throwingDb(): Database {
  const fail = () => {
    throw new Error("SQL must not run");
  };
  return new Proxy({}, { get: () => fail }) as unknown as Database;
}
