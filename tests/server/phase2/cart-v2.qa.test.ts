import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "@/lib/result";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { SqliteCartRepository } from "@/server/cart/cart-repository";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import { DefaultCartServiceV2, SHIPPING_METHOD_DROPPED_NOTICE, createCartService, type CartServiceV2, type CartViewV2 } from "@/server/cart/cart-service";
import { createListService } from "@/server/lists/list-service";
import { createCouponService, recordRedemption, type CouponService } from "@/server/pricing/coupon-service";
import { createShippingService } from "@/server/pricing/shipping-service";

// ---------------------------------------------------------------------------
// QA-W2-T45 (T54 part 1): adversarial tests for cart service v2.
// Real SQLite (":memory:" or a temp file DB outside ./data), real list,
// coupon and shipping services. Workers race on separate connections.
// ---------------------------------------------------------------------------

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const DAY_MS = 86_400_000;

const TOTE = "prod_canvas-tote-bag"; // 1999, stock 42
const PIN = "prod_enamel-pin-set"; // 50, stock 100
const SKILLET = "prod_cast-iron-skillet"; // 4999, stock 30
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0

function freshDb(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  return db;
}

function setup(): { db: Database; cart: CartServiceV2 } {
  const db = freshDb();
  return { db, cart: createCartService(db, { now: () => NOW }) };
}

function ok<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function code<T>(r: Result<T>): string {
  return r.ok ? "OK" : r.error.code;
}

function view(cart: CartServiceV2, s: string, now?: number): CartViewV2 {
  return ok(cart.getCartView(s, now));
}

function setStock(db: Database, id: string, stock: number): void {
  db.query("UPDATE products SET stock = ? WHERE id = ?").run(stock, id);
}

function stored(db: Database, s: string): { c: string | null; m: string | null } | null {
  return db
    .query<{ c: string | null; m: string | null }, [string]>(
      "SELECT coupon_code AS c, shipping_method_id AS m FROM carts WHERE session_id = ?",
    )
    .get(s);
}

function lineQty(db: Database, s: string, p: string): number {
  return (
    db
      .query<{ q: number }, [string, string]>("SELECT quantity AS q FROM cart_items WHERE cart_session_id = ? AND product_id = ?")
      .get(s, p)?.q ?? 0
  );
}

function saved(db: Database, s: string): { p: string; q: number }[] {
  return db
    .query<{ p: string; q: number }, [string]>(
      `SELECT li.product_id AS p, li.quantity_desired AS q FROM list_items li
         JOIN lists l ON l.id = li.list_id
        WHERE l.session_id = ? AND l.kind = 'save_for_later' ORDER BY li.product_id`,
    )
    .all(s);
}

function saveForLaterLists(db: Database, s: string): number {
  return (
    db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'save_for_later'")
      .get(s)?.n ?? 0
  );
}

// ---------------------------------------------------------------------------

