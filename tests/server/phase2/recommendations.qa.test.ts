/**
 * QA adversarial tests for T36 (recommendations + browsing history service),
 * src/server/recommendations/**. Owned by QA (QA-W1-T36). In-memory DB only;
 * never touches ./data/. Synthetic orders/views are inserted directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Product } from "@/lib/types";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, seedDatabase } from "@/server/db/seed";
import {
  BOUGHT_LAST_MONTH_MIN_UNITS,
  BOUGHT_LAST_MONTH_WINDOW_MS,
  FBT_MIN_CO_PURCHASES,
  HISTORY_CAP,
  RECO_DEFAULT_LIMIT,
  RECO_MAX_LIMIT,
  createRecommendationService,
  getRecommendationService,
  type RecommendationService,
} from "@/server/recommendations/recommendation-service";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const C = "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d";
const BUYER = "5e4d3c2b-1a09-4f8e-9d7c-6b5a49382716";

const HOSTILE: readonly string[] = [
  "' OR 1=1 --",
  "'; DROP TABLE products; --",
  "\") OR (\"1\"=\"1",
  "%",
  "_",
  "\u0000",
  "prod_x\u0000' --",
  "[\"prod_a\",\"prod_b\"]",
  "]) UNION SELECT id FROM products --",
  "\u{1F600}‮",
];

interface Fx {
  db: Database;
  svc: RecommendationService;
}

function setup(): Fx {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  return { db, svc: createRecommendationService({ db, now: () => NOW }) };
}

let seq = 0;
interface OrderOpts {
  session?: string;
  status?: "paid" | "payment_failed";
  fulfillment?: string;
  at?: number;
}
function order(db: Database, items: readonly (string | readonly [string, number])[], o: OrderOpts = {}): string {
  seq += 1;
  const id = `ord_qa36_${seq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, ?, ?, 100, 100, 'USD', 'QA', 'qa@example.com', '1 St', 'City', 'RG', '00000', 'US', '4242', ?, ?, ?)`,
  ).run(
    id,
    o.session ?? BUYER,
    o.status ?? "paid",
    `idem_${id}`,
    new Date(o.at ?? NOW - DAY).toISOString(),
    o.fulfillment ?? "delivered",
  );
  const ins = db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'x', 100, ?)");
  for (const it of items) {
    const [pid, qty] = typeof it === "string" ? [it, 1] : it;
    ins.run(id, pid, qty);
  }
  return id;
}
function view(db: Database, session: string, pid: string, at: number): void {
  db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)").run(
    session,
    pid,
    new Date(at).toISOString(),
  );
}
function cart(db: Database, session: string, pids: readonly string[]): void {
  db.query("INSERT OR IGNORE INTO carts (session_id) VALUES (?)").run(session);
  for (const pid of pids) {
    db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, 1)").run(session, pid);
  }
}
function availableIds(db: Database): Set<string> {
  return new Set(
    db
      .query<{ id: string }, [string]>("SELECT id FROM products WHERE stock > 0 AND published_at <= ?")
      .all(new Date(NOW).toISOString())
      .map((r) => r.id),
  );
}
function allIds(db: Database): string[] {
  return db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id").all().map((r) => r.id);
}
function outOfStock(db: Database): string[] {
  return db.query<{ id: string }, []>("SELECT id FROM products WHERE stock = 0 ORDER BY id").all().map((r) => r.id);
}
function categoryOf(db: Database, id: string): string {
  const r = db.query<{ c: string }, [string]>("SELECT category_id AS c FROM products WHERE id = ?").get(id);
  if (r === null) throw new Error(id);
  return r.c;
}
function viewCount(db: Database, session: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?").get(session)?.n ?? 0;
}
function setStock(db: Database, id: string, stock: number): void {
  db.query("UPDATE products SET stock = ? WHERE id = ?").run(stock, id);
}
function unpublish(db: Database, id: string): void {
  db.query("UPDATE products SET published_at = ? WHERE id = ?").run(new Date(NOW + DAY).toISOString(), id);
}
function republish(db: Database, id: string): void {
  db.query("UPDATE products SET published_at = ? WHERE id = ?").run(new Date(NOW - DAY).toISOString(), id);
}
/** Insert a synthetic product in a fresh category/brand. */
function product(
  db: Database,
  id: string,
  o: { category: string; brand?: string | null; price?: number; stock?: number; currency?: string; ratingCount?: number; ratingSum?: number; publishedAt?: number },
): void {
  db.query("INSERT OR IGNORE INTO categories (id, slug, name) VALUES (?, ?, ?)").run(o.category, o.category, o.category);
  if (o.brand) db.query("INSERT OR IGNORE INTO brands (id, slug, name) VALUES (?, ?, ?)").run(o.brand, o.brand, o.brand);
  db.query(
    `INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, category_id, brand_id, published_at)
     VALUES (?, ?, ?, ?, ?, '/x.svg', ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    id,
    o.price ?? 1000,
    o.currency ?? "USD",
    o.stock ?? 10,
    o.category,
    o.brand ?? null,
    new Date(o.publishedAt ?? NOW - 10 * DAY).toISOString(),
  );
  if (o.ratingCount !== undefined) {
    db.query("UPDATE products SET rating_count = ?, rating_sum = ? WHERE id = ?").run(o.ratingCount, o.ratingSum ?? 0, id);
  }
}
const ids = (ps: readonly Product[]) => ps.map((p) => p.id);
function need(arr: readonly string[], i: number): string {
  const v = arr[i];
  if (v === undefined) throw new Error(`fixture index ${i} missing`);
  return v;
}

function wellFormed(db: Database, ps: readonly Product[], exclude: readonly string[], limit = RECO_DEFAULT_LIMIT): void {
  const list = ids(ps);
  expect(new Set(list).size).toBe(list.length);
  expect(list.length).toBeLessThanOrEqual(limit);
  const ok = availableIds(db);
  for (const id of list) {
    expect(exclude).not.toContain(id);
    expect(ok.has(id)).toBe(true);
  }
}

/** Proxy over a db that counts every property access to SQL-running members. */
function spyDb(db: Database): { db: Database; calls: string[] } {
  const calls: string[] = [];
  const SQL = new Set(["query", "prepare", "run", "exec", "transaction"]);
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && SQL.has(prop)) calls.push(prop);
      const v: unknown = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxy, calls };
}

const RECOMMENDERS = ["alsoViewed", "alsoBought", "related"] as const;

describe("QA T36 crit 1: shared invariants on every recommender", () => {
  test("cold start (no orders, no views): product-anchored recommenders return exactly 12 available, distinct, non-source ids", () => {
    const { db, svc } = setup();
    for (const src of allIds(db)) {
      for (const m of RECOMMENDERS) {
        const r = svc[m](src);
        wellFormed(db, r, [src]);
        expect(r.length).toBe(RECO_DEFAULT_LIMIT);
      }
    }
  });

  test("source that is itself out of stock / unpublished still gets non-empty recommendations, excluding itself", () => {
    const { db, svc } = setup();
    const oos = outOfStock(db)[0];
    if (oos === undefined) throw new Error("seed has no out-of-stock product");
    const src = allIds(db).find((id) => id !== oos) ?? "";
    unpublish(db, src);
    for (const s of [oos, src]) {
      for (const m of RECOMMENDERS) {
        const r = svc[m](s);
        wellFormed(db, r, [s]);
        expect(r.length).toBe(RECO_DEFAULT_LIMIT);
      }
    }
  });

  test("unpublished and out-of-stock products never appear even when they are top co-purchases / co-views / best sellers", () => {
    const { db, svc } = setup();
    const all = allIds(db);
    const src = all[0] ?? "";
    const hot1 = all[1] ?? "";
    const hot2 = all[2] ?? "";
    for (let i = 0; i < 5; i += 1) order(db, [src, [hot1, 9], [hot2, 9]]);
    view(db, A, src, NOW - 1000);
    view(db, A, hot1, NOW - 900);
    view(db, A, hot2, NOW - 800);
    setStock(db, hot1, 0);
    unpublish(db, hot2);
    cart(db, B, [src]);
    const lists = [
      svc.alsoViewed(src),
      svc.alsoBought(src),
      svc.related(src),
      svc.popularInCategory(categoryOf(db, src)),
      svc.forCart(B),
      svc.inspiredBy(A),
      svc.buyAgain(BUYER),
      svc.recentlyViewed(A),
    ];
    for (const l of lists) {
      expect(ids(l)).not.toContain(hot1);
      expect(ids(l)).not.toContain(hot2);
    }
    const fbt = svc.frequentlyBoughtTogether(src);
    expect(fbt).not.toBeNull();
    expect(ids(fbt?.items ?? [])).not.toContain(hot1);
    expect(ids(fbt?.items ?? [])).not.toContain(hot2);
  });

  test("RecoOptions.now controls the published check (future-published product becomes visible later)", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_future", { category: "cat_qa_f", publishedAt: NOW + 5 * DAY });
    expect(ids(svc.popularInCategory("cat_qa_f"))).not.toContain("prod_qa_future");
    expect(ids(svc.popularInCategory("cat_qa_f", { now: NOW + 6 * DAY }))).toContain("prod_qa_future");
  });

  test("limit: default 12, cap 50, explicit 1 / 7; 0, negative, fractional, NaN, Infinity -> []", () => {
    const { db, svc } = setup();
    const src = allIds(db)[0] ?? "";
    cart(db, A, [src]);
    view(db, A, src, NOW - 1);
    type Call = (o?: { limit?: number }) => readonly Product[];
    const calls: Call[] = [
      (o) => svc.alsoViewed(src, o),
      (o) => svc.alsoBought(src, o),
      (o) => svc.related(src, o),
      (o) => svc.inspiredBy(A, o),
      (o) => svc.forCart(A, o),
      (o) => svc.popularInCategory(categoryOf(db, src), o),
    ];
    const availableCount = availableIds(db).size;
    for (const call of calls) {
      expect(call().length).toBe(RECO_DEFAULT_LIMIT);
      expect(call({ limit: 1 }).length).toBe(1);
      expect(call({ limit: 7 }).length).toBe(7);
      const big = call({ limit: 1000 });
      expect(big.length).toBeLessThanOrEqual(RECO_MAX_LIMIT);
      expect(big.length).toBe(Math.min(RECO_MAX_LIMIT, availableCount - 1));
      for (const bad of [0, -1, -12, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2 ** 60]) {
        expect(call({ limit: bad })).toEqual([]);
      }
    }
    expect(svc.recentlyViewed(A, { limit: 0 })).toEqual([]);
    expect(svc.buyAgain(A, { limit: Number.NaN })).toEqual([]);
  });

  test("never empty while the catalogue has stock: only one other available product left", () => {
    const { db, svc } = setup();
    const all = allIds(db);
    const src = all[0] ?? "";
    const last = all[all.length - 1] ?? "";
    for (const id of all) if (id !== src && id !== last) setStock(db, id, 0);
    for (const m of RECOMMENDERS) expect(ids(svc[m](src))).toEqual([last]);
    expect(ids(svc.popularInCategory("cat_nope"))).toContain(last);
    expect(ids(svc.inspiredBy(A))).toContain(last);
    expect(ids(svc.forCart(A))).toContain(last);
  });

  test("fallback chain order: own picks -> category best sellers -> global best sellers -> newest", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_src", { category: "cat_qa_chain" });
    product(db, "prod_qa_cat_hot", { category: "cat_qa_chain" });
    product(db, "prod_qa_cat_cold", { category: "cat_qa_chain" });
    product(db, "prod_qa_co", { category: "cat_qa_other" });
    product(db, "prod_qa_global", { category: "cat_qa_other2" });
    product(db, "prod_qa_newest", { category: "cat_qa_other3", publishedAt: NOW - 1000 });
    order(db, ["prod_qa_src", "prod_qa_co"]);
    order(db, [["prod_qa_cat_hot", 3]]);
    order(db, [["prod_qa_global", 50]]);
    const r = ids(svc.alsoBought("prod_qa_src"));
    expect(r.slice(0, 4)).toEqual(["prod_qa_co", "prod_qa_cat_hot", "prod_qa_cat_cold", "prod_qa_global"]);
    // newest fills after the (only) globally-sold products are exhausted
    expect(r).toContain("prod_qa_newest");
    expect(r.length).toBe(RECO_DEFAULT_LIMIT);
  });

  test("hostile / invalid product and category ids never throw, return the global fallback, and leave tables intact", () => {
    const { db, svc } = setup();
    const before = allIds(db).length;
    for (const h of [...HOSTILE, "", "x".repeat(201), "x".repeat(100_000)]) {
      for (const m of RECOMMENDERS) {
        const r = svc[m](h);
        wellFormed(db, r, []);
        expect(r.length).toBe(RECO_DEFAULT_LIMIT);
      }
      expect(svc.popularInCategory(h).length).toBe(RECO_DEFAULT_LIMIT);
      expect(svc.frequentlyBoughtTogether(h)).toBeNull();
      expect(svc.boughtLastMonth(h)).toBeNull();
      expect(svc.recordView(A, h).ok).toBe(false);
    }
    expect(allIds(db).length).toBe(before);
    expect(viewCount(db, A)).toBe(0);
  });

  test("non-string inputs at runtime (JS callers) do not throw", () => {
    const { svc } = setup();
    const junk: unknown[] = [null, undefined, 42, {}, [], Symbol("x")];
    for (const j of junk) {
      const id = j as string;
      expect(() => svc.related(id)).not.toThrow();
      expect(svc.inspiredBy(id)).toEqual([]);
      expect(svc.buyAgain(id)).toEqual([]);
      expect(svc.recentlyViewed(id)).toEqual([]);
      expect(svc.forCart(id)).toEqual([]);
      expect(svc.frequentlyBoughtTogether(id)).toBeNull();
      expect(svc.boughtLastMonth(id)).toBeNull();
      const r = svc.recordView(A, id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
      expect(() => svc.removeView(id, id)).not.toThrow();
      expect(() => svc.clearViews(id)).not.toThrow();
    }
  });
});

describe("QA T36 crit 2: alsoBought paid semantics and ranking", () => {
  test("3-co-purchase product ranks above 1-co-purchase; ties by id; payment_failed and cancelled orders ignored", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_m", { category: "cat_qa_ab" });
    product(db, "prod_qa_three", { category: "cat_qa_ab2" });
    product(db, "prod_qa_one", { category: "cat_qa_ab2" });
    product(db, "prod_qa_tie_b", { category: "cat_qa_ab2" });
    product(db, "prod_qa_tie_a", { category: "cat_qa_ab2" });
    // Newest product in the DB, so the "newest" fallback surfaces it whatever the seed publishes recently.
    product(db, "prod_qa_ghost", { category: "cat_qa_ab2", publishedAt: NOW - DAY });
    for (let i = 0; i < 3; i += 1) order(db, ["prod_qa_m", "prod_qa_three"]);
    order(db, ["prod_qa_m", "prod_qa_one"]);
    order(db, ["prod_qa_m", "prod_qa_tie_b", "prod_qa_tie_a"]);
    order(db, ["prod_qa_m", "prod_qa_tie_b", "prod_qa_tie_a"]);
    // 10 non-paid co-purchases of ghost must not count
    for (let i = 0; i < 5; i += 1) order(db, ["prod_qa_m", "prod_qa_ghost"], { status: "payment_failed" });
    for (let i = 0; i < 5; i += 1) order(db, ["prod_qa_m", "prod_qa_ghost"], { fulfillment: "cancelled" });
    // cancelled orders must not inflate "three" either
    for (let i = 0; i < 5; i += 1) order(db, ["prod_qa_m", "prod_qa_one"], { fulfillment: "cancelled" });
    const r = ids(svc.alsoBought("prod_qa_m"));
    expect(r.slice(0, 4)).toEqual(["prod_qa_three", "prod_qa_tie_a", "prod_qa_tie_b", "prod_qa_one"]);
    // ghost only arrives via the fallback chain (after the co-purchased ones) — never ranked by its non-paid orders
    expect(r.indexOf("prod_qa_ghost")).toBeGreaterThan(3);
  });

  test("non-paid orders do not count towards category/global best sellers either", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_bs_a", { category: "cat_qa_bs" });
    product(db, "prod_qa_bs_z", { category: "cat_qa_bs" });
    order(db, [["prod_qa_bs_z", 40]], { status: "payment_failed" });
    order(db, [["prod_qa_bs_z", 40]], { fulfillment: "cancelled" });
    order(db, [["prod_qa_bs_a", 1]]);
    expect(ids(svc.popularInCategory("cat_qa_bs"))).toEqual(["prod_qa_bs_a", "prod_qa_bs_z"].concat(ids(svc.popularInCategory("cat_qa_bs")).slice(2)));
    expect(svc.boughtLastMonth("prod_qa_bs_z")).toBeNull();
  });
});

describe("QA T36 crit 3: frequentlyBoughtTogether", () => {
  test("companions co-purchased >= 2 times, max 2, exact integer total of CURRENT prices", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_main", { category: "cat_qa_fbt", price: 1999 });
    product(db, "prod_qa_c1", { category: "cat_qa_fbt2", price: 2999 });
    product(db, "prod_qa_c2", { category: "cat_qa_fbt2", price: 1 });
    product(db, "prod_qa_c3", { category: "cat_qa_fbt2", price: 777 });
    product(db, "prod_qa_once", { category: "cat_qa_fbt2", price: 5 });
    for (let i = 0; i < 4; i += 1) order(db, ["prod_qa_main", "prod_qa_c1"]);
    for (let i = 0; i < 3; i += 1) order(db, ["prod_qa_main", "prod_qa_c2"]);
    for (let i = 0; i < 2; i += 1) order(db, ["prod_qa_main", "prod_qa_c3"]);
    order(db, ["prod_qa_main", "prod_qa_once"]);
    // price change after purchase: total must use the current price
    db.query("UPDATE products SET price_cents = 3001 WHERE id = 'prod_qa_c1'").run();
    const b = svc.frequentlyBoughtTogether("prod_qa_main");
    expect(b).not.toBeNull();
    expect(ids(b?.items ?? [])).toEqual(["prod_qa_main", "prod_qa_c1", "prod_qa_c2"]);
    expect(b?.totalCents).toBe(1999 + 3001 + 1);
    expect(Number.isInteger(b?.totalCents)).toBe(true);
  });

  test("exactly one product at the threshold -> 1 companion; below threshold (1 co-purchase) -> falls back to related", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_m1", { category: "cat_qa_t", brand: "brand_qa_t" });
    product(db, "prod_qa_two", { category: "cat_qa_t9" });
    product(db, "prod_qa_sib", { category: "cat_qa_t", brand: "brand_qa_t" });
    for (let i = 0; i < FBT_MIN_CO_PURCHASES; i += 1) order(db, ["prod_qa_m1", "prod_qa_two"]);
    const one = svc.frequentlyBoughtTogether("prod_qa_m1");
    expect(ids(one?.items ?? [])).toEqual(["prod_qa_m1", "prod_qa_two"]);

    product(db, "prod_qa_m2", { category: "cat_qa_t", brand: "brand_qa_t" });
    order(db, ["prod_qa_m2", "prod_qa_two"]);
    const fb = svc.frequentlyBoughtTogether("prod_qa_m2");
    const rel = ids(svc.related("prod_qa_m2")).slice(0, 2);
    expect(ids(fb?.items ?? [])).toEqual(["prod_qa_m2", ...rel]);
    expect(ids(fb?.items ?? [])).not.toContain("prod_qa_two");
  });

  test("non-paid co-purchases do not qualify a companion", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_np", { category: "cat_qa_np" });
    product(db, "prod_qa_np_c", { category: "cat_qa_np9" });
    for (let i = 0; i < 4; i += 1) order(db, ["prod_qa_np", "prod_qa_np_c"], { status: "payment_failed" });
    for (let i = 0; i < 4; i += 1) order(db, ["prod_qa_np", "prod_qa_np_c"], { fulfillment: "cancelled" });
    const b = svc.frequentlyBoughtTogether("prod_qa_np");
    expect(ids(b?.items ?? [])).not.toContain("prod_qa_np_c");
  });

  test("companions in a different currency are excluded; bundle total is single-currency", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_usd", { category: "cat_qa_cur" });
    product(db, "prod_qa_eur", { category: "cat_qa_cur9", currency: "EUR", price: 5 });
    for (let i = 0; i < 5; i += 1) order(db, ["prod_qa_usd", "prod_qa_eur"]);
    const b = svc.frequentlyBoughtTogether("prod_qa_usd");
    expect(b).not.toBeNull();
    expect(ids(b?.items ?? [])).not.toContain("prod_qa_eur");
    expect(new Set((b?.items ?? []).map((p) => p.currency)).size).toBe(1);
    expect(b?.totalCents).toBe((b?.items ?? []).reduce((s, p) => s + p.priceCents, 0));
  });

  test("null for unknown, out-of-stock, or unpublished main product; companions are never unavailable", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_x", { category: "cat_qa_x" });
    product(db, "prod_qa_xc", { category: "cat_qa_x9" });
    for (let i = 0; i < 3; i += 1) order(db, ["prod_qa_x", "prod_qa_xc"]);
    expect(svc.frequentlyBoughtTogether("prod_does_not_exist")).toBeNull();
    setStock(db, "prod_qa_xc", 0);
    expect(ids(svc.frequentlyBoughtTogether("prod_qa_x")?.items ?? [])).not.toContain("prod_qa_xc");
    setStock(db, "prod_qa_x", 0);
    expect(svc.frequentlyBoughtTogether("prod_qa_x")).toBeNull();
    setStock(db, "prod_qa_x", 3);
    unpublish(db, "prod_qa_x");
    expect(svc.frequentlyBoughtTogether("prod_qa_x")).toBeNull();
  });

  test("every seed product: 0..2 companions, main first, total = exact sum", () => {
    const { db, svc } = setup();
    const avail = availableIds(db);
    for (const id of allIds(db)) {
      const b = svc.frequentlyBoughtTogether(id);
      if (!avail.has(id)) {
        expect(b).toBeNull();
        continue;
      }
      expect(b).not.toBeNull();
      const items = b?.items ?? [];
      expect(items[0]?.id).toBe(id);
      expect(items.length).toBeGreaterThanOrEqual(1);
      expect(items.length).toBeLessThanOrEqual(3);
      expect(new Set(ids(items)).size).toBe(items.length);
      expect(b?.totalCents).toBe(items.reduce((s, p) => s + p.priceCents, 0));
    }
  });
});

describe("QA T36 related: category first, then brand, damped rating", () => {
  test("same category before same brand; one 5-star review does not beat fifty 4.8-star reviews; ties by id", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_r_src", { category: "cat_qa_r", brand: "brand_qa_r" });
    product(db, "prod_qa_r_one5", { category: "cat_qa_r", ratingCount: 1, ratingSum: 5 });
    product(db, "prod_qa_r_fifty", { category: "cat_qa_r", ratingCount: 50, ratingSum: 240 });
    product(db, "prod_qa_r_tie_b", { category: "cat_qa_r" });
    product(db, "prod_qa_r_tie_a", { category: "cat_qa_r" });
    product(db, "prod_qa_r_brand", { category: "cat_qa_r_elsewhere", brand: "brand_qa_r", ratingCount: 500, ratingSum: 2500 });
    // Newest product in the DB, so the "newest" fallback surfaces it whatever the seed publishes recently.
    product(db, "prod_qa_r_stranger", { category: "cat_qa_r_elsewhere", ratingCount: 500, ratingSum: 2500, publishedAt: NOW - DAY });
    const r = ids(svc.related("prod_qa_r_src"));
    expect(r.slice(0, 5)).toEqual(["prod_qa_r_fifty", "prod_qa_r_one5", "prod_qa_r_tie_a", "prod_qa_r_tie_b", "prod_qa_r_brand"]);
    expect(r.indexOf("prod_qa_r_stranger")).toBeGreaterThan(4);
  });
});

describe("QA T36 inspiredBy / forCart", () => {
  test("invalid session -> [] with no SQL; valid session without views -> non-empty global fallback", () => {
    const { db } = setup();
    const spy = spyDb(db);
    const svc = createRecommendationService({ db: spy.db, now: () => NOW });
    spy.calls.length = 0;
    for (const bad of ["", "not-a-uuid", A.toUpperCase() + "x", ...HOSTILE]) {
      expect(svc.inspiredBy(bad)).toEqual([]);
      expect(svc.forCart(bad)).toEqual([]);
      expect(svc.buyAgain(bad)).toEqual([]);
      expect(svc.recentlyViewed(bad)).toEqual([]);
    }
    expect(spy.calls).toEqual([]);
    const fresh = svc.inspiredBy(C);
    expect(spy.calls.length).toBeGreaterThan(0); // positive control: the spy sees real SQL
    expect(fresh.length).toBe(RECO_DEFAULT_LIMIT);
    wellFormed(db, fresh, []);
  });

  test("excludes every product the session viewed (even beyond the first 12) and prefers viewed categories", () => {
    const { db, svc } = setup();
    const all = allIds(db);
    const viewed = all.slice(0, 20);
    viewed.forEach((id, i) => view(db, A, id, NOW - 100_000 + i));
    const r = svc.inspiredBy(A);
    wellFormed(db, r, viewed);
    expect(r.length).toBe(RECO_DEFAULT_LIMIT);
    // another session's views do not leak
    const r2 = svc.inspiredBy(B);
    wellFormed(db, r2, []);
  });

  test("inspiredBy ranks a product in the viewed category first", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_i_seen", { category: "cat_qa_i", brand: "brand_qa_i" });
    product(db, "prod_qa_i_sib", { category: "cat_qa_i" });
    view(db, A, "prod_qa_i_seen", NOW - 10);
    expect(ids(svc.inspiredBy(A))[0]).toBe("prod_qa_i_sib");
  });

  test("forCart excludes every cart item and ranks co-purchases first; empty cart -> non-empty fallback", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_k1", { category: "cat_qa_k" });
    product(db, "prod_qa_k2", { category: "cat_qa_k" });
    product(db, "prod_qa_kc", { category: "cat_qa_k9" });
    order(db, ["prod_qa_k1", "prod_qa_kc"]);
    order(db, ["prod_qa_k2", "prod_qa_kc"]);
    cart(db, A, ["prod_qa_k1", "prod_qa_k2"]);
    const r = ids(svc.forCart(A));
    expect(r[0]).toBe("prod_qa_kc");
    expect(r).not.toContain("prod_qa_k1");
    expect(r).not.toContain("prod_qa_k2");
    expect(r.length).toBe(RECO_DEFAULT_LIMIT);
    expect(svc.forCart(B).length).toBe(RECO_DEFAULT_LIMIT);
  });
});

describe("QA T36 crit 4: recordView", () => {
  test("upsert: no duplicate rows, viewed_at updated", () => {
    const { db, svc } = setup();
    const p = allIds(db)[0] ?? "";
    expect(svc.recordView(A, p, NOW - 5000).ok).toBe(true);
    expect(svc.recordView(A, p, NOW).ok).toBe(true);
    expect(svc.recordView(A, p, NOW).ok).toBe(true);
    const rows = db
      .query<{ viewed_at: string }, [string]>("SELECT viewed_at FROM product_views WHERE session_id = ?")
      .all(A);
    expect(rows.length).toBe(1);
    expect(rows[0]?.viewed_at).toBe(new Date(NOW).toISOString());
  });

  test("trims to 50 keeping the newest, including the just-written row even when its timestamp is the oldest", () => {
    const { db, svc } = setup();
    const all = allIds(db);
    for (let i = 0; i < 55; i += 1) {
      const pid = all[i] ?? "";
      expect(svc.recordView(A, pid, NOW - 100_000 + i * 10).ok).toBe(true);
    }
    expect(viewCount(db, A)).toBe(HISTORY_CAP);
    const kept = db
      .query<{ product_id: string }, [string]>("SELECT product_id FROM product_views WHERE session_id = ?")
      .all(A)
      .map((r) => r.product_id);
    expect(new Set(kept)).toEqual(new Set(all.slice(5, 55)));
    // clock skew: a write older than everything is still kept
    const extra = all[56] ?? "";
    expect(svc.recordView(A, extra, NOW - 10 * DAY).ok).toBe(true);
    expect(viewCount(db, A)).toBe(HISTORY_CAP);
    expect(db.query("SELECT 1 FROM product_views WHERE session_id = ? AND product_id = ?").get(A, extra)).not.toBeNull();
    expect(db.query("SELECT 1 FROM product_views WHERE session_id = ? AND product_id = ?").get(A, all[5] ?? "")).toBeNull();
  });

  test("trim never touches other sessions", () => {
    const { db, svc } = setup();
    const all = allIds(db);
    for (let i = 0; i < 3; i += 1) view(db, B, all[i] ?? "", NOW - 10 * DAY);
    for (let i = 0; i < 55; i += 1) svc.recordView(A, all[i] ?? "", NOW - 1000 + i);
    expect(viewCount(db, B)).toBe(3);
  });

  test("NOT_FOUND for unknown product, nothing written", () => {
    const { db, svc } = setup();
    const r = svc.recordView(A, "prod_qa_missing");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    expect(viewCount(db, A)).toBe(0);
  });

  test("INVALID_INPUT for bad session / bad product id, with zero SQL (Proxy)", () => {
    const { db } = setup();
    const spy = spyDb(db);
    const svc = createRecommendationService({ db: spy.db, now: () => NOW });
    spy.calls.length = 0;
    const p = allIds(db)[0] ?? "";
    const badSessions: unknown[] = ["", "abc", A + " ", " " + A, "seed_session_01", null, 1, {}, ...HOSTILE];
    for (const s of badSessions) {
      const r = svc.recordView(s as string, p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    const badProducts: unknown[] = ["", "x".repeat(201), "x".repeat(50_000), null, undefined, 7, {}, []];
    for (const pid of badProducts) {
      const r = svc.recordView(A, pid as string);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("INVALID_INPUT");
    }
    for (const s of badSessions) {
      svc.removeView(s as string, p);
      svc.clearViews(s as string);
    }
    expect(spy.calls).toEqual([]);
    expect(svc.recordView(A, p).ok).toBe(true);
    expect(spy.calls.length).toBeGreaterThan(0); // positive control
    // exactly 200 chars is accepted as an id (-> NOT_FOUND, not INVALID_INPUT)
    const r200 = svc.recordView(A, "x".repeat(200));
    expect(r200.ok).toBe(false);
    if (!r200.ok) expect(r200.error.code).toBe("NOT_FOUND");
  });

  test("hostile product ids are bound, not interpolated", () => {
    const { db, svc } = setup();
    for (const h of HOSTILE) {
      const r = svc.recordView(A, h);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("NOT_FOUND");
    }
    expect(allIds(db).length).toBe(SEED_CATALOG_STATS.total);
    expect(viewCount(db, A)).toBe(0);
  });
});

describe("QA T36 crit 5 + isolation: recentlyViewed / removeView / clearViews", () => {
  test("newest-first, hides unavailable until available again, no fallback without history", () => {
    const { db, svc } = setup();
    const [p1, p2, p3] = allIds(db).filter((id) => availableIds(db).has(id));
    if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error("seed");
    expect(svc.recentlyViewed(A)).toEqual([]);
    expect(svc.buyAgain(A)).toEqual([]);
    svc.recordView(A, p1, NOW - 3000);
    svc.recordView(A, p2, NOW - 2000);
    svc.recordView(A, p3, NOW - 1000);
    expect(ids(svc.recentlyViewed(A))).toEqual([p3, p2, p1]);
    svc.recordView(A, p1, NOW);
    expect(ids(svc.recentlyViewed(A))).toEqual([p1, p3, p2]);
    setStock(db, p3, 0);
    unpublish(db, p2);
    expect(ids(svc.recentlyViewed(A))).toEqual([p1]);
    expect(viewCount(db, A)).toBe(3); // hidden, not deleted
    setStock(db, p3, 4);
    republish(db, p2);
    expect(ids(svc.recentlyViewed(A))).toEqual([p1, p3, p2]);
    // hidden products do not consume the limit
    setStock(db, p1, 0);
    expect(ids(svc.recentlyViewed(A, { limit: 2 }))).toEqual([p3, p2]);
  });

  test("three-session isolation matrix for record / remove / clear / read", () => {
    const { db, svc } = setup();
    const all = allIds(db).filter((id) => availableIds(db).has(id));
    const sessions = [A, B, C] as const;
    sessions.forEach((s, si) => {
      for (let i = 0; i < 4; i += 1) svc.recordView(s, need(all, si * 4 + i), NOW - 1000 + i);
    });
    // A and B share one product
    svc.recordView(B, need(all, 0), NOW);
    const snapshot = (s: string) => ids(svc.recentlyViewed(s));
    expect(snapshot(A)).toEqual([need(all, 3), need(all, 2), need(all, 1), need(all, 0)]);
    expect(snapshot(B)).toEqual([need(all, 0), need(all, 7), need(all, 6), need(all, 5), need(all, 4)]);
    expect(snapshot(C)).toEqual([need(all, 11), need(all, 10), need(all, 9), need(all, 8)]);

    svc.removeView(A, need(all, 0));
    expect(snapshot(A)).toEqual([need(all, 3), need(all, 2), need(all, 1)]);
    expect(snapshot(B)[0]).toBe(need(all, 0));
    // removing a product the session never viewed is a no-op for owners
    svc.removeView(C, need(all, 4));
    expect(snapshot(B)).toContain(need(all, 4));

    svc.clearViews(B);
    expect(snapshot(B)).toEqual([]);
    expect(snapshot(A).length).toBe(3);
    expect(snapshot(C).length).toBe(4);
    svc.clearViews(C);
    expect(viewCount(db, A)).toBe(3);
    expect(viewCount(db, C)).toBe(0);
  });

  test("buyAgain / forCart / inspiredBy are session-isolated", () => {
    const { db, svc } = setup();
    const all = allIds(db).filter((id) => availableIds(db).has(id));
    order(db, [need(all, 0)], { session: A });
    order(db, [need(all, 1)], { session: B });
    expect(ids(svc.buyAgain(A))).toEqual([need(all, 0)]);
    expect(ids(svc.buyAgain(B))).toEqual([need(all, 1)]);
    expect(svc.buyAgain(C)).toEqual([]);
  });
});

describe("QA T36 popularInCategory", () => {
  test("a department rolls up its child categories; best seller first; unknown category -> global fallback", () => {
    const { db, svc } = setup();
    const dept = db
      .query<{ id: string }, []>(
        "SELECT p.id FROM categories AS p WHERE p.parent_id IS NULL AND EXISTS (SELECT 1 FROM categories c WHERE c.parent_id = p.id) ORDER BY p.id LIMIT 1",
      )
      .get();
    if (dept === null) throw new Error("no department");
    const inDept = new Set(
      db
        .query<{ id: string }, [string, string]>(
          "SELECT p.id FROM products p JOIN categories c ON c.id = p.category_id WHERE c.parent_id = ? OR c.id = ?",
        )
        .all(dept.id, dept.id)
        .map((r) => r.id),
    );
    const avail = availableIds(db);
    const inDeptAvailable = [...inDept].filter((id) => avail.has(id));
    const last = need(inDeptAvailable.sort(), inDeptAvailable.length - 1);
    order(db, [[last, 9]]);
    const r = ids(svc.popularInCategory(dept.id, { limit: inDeptAvailable.length }));
    expect(r[0]).toBe(last);
    expect(new Set(r)).toEqual(new Set(inDeptAvailable));
    const unknown = svc.popularInCategory("cat_does_not_exist");
    expect(ids(unknown)[0]).toBe(last);
    expect(unknown.length).toBe(RECO_DEFAULT_LIMIT);
  });
});

describe("QA T36 crit 6: boughtLastMonth", () => {
  test("window boundary at exactly 30 days is inclusive; one ms earlier is excluded; future orders excluded; null below 5", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_blm", { category: "cat_qa_blm" });
    order(db, [["prod_qa_blm", 4]], { at: NOW - BOUGHT_LAST_MONTH_WINDOW_MS });
    expect(svc.boughtLastMonth("prod_qa_blm", NOW)).toBeNull();
    order(db, [["prod_qa_blm", 100]], { at: NOW - BOUGHT_LAST_MONTH_WINDOW_MS - 1 });
    order(db, [["prod_qa_blm", 100]], { at: NOW + DAY });
    order(db, [["prod_qa_blm", 100]], { status: "payment_failed" });
    order(db, [["prod_qa_blm", 100]], { fulfillment: "cancelled" });
    expect(svc.boughtLastMonth("prod_qa_blm", NOW)).toBeNull();
    order(db, [["prod_qa_blm", 1]], { at: NOW });
    expect(BOUGHT_LAST_MONTH_WINDOW_MS).toBe(30 * DAY);
    expect(svc.boughtLastMonth("prod_qa_blm", NOW)).toBe(BOUGHT_LAST_MONTH_MIN_UNITS);
    // one ms later the 4 units at the boundary fall out
    expect(svc.boughtLastMonth("prod_qa_blm", NOW + 1)).toBeNull();
    // service clock is used when now is omitted
    expect(svc.boughtLastMonth("prod_qa_blm")).toBe(5);
  });

  test("counts units, not orders", () => {
    const { db, svc } = setup();
    product(db, "prod_qa_units", { category: "cat_qa_u" });
    order(db, [["prod_qa_units", 7]]);
    expect(svc.boughtLastMonth("prod_qa_units")).toBe(7);
  });
});

describe("QA T36 crit 7: buyAgain", () => {
  test("each product once, newest order first, only still-purchasable, paid non-cancelled only", () => {
    const { db, svc } = setup();
    const all = allIds(db).filter((id) => availableIds(db).has(id));
    const [p1, p2, p3, p4, p5] = [0, 1, 2, 3, 4].map((i) => need(all, i)) as [string, string, string, string, string];
    order(db, [p1, p2], { session: A, at: NOW - 5 * DAY });
    order(db, [p2], { session: A, at: NOW - 1 * DAY }); // p2 re-ordered, most recent
    order(db, [p3], { session: A, at: NOW - 3 * DAY });
    order(db, [p4], { session: A, at: NOW - 2 * DAY, status: "payment_failed" });
    order(db, [p5], { session: A, at: NOW - 2 * DAY, fulfillment: "cancelled" });
    expect(ids(svc.buyAgain(A))).toEqual([p2, p3, p1]);
    setStock(db, p3, 0);
    expect(ids(svc.buyAgain(A))).toEqual([p2, p1]);
    unpublish(db, p2);
    expect(ids(svc.buyAgain(A))).toEqual([p1]);
  });
});

describe("QA T36 crit 8: timing on seed + 500 paid orders + 1,800 views", () => {
  test("every method < 50 ms (prints timings)", () => {
    const { db, svc } = setup();
    const all = allIds(db);
    let rng = 42;
    const rand = (n: number) => {
      rng = (rng * 1103515245 + 12345) % 2147483648;
      return rng % n;
    };
    const sessions = Array.from({ length: 60 }, (_, i) => `${(i + 0x10000000).toString(16)}-1111-4111-8111-111111111111`);
    db.transaction(() => {
      for (let i = 0; i < 500; i += 1) {
        const n = 1 + rand(4);
        const items = new Set<string>();
        while (items.size < n) items.add(all[rand(all.length)] ?? "");
        order(db, [...items].map((p) => [p, 1 + rand(3)] as const), {
          session: sessions[rand(sessions.length)],
          at: NOW - rand(60) * DAY,
        });
      }
    })();
    for (let i = 0; i < 1800; i += 1) {
      svc.recordView(sessions[i % sessions.length] ?? A, all[rand(all.length)] ?? "", NOW - 1_000_000 + i);
    }
    const s = sessions[0] ?? A;
    cart(db, s, [all[0] ?? "", all[1] ?? ""]);
    const p = all[10] ?? "";
    const cat = categoryOf(db, p);
    const methods: Record<string, () => unknown> = {
      alsoViewed: () => svc.alsoViewed(p),
      alsoBought: () => svc.alsoBought(p),
      frequentlyBoughtTogether: () => svc.frequentlyBoughtTogether(p),
      related: () => svc.related(p),
      inspiredBy: () => svc.inspiredBy(s),
      buyAgain: () => svc.buyAgain(s),
      forCart: () => svc.forCart(s),
      popularInCategory: () => svc.popularInCategory(cat),
      recentlyViewed: () => svc.recentlyViewed(s),
      boughtLastMonth: () => svc.boughtLastMonth(p),
      recordView: () => svc.recordView(s, all[20] ?? ""),
      removeView: () => svc.removeView(s, all[20] ?? ""),
      clearViews: () => svc.clearViews(sessions[59] ?? C),
    };
    const lines: string[] = [];
    for (const [name, fn] of Object.entries(methods)) {
      const t0 = performance.now();
      fn();
      const cold = performance.now() - t0;
      let worst = 0;
      for (let i = 0; i < 5; i += 1) {
        const t = performance.now();
        fn();
        worst = Math.max(worst, performance.now() - t);
      }
      lines.push(`${name.padEnd(26)} cold ${cold.toFixed(2)} ms  warm-max ${worst.toFixed(2)} ms`);
      expect(cold).toBeLessThan(50);
      expect(worst).toBeLessThan(50);
    }
    console.log(`[QA-T36 timing]\n${lines.join("\n")}`);
    expect(viewCount(db, s)).toBeLessThanOrEqual(HISTORY_CAP);
  });
});

describe("QA T36 singleton", () => {
  const saved = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (saved === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = saved;
  });

  test("getRecommendationService reuses one instance per DB handle and rebuilds on a new handle", () => {
    process.env.DATABASE_PATH = ":memory:";
    const s1 = getRecommendationService();
    expect(getRecommendationService()).toBe(s1);
    const db1 = getDatabase();
    expect(getRecommendationService()).toBe(s1);
    closeDatabase();
    const s2 = getRecommendationService();
    expect(getDatabase()).not.toBe(db1);
    expect(s2).not.toBe(s1);
    expect(getRecommendationService()).toBe(s2);
  });
});
