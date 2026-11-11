import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { SqliteProductRepository } from "@/server/catalog/product-repository";
import {
  MAX_ALERTS_PER_SESSION,
  createStockAlertService,
  getStockAlertService,
  type StockAlertService,
} from "./stock-alert-service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

function setup(): { db: Database; service: StockAlertService; pourOver: string; inStock: string } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const products = new SqliteProductRepository(db);
  const pourOver = products.getBySlug("ceramic-pour-over");
  const tote = products.getBySlug("canvas-tote-bag");
  if (pourOver === null || tote === null) throw new Error("seed changed");
  expect(pourOver.stock).toBe(0);
  expect(tote.stock).toBeGreaterThan(0);
  return { db, service: createStockAlertService({ db }), pourOver: pourOver.id, inStock: tote.id };
}

/** Adds `n` out-of-stock fixture products and returns their ids. */
function addOutOfStock(db: Database, n: number, prefix = "oos"): string[] {
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 1000, 'USD', '/x.svg', 0)",
  );
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}-${i}`;
    insert.run(id, `${id}-slug`, `Fixture ${id}`);
    ids.push(id);
  }
  return ids;
}

function alertRows(db: Database) {
  return db.query("SELECT * FROM stock_alerts ORDER BY id").all();
}

function setStock(db: Database, productId: string, stock: number) {
  db.query("UPDATE products SET stock = ? WHERE id = ?").run(stock, productId);
}

describe("subscribe (criteria 1-3)", () => {
  test("out-of-stock product creates an alert", () => {
    const { db, service, pourOver } = setup();
    const r = service.subscribe(S1, pourOver, T0);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.alreadyRegistered).toBe(false);
    expect(r.value.alert).toEqual({
      id: r.value.alert.id,
      productId: pourOver,
      createdAt: "2026-11-07T10:00:00.000Z",
      acknowledgedAt: null,
    });
    expect(r.value.alert.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(alertRows(db)).toHaveLength(1);
  });

  test("in-stock product -> INVALID_INPUT already_available, nothing written", () => {
    const { db, service, inStock } = setup();
    const r = service.subscribe(S1, inStock, T0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.details?.reason).toBe("already_available");
    expect(alertRows(db)).toHaveLength(0);
  });

  test("unknown / hostile / empty product id -> PRODUCT_NOT_FOUND", () => {
    const { db, service } = setup();
    for (const id of ["nope", "", "' OR 1=1 --", "x".repeat(10_000)]) {
      const r = service.subscribe(S1, id, T0);
      expect(r.ok ? null : r.error.code).toBe("PRODUCT_NOT_FOUND");
    }
    expect(alertRows(db)).toHaveLength(0);
  });

  test("non-string product id from the wire -> INVALID_INPUT", () => {
    const { service } = setup();
    for (const bad of [null, undefined, 42, {}]) {
      const r = service.subscribe(S1, bad as unknown as string, T0);
      expect(r.ok ? null : r.error.code).toBe("INVALID_INPUT");
    }
  });

  test("invalid session -> INVALID_INPUT before any DB work", () => {
    const { db, service, pourOver } = setup();
    for (const bad of ["", "not-a-uuid", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", null as unknown as string]) {
      const r = service.subscribe(bad, pourOver, T0);
      expect(r.ok ? null : r.error.code).toBe("INVALID_INPUT");
    }
    expect(alertRows(db)).toHaveLength(0);
  });

  test("duplicate subscribe is idempotent and returns the existing alert", () => {
    const { db, service, pourOver } = setup();
    const first = service.subscribe(S1, pourOver, T0);
    const second = service.subscribe(S1, pourOver, T0 + 60_000);
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(second.value.alreadyRegistered).toBe(true);
    expect(second.value.alert).toEqual(first.value.alert);
    expect(alertRows(db)).toHaveLength(1);
  });

  test("duplicate after restock still returns the existing alert (not already_available)", () => {
    const { db, service, pourOver } = setup();
    service.subscribe(S1, pourOver, T0);
    setStock(db, pourOver, 5);
    const r = service.subscribe(S1, pourOver, T0);
    expect(r.ok && r.value.alreadyRegistered).toBe(true);
  });

  test("21st alert -> LIMIT_REACHED; duplicate at the limit is still idempotent", () => {
    const { db, service } = setup();
    const ids = addOutOfStock(db, MAX_ALERTS_PER_SESSION + 1);
    for (const id of ids.slice(0, MAX_ALERTS_PER_SESSION)) {
      expect(service.subscribe(S1, id, T0).ok).toBe(true);
    }
    const r = service.subscribe(S1, ids[MAX_ALERTS_PER_SESSION] ?? "", T0);
    expect(r.ok ? null : r.error.code).toBe("LIMIT_REACHED");
    if (!r.ok) expect(r.error.details?.limit).toBe(20);
    expect(service.countFor(S1)).toBe(20);
    const dup = service.subscribe(S1, ids[0] ?? "", T0);
    expect(dup.ok && dup.value.alreadyRegistered).toBe(true);
    // The limit is per session.
    expect(service.subscribe(S2, ids[MAX_ALERTS_PER_SESSION] ?? "", T0).ok).toBe(true);
  });

  test("unsubscribing frees a slot under the limit", () => {
    const { db, service } = setup();
    const ids = addOutOfStock(db, MAX_ALERTS_PER_SESSION + 1);
    let lastId = "";
    for (const id of ids.slice(0, MAX_ALERTS_PER_SESSION)) {
      const r = service.subscribe(S1, id, T0);
      if (r.ok) lastId = r.value.alert.id;
    }
    expect(service.unsubscribe(S1, lastId).ok).toBe(true);
    expect(service.subscribe(S1, ids[MAX_ALERTS_PER_SESSION] ?? "", T0).ok).toBe(true);
  });

  test("concurrent Promise.all of 25 subscribes to distinct products ends at exactly 20", async () => {
    const { db, service } = setup();
    const ids = addOutOfStock(db, 25);
    const results = await Promise.all(ids.map(async (id) => service.subscribe(S1, id, T0)));
    expect(results.filter((r) => r.ok)).toHaveLength(20);
    const failures = results.filter((r) => !r.ok);
    expect(failures).toHaveLength(5);
    for (const f of failures) expect(f.ok ? null : f.error.code).toBe("LIMIT_REACHED");
    expect(service.countFor(S1)).toBe(20);
    expect(db.query("SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?").get(S1)).toEqual({ n: 20 });
  });

  test("concurrent duplicate subscribes create one row", async () => {
    const { db, service, pourOver } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, async () => service.subscribe(S1, pourOver, T0)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.value.alreadyRegistered)).toHaveLength(1);
    expect(alertRows(db)).toHaveLength(1);
  });

  test("invalid now throws RangeError (programmer error)", () => {
    const { service, pourOver } = setup();
    expect(() => service.subscribe(S1, pourOver, Number.NaN)).toThrow(RangeError);
  });
});

describe("list / status (criterion 4)", () => {
  test("waiting while stock is 0, back_in_stock once stock > 0, with no write to stock_alerts", () => {
    const { db, service, pourOver } = setup();
    service.subscribe(S1, pourOver, T0);
    const [before] = service.list(S1);
    expect(before?.status).toBe("waiting");
    expect(before?.product).toMatchObject({ id: pourOver, slug: "ceramic-pour-over", stock: 0, currency: "USD" });

    const snapshot = alertRows(db);
    db.query("CREATE TEMP TABLE alert_writes (n INTEGER)").run();
    db.query(
      "CREATE TEMP TRIGGER alert_upd AFTER UPDATE ON main.stock_alerts BEGIN INSERT INTO alert_writes VALUES (1); END",
    ).run();
    setStock(db, pourOver, 3);

    const [after] = service.list(S1);
    expect(after?.status).toBe("back_in_stock");
    expect(after?.product?.stock).toBe(3);
    expect(service.listBackInStock(S1).map((v) => v.id)).toEqual([after?.id ?? ""]);
    expect(alertRows(db)).toEqual(snapshot);
    expect(db.query("SELECT COUNT(*) AS n FROM alert_writes").get()).toEqual({ n: 0 });

    setStock(db, pourOver, 0);
    expect(service.list(S1)[0]?.status).toBe("waiting");
    expect(service.listBackInStock(S1)).toEqual([]);
  });

  test("newest first; view keys exclude session ids", () => {
    const { db, service } = setup();
    const [a, b, c] = addOutOfStock(db, 3);
    service.subscribe(S1, a ?? "", T0);
    service.subscribe(S1, b ?? "", T0 + 2000);
    service.subscribe(S1, c ?? "", T0 + 1000);
    const views = service.list(S1);
    expect(views.map((v) => v.productId)).toEqual([b ?? "", c ?? "", a ?? ""]);
    for (const v of views) {
      expect(Object.keys(v).sort()).toEqual(["acknowledgedAt", "available", "createdAt", "id", "product", "productId", "status"]);
      expect(Object.keys(v.product ?? {}).sort()).toEqual(["currency", "id", "imageUrl", "name", "priceCents", "slug", "stock"]);
    }
    expect(JSON.stringify(views)).not.toContain(S1);
  });

  test("invalid or unknown session lists nothing", () => {
    const { service, pourOver } = setup();
    service.subscribe(S1, pourOver, T0);
    for (const s of ["", "nope", S2]) {
      expect(service.list(s)).toEqual([]);
      expect(service.listBackInStock(s)).toEqual([]);
      expect(service.countFor(s)).toBe(0);
      expect(service.isSubscribed(s, pourOver)).toBe(false);
    }
  });

  test("isSubscribed and countFor", () => {
    const { service, pourOver, inStock } = setup();
    expect(service.isSubscribed(S1, pourOver)).toBe(false);
    service.subscribe(S1, pourOver, T0);
    expect(service.isSubscribed(S1, pourOver)).toBe(true);
    expect(service.isSubscribed(S1, inStock)).toBe(false);
    expect(service.isSubscribed(S1, "")).toBe(false);
    expect(service.isSubscribed(S1, 7 as unknown as string)).toBe(false);
    expect(service.countFor(S1)).toBe(1);
  });
});

describe("publication (D-T98-4, R-CART-1 family)", () => {
  function setPublishedAt(db: Database, productId: string, value: string) {
    db.query("UPDATE products SET published_at = ? WHERE id = ?").run(value, productId);
  }

  test("published product: real slug and available true", () => {
    const { service, pourOver } = setup();
    service.subscribe(S1, pourOver, T0);
    const [view] = service.list(S1, T0);
    expect(view?.available).toBe(true);
    expect(view?.product?.slug).toBe("ceramic-pour-over");
  });

  test("future-dated or empty published_at at `now`: slug \"\", available false, alert kept (stop/acknowledge still work)", () => {
    const { db, service, pourOver } = setup();
    const sub = service.subscribe(S1, pourOver, T0);
    if (!sub.ok) throw new Error("subscribe failed");
    for (const value of ["2999-01-01T00:00:00.000Z", ""]) {
      setPublishedAt(db, pourOver, value);
      const [view] = service.list(S1, T0);
      expect(view?.id).toBe(sub.value.alert.id);
      expect(view?.available).toBe(false);
      expect(view?.product?.slug).toBe("");
      expect(view?.product?.name.length).toBeGreaterThan(0);
      expect(view?.product?.id).toBe(pourOver);
    }
    // Back in stock while unpublished: still in the banner list (acknowledge clears it), but unlinked.
    setStock(db, pourOver, 2);
    const banner = service.listBackInStock(S1, T0);
    expect(banner.map((v) => [v.id, v.status, v.available, v.product?.slug])).toEqual([[sub.value.alert.id, "back_in_stock", false, ""]]);
    expect(service.acknowledge(S1, sub.value.alert.id, T0).ok).toBe(true);
    expect(service.listBackInStock(S1, T0)).toEqual([]);
    expect(service.unsubscribe(S1, sub.value.alert.id).ok).toBe(true);
    expect(service.list(S1, T0)).toEqual([]);
  });

  test("publication is judged at the injected `now` (boundary inclusive), never the wall clock", () => {
    const { db, pourOver } = setup();
    const publishAt = "2030-01-01T00:00:00.000Z";
    setPublishedAt(db, pourOver, publishAt);
    let clock = Date.parse(publishAt) - 1;
    const service = createStockAlertService({ db, now: () => clock });
    service.subscribe(S1, pourOver);
    expect(service.list(S1)[0]?.available).toBe(false);
    clock = Date.parse(publishAt);
    expect(service.list(S1)[0]?.available).toBe(true);
    expect(service.list(S1)[0]?.product?.slug).toBe("ceramic-pour-over");
    // An explicit `now` wins over the clock.
    expect(service.list(S1, Date.parse(publishAt) - 1)[0]?.available).toBe(false);
    // subscribe without `now` stamps the injected clock.
    expect(service.list(S1)[0]?.createdAt).toBe(new Date(Date.parse(publishAt) - 1).toISOString());
  });

  test("an injected publication lookup is used with the ISO cutoff of `now`", () => {
    const { db, pourOver } = setup();
    const seen: Array<[readonly string[], string]> = [];
    const service = createStockAlertService({
      db,
      publication: {
        filterPublishedIds(ids, nowIso) {
          seen.push([ids, nowIso]);
          return new Set<string>();
        },
      },
    });
    service.subscribe(S1, pourOver, T0);
    expect(service.list(S1, T0)[0]?.available).toBe(false);
    expect(seen).toEqual([[[pourOver], new Date(T0).toISOString()]]);
  });

  test("non-finite `now` on list throws RangeError; invalid session returns [] without reading the clock", () => {
    const { db, service, pourOver } = setup();
    service.subscribe(S1, pourOver, T0);
    expect(() => service.list(S1, Number.NaN)).toThrow(RangeError);
    expect(() => service.listBackInStock(S1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    let reads = 0;
    const counted = createStockAlertService({
      db,
      now: () => {
        reads += 1;
        return T0;
      },
    });
    expect(counted.list("nope")).toEqual([]);
    expect(reads).toBe(0);
  });
});

describe("acknowledge (criterion 4)", () => {
  test("sets acknowledged_at and hides the alert from the banner list only", () => {
    const { db, service, pourOver } = setup();
    const sub = service.subscribe(S1, pourOver, T0);
    if (!sub.ok) throw new Error("expected ok");
    setStock(db, pourOver, 2);
    expect(service.listBackInStock(S1)).toHaveLength(1);

    const ack = service.acknowledge(S1, sub.value.alert.id, T0 + 5000);
    if (!ack.ok) throw new Error(JSON.stringify(ack.error));
    expect(ack.value.acknowledgedAt).toBe("2026-11-07T10:00:05.000Z");
    expect(service.listBackInStock(S1)).toEqual([]);
    const [view] = service.list(S1);
    expect(view?.status).toBe("back_in_stock");
    expect(view?.acknowledgedAt).toBe("2026-11-07T10:00:05.000Z");
  });

  test("allowed while waiting; repeating keeps the first timestamp", () => {
    const { service, pourOver } = setup();
    const sub = service.subscribe(S1, pourOver, T0);
    if (!sub.ok) throw new Error("expected ok");
    expect(service.acknowledge(S1, sub.value.alert.id, T0 + 1000).ok).toBe(true);
    const again = service.acknowledge(S1, sub.value.alert.id, T0 + 9000);
    expect(again.ok && again.value.acknowledgedAt).toBe("2026-11-07T10:00:01.000Z");
  });

  test("foreign, unknown, malformed id -> NOT_FOUND; invalid session -> INVALID_INPUT", () => {
    const { db, service, pourOver } = setup();
    const sub = service.subscribe(S1, pourOver, T0);
    if (!sub.ok) throw new Error("expected ok");
    for (const id of [sub.value.alert.id, "nope", "", "x".repeat(10_000), 5 as unknown as string]) {
      const r = service.acknowledge(S2, id, T0);
      expect(r.ok ? null : r.error.code).toBe("NOT_FOUND");
    }
    const bad = service.acknowledge("not-a-uuid", sub.value.alert.id, T0);
    expect(bad.ok ? null : bad.error.code).toBe("INVALID_INPUT");
    expect(db.query("SELECT acknowledged_at AS a FROM stock_alerts").get()).toEqual({ a: null });
  });
});

describe("unsubscribe (criterion 5)", () => {
  test("removes the row", () => {
    const { db, service, pourOver } = setup();
    const sub = service.subscribe(S1, pourOver, T0);
    if (!sub.ok) throw new Error("expected ok");
    expect(service.unsubscribe(S1, sub.value.alert.id)).toEqual({ ok: true, value: undefined });
    expect(alertRows(db)).toHaveLength(0);
    const again = service.unsubscribe(S1, sub.value.alert.id);
    expect(again.ok ? null : again.error.code).toBe("NOT_FOUND");
  });

  test("another session's id -> NOT_FOUND and the row survives", () => {
    const { db, service, pourOver } = setup();
    const sub = service.subscribe(S1, pourOver, T0);
    if (!sub.ok) throw new Error("expected ok");
    const r = service.unsubscribe(S2, sub.value.alert.id);
    expect(r.ok ? null : r.error.code).toBe("NOT_FOUND");
    expect(alertRows(db)).toHaveLength(1);
  });

  test("malformed id -> NOT_FOUND; invalid session -> INVALID_INPUT", () => {
    const { service } = setup();
    for (const id of ["", "x".repeat(10_000), "' OR 1=1 --", null as unknown as string]) {
      const r = service.unsubscribe(S1, id);
      expect(r.ok ? null : r.error.code).toBe("NOT_FOUND");
    }
    const r = service.unsubscribe("nope", "x");
    expect(r.ok ? null : r.error.code).toBe("INVALID_INPUT");
  });
});

describe("session isolation", () => {
  test("two sessions never see each other's alerts", () => {
    const { db, service, pourOver } = setup();
    const [other] = addOutOfStock(db, 1);
    const a = service.subscribe(S1, pourOver, T0);
    const b = service.subscribe(S2, pourOver, T0);
    const c = service.subscribe(S2, other ?? "", T0);
    if (!a.ok || !b.ok || !c.ok) throw new Error("expected ok");
    expect(a.value.alert.id).not.toBe(b.value.alert.id);
    expect(service.list(S1).map((v) => v.id)).toEqual([a.value.alert.id]);
    expect(service.list(S2).map((v) => v.id).sort()).toEqual([b.value.alert.id, c.value.alert.id].sort());
    expect(service.countFor(S1)).toBe(1);
    expect(service.countFor(S2)).toBe(2);
    expect(service.isSubscribed(S1, other ?? "")).toBe(false);
    expect(service.unsubscribe(S1, c.value.alert.id).ok).toBe(false);
    expect(service.countFor(S2)).toBe(2);
  });
});

describe("no email anywhere", () => {
  test("stock_alerts has no email column", () => {
    const { db } = setup();
    const cols = db.query<{ name: string }, []>("PRAGMA table_info(stock_alerts)").all().map((c) => c.name);
    expect(cols.sort()).toEqual(["acknowledged_at", "created_at", "id", "product_id", "session_id"]);
  });
});

describe("getStockAlertService", () => {
  const saved = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (saved === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = saved;
  });

  test("is a singleton over getDatabase() and rebuilds when the handle changes", () => {
    process.env.DATABASE_PATH = ":memory:";
    const first = getStockAlertService();
    expect(getStockAlertService()).toBe(first);
    expect(getDatabase()).toBeDefined();
    closeDatabase();
    expect(getStockAlertService()).not.toBe(first);
  });
});