describe("QA T45 coupon re-validation on read (criterion 5)", () => {
  test("drop is one-time: notice on the dropping read only, stored code cleared", () => {
    const { db, cart } = setup();
    ok(cart.setQuantity(S1, PIN, 60)); // 3000
    expect(ok(cart.applyCoupon(S1, " save5 ")).code).toBe("SAVE5");
    ok(cart.setQuantity(S1, PIN, 10)); // 500 < 2500
    const first = view(cart, S1);
    expect(first.coupon).toBeNull();
    expect(first.couponNotice).toContain("SAVE5");
    expect(first.couponNotice).toContain("$25.00");
    expect(first.totals.discountCents).toBe(0);
    expect(stored(db, S1)?.c).toBeNull();
    const second = view(cart, S1);
    expect(second.couponNotice).toBeNull();
    expect(second.coupon).toBeNull();
    // Growing back over the minimum does not resurrect the dropped code.
    ok(cart.setQuantity(S1, PIN, 60));
    expect(view(cart, S1).coupon).toBeNull();
  });

  test("a newer code applied while the stale one is being re-validated is NOT clobbered", () => {
    const db = freshDb();
    const real = createCouponService({ db, now: () => NOW });
    let inject = true;
    const coupons = new Proxy(real, {
      get(target, prop, receiver) {
        const value: unknown = Reflect.get(target, prop, receiver);
        if (prop !== "validate" || typeof value !== "function") return value;
        return (...args: Parameters<CouponService["validate"]>) => {
          const result = real.validate(...args);
          if (inject && args[0] === "SAVE5") {
            inject = false;
            // Another request (other connection/tab) applies WELCOME10 between our read and our clear.
            db.query("UPDATE carts SET coupon_code = 'WELCOME10' WHERE session_id = ?").run(S1);
          }
          return result;
        };
      },
    });
    const cart = new DefaultCartServiceV2({
      db,
      carts: new SqliteCartRepository(db),
      products: new SqliteProductRepository(db),
      lists: createListService({ db, now: () => new Date(NOW) }),
      coupons,
      shipping: createShippingService({ db }),
      now: () => NOW,
    });
    ok(cart.setQuantity(S1, PIN, 60));
    ok(cart.applyCoupon(S1, "SAVE5"));
    ok(cart.setQuantity(S1, PIN, 10));
    inject = true;
    const first = view(cart, S1);
    expect(first.couponNotice).toContain("SAVE5");
    expect(stored(db, S1)?.c).toBe("WELCOME10");
    const second = view(cart, S1);
    expect(second.coupon?.code).toBe("WELCOME10");
    expect(second.couponNotice).toBeNull();
    expect(second.totals.discountCents).toBe(50);
  });

  test("expired at read time (clock passes expires_at) and exhausted after apply are both dropped with distinct notices", () => {
    const { db, cart } = setup();
    db.query(
      "INSERT INTO coupons (code, kind, value, expires_at, max_uses) VALUES ('QATIME', 'percent', 20, ?, NULL), ('QAONCE', 'fixed', 100, NULL, 1)",
    ).run(new Date(NOW + DAY_MS).toISOString());
    ok(cart.setQuantity(S1, TOTE, 1));
    ok(cart.applyCoupon(S1, "QATIME"));
    expect(view(cart, S1, NOW + DAY_MS - 1).coupon?.code).toBe("QATIME");
    const expired = view(cart, S1, NOW + 2 * DAY_MS);
    expect(expired.coupon).toBeNull();
    expect(expired.couponNotice).toMatch(/expired/);

    ok(cart.setQuantity(S2, TOTE, 1));
    ok(cart.applyCoupon(S2, "QAONCE"));
    db.query("UPDATE coupons SET used_count = 1 WHERE code = 'QAONCE'").run();
    const exhausted = view(cart, S2);
    expect(exhausted.coupon).toBeNull();
    expect(exhausted.couponNotice).toMatch(/no longer available/);
    expect(stored(db, S2)?.c).toBeNull();
  });

  test("deactivated coupon is dropped with the generic notice (no code-specific detail)", () => {
    const { db, cart } = setup();
    ok(cart.setQuantity(S1, TOTE, 1));
    ok(cart.applyCoupon(S1, "WELCOME10"));
    db.query("UPDATE coupons SET is_active = 0 WHERE code = 'WELCOME10'").run();
    const v = view(cart, S1);
    expect(v.couponNotice).toBe("Promo code WELCOME10 is no longer valid and was removed from your cart.");
  });
});

describe("QA T45 applyCoupon errors keep the previous coupon (criterion 4)", () => {
  const cases: readonly [string, string, (db: Database) => void][] = [
    ["unknown", "NOPE123", () => undefined],
    ["garbage charset", "<script>", () => undefined],
    ["zero-width", "SAVE​5", () => undefined],
    ["oversize 33", "A".repeat(33), () => undefined],
    ["expired", "EXPIRED10", () => undefined],
    ["exhausted", "MAXED5", () => undefined],
    ["min subtotal", "SAVE5", () => undefined],
    ["used", "FREESHIP", (db) => void ok(recordRedemption(db, "FREESHIP", S1, "order-qa-1"))],
  ];
  for (const [name, attempt, prepare] of cases) {
    test(`${name}: error returned, WELCOME10 still stored and applied`, () => {
      const { db, cart } = setup();
      ok(cart.setQuantity(S1, TOTE, 1)); // 1999
      ok(cart.setQuantity(S1, PIN, 1)); // 2049: >= FREESHIP min 2000, < SAVE5 min 2500
      ok(cart.applyCoupon(S1, "WELCOME10"));
      prepare(db);
      const r = cart.applyCoupon(S1, attempt);
      expect(r.ok).toBe(false);
      expect(code(r)).toMatch(/^COUPON_/);
      expect(stored(db, S1)?.c).toBe("WELCOME10");
      expect(view(cart, S1).coupon?.code).toBe("WELCOME10");
    });
  }

  test("30 invalid codes share one identical COUPON_INVALID message (no enumeration)", () => {
    const { cart } = setup();
    ok(cart.setQuantity(S1, TOTE, 1));
    const messages = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const r = cart.applyCoupon(S1, i % 3 === 0 ? `QA${i}X` : i % 3 === 1 ? `bad code ${i}` : `ZZ${"9".repeat(i)}`);
      expect(code(r)).toBe("COUPON_INVALID");
      if (!r.ok) {
        messages.add(r.error.message);
        expect(r.error.details).toBeUndefined();
      }
    }
    expect(messages.size).toBe(1);
  });
});

describe("QA T45 empty cart and shipping (criteria 6, 7)", () => {
  test("empty cart, no cart row: shipping null, options [], totals 0", () => {
    const { cart } = setup();
    const v = view(cart, S1);
    expect(v.items).toEqual([]);
    expect(v.shipping).toBeNull();
    expect(v.shippingOptions).toEqual([]);
    expect(v.totals).toEqual({ subtotalCents: 0, discountCents: 0, shippingCents: 0, totalCents: 0, amountToFreeShippingCents: null });
    expect(v.canCheckout).toBe(false);
  });

  test("cart emptied with a coupon + method stored, and only saved items: still no shipping and zero totals", () => {
    const { cart } = setup();
    ok(cart.setQuantity(S1, TOTE, 2));
    ok(cart.applyCoupon(S1, "WELCOME10"));
    ok(cart.selectShippingMethod(S1, "next_day"));
    ok(cart.saveForLater(S1, TOTE));
    const v = view(cart, S1);
    expect(v.items).toEqual([]);
    expect(v.saved.map((s) => s.productId)).toEqual([TOTE]);
    expect(v.shipping).toBeNull();
    expect(v.shippingOptions).toEqual([]);
    expect(v.totals.totalCents).toBe(0);
    expect(v.totals.shippingCents).toBe(0);
  });

  test("default = cheapest; free threshold flips standard to 0 on the next read (3450 -> 3500)", () => {
    const { cart } = setup();
    ok(cart.setQuantity(S1, PIN, 69)); // 3450
    const below = view(cart, S1);
    expect(below.shipping?.method.id).toBe("standard");
    expect(below.totals.shippingCents).toBe(499);
    expect(below.totals.amountToFreeShippingCents).toBe(50);
    expect(below.totals.totalCents).toBe(3450 + 499);
    ok(cart.setQuantity(S1, PIN, 70)); // 3500 exactly
    const at = view(cart, S1);
    expect(at.totals.shippingCents).toBe(0);
    expect(at.totals.totalCents).toBe(3500);
    expect(at.totals.amountToFreeShippingCents).toBe(0);
  });

  // Ruling D-T55-2 (2026-11-07): an inactive stored selection is CLEARED on the
  // next view with a one-time notice, so the view and placement agree.
  test("selected method made inactive: falls back to cheapest, stored id cleared with a one-time notice; reactivated: stays on cheapest until re-selected", () => {
    const { db, cart } = setup();
    ok(cart.setQuantity(S1, TOTE, 1));
    ok(cart.selectShippingMethod(S1, "express"));
    expect(view(cart, S1).shipping?.method.id).toBe("express");
    db.query("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'").run();
    const fallback = view(cart, S1);
    expect(fallback.shipping?.method.id).toBe("standard");
    expect(fallback.shippingOptions.map((o) => o.method.id)).not.toContain("express");
    expect(fallback.shippingNotice).toBe(SHIPPING_METHOD_DROPPED_NOTICE);
    expect(stored(db, S1)?.m ?? null).toBeNull();
    expect(view(cart, S1).shippingNotice ?? null).toBeNull(); // notice is one-time
    db.query("UPDATE shipping_methods SET is_active = 1 WHERE id = 'express'").run();
    expect(view(cart, S1).shipping?.method.id).toBe("standard");
    ok(cart.selectShippingMethod(S1, "express"));
    expect(view(cart, S1).shipping?.method.id).toBe("express");
  });

  test("selectShippingMethod rejects inactive/unknown/hostile ids with INVALID_INPUT and keeps the previous selection", () => {
    const { db, cart } = setup();
    ok(cart.setQuantity(S1, TOTE, 1));
    ok(cart.selectShippingMethod(S1, "next_day"));
    db.query("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'").run();
    const hostile: unknown[] = ["express", "STANDARD", " standard", "", "x".repeat(65), null, 1, {}, ["standard"], "standard'--"];
    for (const id of hostile) {
      const r = cart.selectShippingMethod(S1, id);
      expect(code(r)).toBe("INVALID_INPUT");
      if (!r.ok) expect(r.error.details).toEqual({ field: "shippingMethodId" });
    }
    expect(stored(db, S1)?.m).toBe("next_day");
  });
});

describe("QA T45 saveForLater / moveToCart (criteria 2, 3)", () => {
  test("saveForLater merge keeps the larger quantity in both directions; one list, one item", () => {
    const { db, cart } = setup();
    ok(cart.setQuantity(S1, TOTE, 7));
    ok(cart.saveForLater(S1, TOTE));
    ok(cart.setQuantity(S1, TOTE, 3));
    ok(cart.saveForLater(S1, TOTE));
    expect(saved(db, S1)).toEqual([{ p: TOTE, q: 7 }]);
    ok(cart.setQuantity(S1, TOTE, 9));
    ok(cart.saveForLater(S1, TOTE));
    expect(saved(db, S1)).toEqual([{ p: TOTE, q: 9 }]);
    expect(saveForLaterLists(db, S1)).toBe(1);
    expect(lineQty(db, S1, TOTE)).toBe(0);
  });

  test("saveForLater of an absent / unknown / non-string product: ok, no list created", () => {
    const { db, cart } = setup();
    expect(code(cart.saveForLater(S1, TOTE))).toBe("OK");
    expect(code(cart.saveForLater(S1, "prod_nope"))).toBe("OK");
    expect(code(cart.saveForLater(S1, 42 as never))).toBe("OK");
    expect(saveForLaterLists(db, S1)).toBe(0);
  });

  test("moveToCart adds min(saved, stock left, 99 left)", () => {
    const { db, cart } = setup();
    // saved 3, stock 30, nothing in cart -> 3
    ok(cart.setQuantity(S1, SKILLET, 3));
    ok(cart.saveForLater(S1, SKILLET));
    expect(ok(cart.moveToCart(S1, SKILLET)).quantity).toBe(3);
    expect(saved(db, S1)).toEqual([]);

    // saved 10, stock 12, existing 5 -> stock-limited to 12
    ok(cart.setQuantity(S1, TOTE, 10));
    ok(cart.saveForLater(S1, TOTE));
    setStock(db, TOTE, 12);
    ok(cart.setQuantity(S1, TOTE, 5));
    expect(ok(cart.moveToCart(S1, TOTE)).quantity).toBe(12);
    expect(lineQty(db, S1, TOTE)).toBe(12);

    // saved 5, stock 100, existing 97 -> max-limited to 99
    ok(cart.setQuantity(S2, PIN, 5));
    ok(cart.saveForLater(S2, PIN));
    ok(cart.setQuantity(S2, PIN, 97));
    expect(ok(cart.moveToCart(S2, PIN)).quantity).toBe(99);
    expect(saved(db, S2)).toEqual([]);
  });

  const stays: readonly [string, string, (db: Database, cart: CartServiceV2) => void][] = [
    ["OUT_OF_STOCK", TOTE, (db) => setStock(db, TOTE, 0)],
    ["INSUFFICIENT_STOCK", TOTE, (db, cart) => {
      setStock(db, TOTE, 4);
      ok(cart.setQuantity(S1, TOTE, 4));
    }],
    ["INVALID_QUANTITY", PIN, (_db, cart) => void ok(cart.setQuantity(S1, PIN, 99))],
  ];
  for (const [expected, product, prepare] of stays) {
    test(`moveToCart ${expected}: item stays saved with its quantity, cart line unchanged`, () => {
      const { db, cart } = setup();
      ok(cart.setQuantity(S1, product, 5));
      ok(cart.saveForLater(S1, product));
      prepare(db, cart);
      const before = lineQty(db, S1, product);
      expect(code(cart.moveToCart(S1, product))).toBe(expected);
      expect(saved(db, S1)).toEqual([{ p: product, q: 5 }]);
      expect(lineQty(db, S1, product)).toBe(before);
    });
  }

  test("moveToCart of a never-in-stock product saved via the list service stays saved (OUT_OF_STOCK)", () => {
    const { db, cart } = setup();
    const lists = createListService({ db, now: () => new Date(NOW) });
    const list = ok(lists.ensureSaveForLater(S1));
    ok(lists.addItem(S1, list.id, POUR_OVER, { quantityDesired: 2 }));
    expect(code(cart.moveToCart(S1, POUR_OVER))).toBe("OUT_OF_STOCK");
    expect(saved(db, S1)).toEqual([{ p: POUR_OVER, q: 2 }]);
  });
});

describe("QA T45 concurrency (criterion 9)", () => {
  test("in-process: 50 rounds of Promise.all(addItem, moveToCart) for the last unit never oversell", async () => {
    const { db, cart } = setup();
    for (let round = 0; round < 50; round++) {
      ok(cart.clear(S1));
      setStock(db, SKILLET, 30);
      ok(cart.setQuantity(S1, SKILLET, 1));
      ok(cart.saveForLater(S1, SKILLET));
      setStock(db, SKILLET, 1);
      const ops = round % 2 === 0
        ? [async () => cart.addItem(S1, SKILLET, 1), async () => cart.moveToCart(S1, SKILLET)]
        : [async () => cart.moveToCart(S1, SKILLET), async () => cart.addItem(S1, SKILLET, 1)];
      const results = await Promise.all(ops.map(async (op) => {
        await Promise.resolve();
        return op();
      }));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(lineQty(db, S1, SKILLET)).toBe(1);
      const moveWon = results.some((r) => r.ok && "status" in r.value);
      expect(saved(db, S1)).toEqual(moveWon ? [] : [{ p: SKILLET, q: 1 }]);
    }
  });

  test("two file-DB connections in worker threads, barrier start: last unit never oversold (20 rounds)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-t45-race-"));
    const path = join(dir, "race.sqlite");
    try {
      const db = createDatabase(path);
      runMigrations(db);
      seedDatabase(db, { now: new Date(NOW) });
      const cart = createCartService(db, { now: () => NOW });
      for (let round = 0; round < 20; round++) {
        ok(cart.clear(S1));
        setStock(db, SKILLET, 30);
        ok(cart.setQuantity(S1, SKILLET, 1));
        ok(cart.saveForLater(S1, SKILLET));
        setStock(db, SKILLET, 1);
        const start = new Int32Array(new SharedArrayBuffer(4));
        const ops: readonly ("move" | "add")[] = round % 2 === 0 ? ["move", "add"] : ["add", "move"];
        const pending = Promise.all(
          ops.map(
            (op) =>
              new Promise<{ op: string; ok: boolean; code: string }>((resolve, reject) => {
                const w = new Worker(new URL("./cart-v2-race.qa.worker.ts", import.meta.url).href);
                w.onmessage = (e: MessageEvent<{ op: string; ok: boolean; code: string }>) => {
                  resolve(e.data);
                  w.terminate();
                };
                w.onerror = (e) => reject(new Error(String(e.message)));
                w.postMessage({ path, op, sessionId: S1, productId: SKILLET, quantity: 1, start, now: NOW });
              }),
          ),
        );
        // Let both workers open their connections, then release them together.
        Atomics.store(start, 0, 1);
        Atomics.notify(start, 0);
        const results = await pending;
        for (const r of results) expect(r.code).not.toMatch(/^THROW/);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(lineQty(db, S1, SKILLET)).toBe(1);
        const moveWon = results.some((r) => r.ok && r.op === "move");
        expect(saved(db, S1)).toEqual(moveWon ? [] : [{ p: SKILLET, q: 1 }]);
      }
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
// T54 criterion 1: 250 random carts / coupons / shipping combos.
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFrom(rand: () => number): string {
  const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(rand() * 4)]}${hex(3)}-${hex(12)}`;
}

describe("QA T54 criterion 1: property test", () => {
  test("250 random carts: total = subtotal - discount + shipping, total >= 0, matches an independent oracle", () => {
    const rand = prng(0x5eed45);
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;

    const db = freshDb();
    const products = db
      .query<{ id: string; price_cents: number }, []>("SELECT id, price_cents FROM products ORDER BY id")
      .all();
    // Extra coupons covering every kind, large fixed values, high minimums, windows and caps.
    const insert = db.query(
      "INSERT INTO coupons (code, kind, value, min_subtotal_cents, max_uses, used_count, starts_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const codes: string[] = ["WELCOME10", "SAVE5", "FREESHIP", "EXPIRED10", "MAXED5", "NOPE", "bad code"];
    for (let i = 0; i < 25; i++) {
      const kind = pick(["percent", "fixed", "free_shipping"] as const);
      const value = kind === "percent" ? int(1, 100) : kind === "fixed" ? pick([1, 99, 500, 5000, 99_999_999]) : 0;
      const maxUses = rand() < 0.2 ? 1 : null;
      const used = maxUses !== null && rand() < 0.5 ? 1 : 0;
      const starts = rand() < 0.2 ? new Date(NOW + int(-5, 5) * DAY_MS).toISOString() : null;
      const expires = rand() < 0.3 ? new Date(NOW + int(-5, 5) * DAY_MS).toISOString() : null;
      const c = `QAP${i}`;
      insert.run(c, kind, value, pick([0, 0, 1000, 2500, 10_000, 500_000]), maxUses, used, starts, expires);
      codes.push(c);
    }
    const methodIds = ["standard", "express", "next_day", "bogus", ""];

    let nonEmpty = 0;
    let withDiscount = 0;
    let freeShip = 0;
    for (let iter = 0; iter < 250; iter++) {
      // Random catalogue + shipping config for this iteration.
      for (const p of products) setStock(db, p.id, pick([0, 1, 3, 30, 100]));
      db.query("UPDATE shipping_methods SET is_active = ?, free_over_cents = ? WHERE id = 'standard'").run(
        rand() < 0.85 ? 1 : 0,
        pick([null, 0, 3500, 20_000]),
      );
      db.query("UPDATE shipping_methods SET is_active = ? WHERE id = 'express'").run(rand() < 0.7 ? 1 : 0);
      db.query("UPDATE shipping_methods SET is_active = ?, price_cents = ? WHERE id = 'next_day'").run(
        rand() < 0.8 ? 1 : 0,
        pick([0, 1999, 450]),
      );

      const s = uuidFrom(rand);
      const cart = createCartService(db, { now: () => NOW });
      const lines = int(0, 6);
      for (let l = 0; l < lines; l++) cart.setQuantity(s, pick(products).id, int(1, 99));
      if (rand() < 0.6) cart.applyCoupon(s, pick(codes), NOW + int(-3, 3) * DAY_MS);
      if (rand() < 0.6) cart.selectShippingMethod(s, pick(methodIds));
      // Mutate after applying (shrink, stock drop) so re-validation paths run.
      if (rand() < 0.3) for (const p of products.slice(0, int(0, products.length))) setStock(db, p.id, pick([0, 1, 2]));
      if (rand() < 0.2 && lines > 0) cart.saveForLater(s, pick(products).id);

      const readAt = NOW + int(-3, 3) * DAY_MS;
      const v = view(cart, s, readAt);
      const t = v.totals;
      const ctx = JSON.stringify({ iter, t, coupon: v.coupon, ship: v.shipping?.method.id, items: v.items.length });

      // The property.
      expect(t.totalCents, ctx).toBe(t.subtotalCents - t.discountCents + t.shippingCents);
      expect(t.totalCents, ctx).toBeGreaterThanOrEqual(0);
      expect(Number.isSafeInteger(t.totalCents), ctx).toBe(true);
      expect(t.discountCents, ctx).toBeLessThanOrEqual(t.subtotalCents);
      expect(t.discountCents, ctx).toBeGreaterThanOrEqual(0);
      expect(t.shippingCents, ctx).toBeGreaterThanOrEqual(0);

      // Subtotal consistent with the lines (billable = min(qty, stock)).
      expect(t.subtotalCents, ctx).toBe(v.subtotalCents);
      expect(v.subtotalCents, ctx).toBe(v.items.reduce((n, i) => n + i.unitPriceCents * Math.min(i.quantity, i.availableStock), 0));

      // Independent oracle for discount and shipping.
      const c = v.coupon;
      const discount =
        c === null
          ? 0
          : c.kind === "percent"
            ? Math.floor((t.subtotalCents * c.value) / 100)
            : c.kind === "fixed"
              ? Math.min(c.value, t.subtotalCents)
              : 0;
      expect(t.discountCents, ctx).toBe(discount);
      if (v.items.length === 0) {
        expect(v.shipping, ctx).toBeNull();
        expect(v.shippingOptions, ctx).toEqual([]);
        expect(t.shippingCents, ctx).toBe(0);
      } else {
        nonEmpty++;
        const options = v.shippingOptions;
        if (options.length === 0) {
          expect(v.shipping, ctx).toBeNull();
          expect(t.shippingCents, ctx).toBe(0);
        } else {
          const sel = stored(db, s)?.m ?? null;
          const selectedActive = options.find((o) => o.method.id === sel);
          const expectedMethod = selectedActive ?? options.reduce((a, b) => (b.priceCents < a.priceCents ? b : a));
          expect(v.shipping?.method.id, ctx).toBe(expectedMethod.method.id);
          const m = expectedMethod.method;
          const price = m.freeOverCents !== null && t.subtotalCents >= m.freeOverCents ? 0 : m.priceCents;
          expect(t.shippingCents, ctx).toBe(c?.kind === "free_shipping" ? 0 : price);
          if (c?.kind === "free_shipping") freeShip++;
        }
      }
      if (t.discountCents > 0) withDiscount++;
      // The coupon reported as applied is what is stored after the read.
      expect(stored(db, s)?.c ?? null, ctx).toBe(c?.code ?? null);
    }
    // The generator really exercised the interesting space.
    expect(nonEmpty).toBeGreaterThan(100);
    expect(withDiscount).toBeGreaterThan(20);
    expect(freeShip).toBeGreaterThan(3);
  });
});

describe("QA T45 isolation (criterion 8)", () => {
  test("two sessions never share coupon, shipping or saved items; B cannot remove/move A's state", () => {
    const { db, cart } = setup();
    ok(cart.setQuantity(S1, TOTE, 2));
    ok(cart.setQuantity(S1, SKILLET, 1));
    ok(cart.applyCoupon(S1, "WELCOME10"));
    ok(cart.selectShippingMethod(S1, "next_day"));
    ok(cart.saveForLater(S1, SKILLET));
    ok(cart.setQuantity(S2, PIN, 1));
    const b = view(cart, S2);
    expect(b.coupon).toBeNull();
    expect(b.couponNotice).toBeNull();
    expect(b.shipping?.method.id).toBe("standard");
    expect(b.saved).toEqual([]);
    // B acting on A's things only affects B.
    expect(code(cart.moveToCart(S2, SKILLET))).toBe("NOT_FOUND");
    ok(cart.removeCoupon(S2));
    ok(cart.selectShippingMethod(S2, "express"));
    ok(cart.saveForLater(S2, TOTE)); // B has no TOTE line: no-op
    const a = view(cart, S1);
    expect(a.coupon?.code).toBe("WELCOME10");
    expect(a.shipping?.method.id).toBe("next_day");
    expect(a.saved.map((x) => x.productId)).toEqual([SKILLET]);
    expect(a.items.map((i) => i.productId)).toEqual([TOTE]);
    expect(saved(db, S2)).toEqual([]);
  });

  test("unknown and malformed sessions: empty view, no rows written", () => {
    const { db, cart } = setup();
    const unknown = "33333333-3333-4333-8333-333333333333";
    expect(view(cart, unknown)).toMatchObject({ items: [], saved: [], coupon: null, shipping: null, shippingOptions: [] });
    for (const bad of ["", "not-a-uuid", "' OR 1=1 --", S1.toUpperCase().replace("4111", "1111")]) {
      expect(view(cart, bad).items).toEqual([]);
      expect(code(cart.applyCoupon(bad, "WELCOME10"))).toBe("INVALID_INPUT");
      expect(code(cart.selectShippingMethod(bad, "standard"))).toBe("INVALID_INPUT");
      expect(code(cart.saveForLater(bad, TOTE))).toBe("INVALID_INPUT");
      expect(code(cart.moveToCart(bad, TOTE))).toBe("INVALID_INPUT");
      expect(code(cart.removeCoupon(bad))).toBe("INVALID_INPUT");
    }
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM carts").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM lists").get()?.n).toBe(0);
  });
});
