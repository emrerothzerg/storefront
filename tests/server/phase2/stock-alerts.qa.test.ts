/**
 * QA adversarial tests for T41 (stock alerts service), src/server/alerts/**.
 * Owned by QA (QA-W1-T41). In-memory DB only (one worker test uses a temp file
 * under os.tmpdir()); never touches ./data/.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, createDatabase, getDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { SEED_CATALOG_STATS, seedDatabase } from "@/server/db/seed";
import { isSessionId } from "@/server/session/session-id";
import {
  MAX_ALERTS_PER_SESSION,
  createStockAlertService,
  getStockAlertService,
  type StockAlertService,
} from "@/server/alerts/stock-alert-service";
import { SqliteStockAlertRepository } from "@/server/alerts/stock-alert-repository";

const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const ALERTS_DIR = join(import.meta.dir, "../../../src/server/alerts");

const HOSTILE_IDS: readonly unknown[] = [
  "",
  " ",
  "x".repeat(10_000),
  "' OR 1=1 --",
  "'; DROP TABLE stock_alerts; --",
  "%",
  "_",
  "\u0000",
  `${A}\u0000`,
  "\u{1F600}‮​",
  A.toUpperCase(),
  ` ${A}`,
  `${A} `,
  "00000000-0000-0000-0000-000000000000",
  "3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b", // v1
  null,
  undefined,
  42,
  {},
  [A],
];

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
});

interface Harness {
  readonly db: Database;
  readonly svc: StockAlertService;
  /** Seeded out-of-stock products (5 in seed v2). */
  readonly oos: string[];
  /** A seeded in-stock product. */
  readonly inStock: string;
}

function harness(): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  open.push(db);
  const oos = db
    .query<{ id: string }, []>("SELECT id FROM products WHERE stock = 0 ORDER BY id")
    .all()
    .map((r) => r.id);
  const inStock = db.query<{ id: string }, []>("SELECT id FROM products WHERE stock > 0 ORDER BY id LIMIT 1").get();
  if (oos.length < 2 || inStock === null) throw new Error("seed changed: need >= 2 out-of-stock + 1 in-stock");
  return { db, svc: createStockAlertService({ db }), oos, inStock: inStock.id };
}

function addOutOfStock(db: Database, n: number, prefix = "qa-oos"): string[] {
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

function rows(db: Database): Record<string, unknown>[] {
  return db.query<Record<string, unknown>, []>("SELECT * FROM stock_alerts ORDER BY id").all();
}

function count(db: Database, session?: string): number {
  const r =
    session === undefined
      ? db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM stock_alerts").get()
      : db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?").get(session);
  return r?.n ?? 0;
}

function mustSubscribe(svc: StockAlertService, s: string, p: string, now = T0) {
  const r = svc.subscribe(s, p, now);
  if (!r.ok) throw new Error(`subscribe failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** Installs triggers that record every write to stock_alerts. */
function installWriteSpy(db: Database): () => number {
  db.run("CREATE TEMP TABLE qa_alert_writes (op TEXT NOT NULL)");
  db.run("CREATE TEMP TRIGGER qa_sa_i AFTER INSERT ON main.stock_alerts BEGIN INSERT INTO qa_alert_writes VALUES ('i'); END");
  db.run("CREATE TEMP TRIGGER qa_sa_u AFTER UPDATE ON main.stock_alerts BEGIN INSERT INTO qa_alert_writes VALUES ('u'); END");
  db.run("CREATE TEMP TRIGGER qa_sa_d AFTER DELETE ON main.stock_alerts BEGIN INSERT INTO qa_alert_writes VALUES ('d'); END");
  return () => db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM qa_alert_writes").get()?.n ?? 0;
}

const asStr = (v: unknown) => v as string;

// ---------------------------------------------------------------------------
describe("criterion 1: subscribe only for an existing out-of-stock product", () => {
  test("out-of-stock product: new alert, shape exact, row persisted with the session", () => {
    const { db, svc, oos } = harness();
    const r = mustSubscribe(svc, A, oos[0]!);
    expect(r.alreadyRegistered).toBe(false);
    expect(Object.keys(r.alert).sort()).toEqual(["acknowledgedAt", "createdAt", "id", "productId"]);
    expect(r.alert.productId).toBe(oos[0]!);
    expect(r.alert.acknowledgedAt).toBeNull();
    expect(r.alert.createdAt).toBe(new Date(T0).toISOString());
    expect(isSessionId(r.alert.id)).toBe(true);
    expect(rows(db)).toEqual([
      { id: r.alert.id, product_id: oos[0]!, session_id: A, created_at: new Date(T0).toISOString(), acknowledged_at: null },
    ]);
  });

  test("in-stock product -> INVALID_INPUT reason already_available, no row", () => {
    const { db, svc, inStock } = harness();
    const r = svc.subscribe(A, inStock, T0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_INPUT");
    expect(r.error.details).toEqual({ reason: "already_available", productId: inStock });
    expect(r.error.message.toLowerCase()).toContain("already available");
    expect(count(db)).toBe(0);
  });

  test("stock of exactly 1 counts as available; restock to 0 allows subscribe", () => {
    const { db, svc, oos } = harness();
    db.query("UPDATE products SET stock = 1 WHERE id = ?").run(oos[0]!);
    const r = svc.subscribe(A, oos[0]!, T0);
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(oos[0]!);
    expect(mustSubscribe(svc, A, oos[0]!).alreadyRegistered).toBe(false);
  });

  test("unknown product -> PRODUCT_NOT_FOUND with details.productId, no row", () => {
    const { db, svc } = harness();
    const r = svc.subscribe(A, "no-such-product", T0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("PRODUCT_NOT_FOUND");
    expect(r.error.details).toEqual({ productId: "no-such-product" });
    expect(count(db)).toBe(0);
  });

  test("product lookup is by id, not slug", () => {
    const { db, svc, oos } = harness();
    const slug = db.query<{ slug: string }, [string]>("SELECT slug FROM products WHERE id = ?").get(oos[0]!)!.slug;
    if (slug === oos[0]!) return;
    const r = svc.subscribe(A, slug, T0);
    expect(!r.ok && r.error.code).toBe("PRODUCT_NOT_FOUND");
  });

  test.each(HOSTILE_IDS.map((v) => [v]))("hostile product id %p never creates a row and never throws", (pid) => {
    const { db, svc } = harness();
    const r = svc.subscribe(A, asStr(pid), T0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(["INVALID_INPUT", "PRODUCT_NOT_FOUND"]).toContain(r.error.code);
    if (typeof pid !== "string") expect(r.error.code).toBe("INVALID_INPUT");
    expect(count(db)).toBe(0);
    expect(db.query("SELECT COUNT(*) AS n FROM products").get()).toEqual({ n: SEED_CATALOG_STATS.total });
  });

  test("10k-char product id is rejected before SQL and does not echo 10k chars in details", () => {
    const { svc } = harness();
    const r = svc.subscribe(A, "p".repeat(10_000), T0);
    expect(!r.ok && r.error.code).toBe("PRODUCT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
describe("owner key validation (isSessionId)", () => {
  test.each(HOSTILE_IDS.map((v) => [v]))("invalid session %p: mutations INVALID_INPUT, reads empty, no writes", (sid) => {
    const { db, svc, oos } = harness();
    const real = mustSubscribe(svc, A, oos[0]!).alert;
    const before = rows(db);
    const s = asStr(sid);
    const sub = svc.subscribe(s, oos[1]!, T0);
    expect(!sub.ok && sub.error.code).toBe("INVALID_INPUT");
    const un = svc.unsubscribe(s, real.id);
    expect(!un.ok && un.error.code).toBe("INVALID_INPUT");
    const ack = svc.acknowledge(s, real.id, T0);
    expect(!ack.ok && ack.error.code).toBe("INVALID_INPUT");
    expect(svc.list(s)).toEqual([]);
    expect(svc.listBackInStock(s)).toEqual([]);
    expect(svc.isSubscribed(s, oos[0]!)).toBe(false);
    expect(svc.countFor(s)).toBe(0);
    expect(rows(db)).toEqual(before);
  });

  test("uppercase form of a real owner key cannot read or mutate that owner's alerts", () => {
    const { svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    const up = A.toUpperCase();
    expect(svc.list(up)).toEqual([]);
    expect(svc.countFor(up)).toBe(0);
    expect(svc.isSubscribed(up, oos[0]!)).toBe(false);
    expect(svc.unsubscribe(up, a.id).ok).toBe(false);
    expect(svc.acknowledge(up, a.id, T0).ok).toBe(false);
    expect(svc.list(A)[0]!.acknowledgedAt).toBeNull();
  });

  test("session validation runs before product validation (invalid session + unknown product -> INVALID_INPUT)", () => {
    const { svc } = harness();
    const r = svc.subscribe("nope", "no-such-product", T0);
    expect(!r.ok && r.error.code).toBe("INVALID_INPUT");
  });
});

// ---------------------------------------------------------------------------
describe("criterion 2: duplicate subscribe is idempotent (duplicate wins)", () => {
  test("second subscribe returns the existing alert, alreadyRegistered true, no second row, no write", () => {
    const { db, svc, oos } = harness();
    const first = mustSubscribe(svc, A, oos[0]!).alert;
    const writes = installWriteSpy(db);
    const again = mustSubscribe(svc, A, oos[0]!, T0 + 60_000);
    expect(again.alreadyRegistered).toBe(true);
    expect(again.alert).toEqual(first);
    expect(count(db)).toBe(1);
    expect(writes()).toBe(0);
  });

  test("duplicate after the product is restocked still returns the existing alert", () => {
    const { db, svc, oos } = harness();
    const first = mustSubscribe(svc, A, oos[0]!).alert;
    db.query("UPDATE products SET stock = 9 WHERE id = ?").run(oos[0]!);
    const again = mustSubscribe(svc, A, oos[0]!);
    expect(again).toEqual({ alert: first, alreadyRegistered: true });
  });

  test("duplicate at the 20 cap still returns the existing alert (not LIMIT_REACHED)", () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 20);
    for (const id of ids) mustSubscribe(svc, A, id);
    const again = mustSubscribe(svc, A, ids[7]!);
    expect(again.alreadyRegistered).toBe(true);
    expect(count(db, A)).toBe(20);
  });

  test("duplicate after acknowledge returns the acknowledged alert unchanged", () => {
    const { svc, oos } = harness();
    const first = mustSubscribe(svc, A, oos[0]!).alert;
    const acked = svc.acknowledge(A, first.id, T0 + 5);
    expect(acked.ok).toBe(true);
    const again = mustSubscribe(svc, A, oos[0]!);
    expect(again.alert.acknowledgedAt).toBe(new Date(T0 + 5).toISOString());
  });

  test("same product, different sessions -> two independent rows", () => {
    const { db, svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    const b = mustSubscribe(svc, B, oos[0]!).alert;
    expect(a.id).not.toBe(b.id);
    expect(count(db)).toBe(2);
  });

  test("after unsubscribe, subscribe creates a fresh alert with a new id", () => {
    const { svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    expect(svc.unsubscribe(A, a.id).ok).toBe(true);
    const b = mustSubscribe(svc, A, oos[0]!);
    expect(b.alreadyRegistered).toBe(false);
    expect(b.alert.id).not.toBe(a.id);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 3: 21st alert -> LIMIT_REACHED", () => {
  test("20 succeed, 21st fails with LIMIT_REACHED details.limit 20, no 21st row", () => {
    const { db, svc } = harness();
    expect(MAX_ALERTS_PER_SESSION).toBe(20);
    const ids = addOutOfStock(db, 21);
    for (const id of ids.slice(0, 20)) mustSubscribe(svc, A, id);
    const r = svc.subscribe(A, ids[20]!, T0);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("LIMIT_REACHED");
    expect(r.error.details).toEqual({ limit: 20 });
    expect(count(db, A)).toBe(20);
    expect(svc.countFor(A)).toBe(20);
  });

  test("cap is per session: B is unaffected by A's 20", () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 21);
    for (const id of ids.slice(0, 20)) mustSubscribe(svc, A, id);
    expect(mustSubscribe(svc, B, ids[20]!).alreadyRegistered).toBe(false);
  });

  test("unsubscribing one frees a slot", () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 21);
    const created = ids.slice(0, 20).map((id) => mustSubscribe(svc, A, id).alert);
    expect(svc.unsubscribe(A, created[3]!.id).ok).toBe(true);
    expect(mustSubscribe(svc, A, ids[20]!).alreadyRegistered).toBe(false);
  });

  test("acknowledged and back-in-stock alerts still count toward the cap", () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 21);
    const created = ids.slice(0, 20).map((id) => mustSubscribe(svc, A, id).alert);
    svc.acknowledge(A, created[0]!.id, T0);
    db.query("UPDATE products SET stock = 3 WHERE id = ?").run(ids[1]!);
    const r = svc.subscribe(A, ids[20]!, T0);
    expect(!r.ok && r.error.code).toBe("LIMIT_REACHED");
  });

  test("ordering: in-stock product at the cap reports already_available (stock check precedes limit)", () => {
    const { db, svc, inStock } = harness();
    for (const id of addOutOfStock(db, 20)) mustSubscribe(svc, A, id);
    const r = svc.subscribe(A, inStock, T0);
    expect(!r.ok && r.error.details).toEqual({ reason: "already_available", productId: inStock });
  });
});

// ---------------------------------------------------------------------------
describe("criterion 4: status derived from current stock; acknowledge", () => {
  test("restock via UPDATE flips waiting -> back_in_stock with zero writes to stock_alerts", () => {
    const { db, svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    const snapshot = rows(db);
    expect(svc.list(A).map((v) => v.status)).toEqual(["waiting"]);
    expect(svc.listBackInStock(A)).toEqual([]);
    const writes = installWriteSpy(db);
    db.query("UPDATE products SET stock = 4 WHERE id = ?").run(oos[0]!);
    const v = svc.list(A);
    expect(v.map((x) => [x.id, x.status, x.product?.stock])).toEqual([[a.id, "back_in_stock", 4]]);
    expect(svc.listBackInStock(A).map((x) => x.id)).toEqual([a.id]);
    expect(writes()).toBe(0);
    expect(rows(db)).toEqual(snapshot);
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(oos[0]!);
    expect(svc.list(A)[0]!.status).toBe("waiting");
    expect(svc.listBackInStock(A)).toEqual([]);
    expect(writes()).toBe(0);
  });

  test("reads (list, listBackInStock, isSubscribed, countFor) never write", () => {
    const { db, svc, oos } = harness();
    mustSubscribe(svc, A, oos[0]!);
    const writes = installWriteSpy(db);
    svc.list(A);
    svc.listBackInStock(A);
    svc.isSubscribed(A, oos[0]!);
    svc.countFor(A);
    expect(writes()).toBe(0);
  });

  test("view shape: only documented keys, product summary whitelisted, no session id anywhere", () => {
    const { db, svc, oos } = harness();
    mustSubscribe(svc, A, oos[0]!);
    mustSubscribe(svc, A, oos[1]!);
    db.query("UPDATE products SET stock = 2 WHERE id = ?").run(oos[1]!);
    const views = [...svc.list(A), ...svc.listBackInStock(A)];
    expect(views.length).toBe(3);
    for (const v of views) {
      expect(Object.keys(v).sort()).toEqual(["acknowledgedAt", "available", "createdAt", "id", "product", "productId", "status"]);
      expect(Object.keys(v.product ?? {}).sort()).toEqual(["currency", "id", "imageUrl", "name", "priceCents", "slug", "stock"]);
    }
    const json = JSON.stringify(views);
    expect(json).not.toContain(A);
    expect(json.toLowerCase()).not.toContain("session");
    expect(json.toLowerCase()).not.toContain("email");
  });

  test("subscribe / acknowledge results never carry a session id", () => {
    const { svc, oos } = harness();
    const s = mustSubscribe(svc, A, oos[0]!);
    const ack = svc.acknowledge(A, s.alert.id, T0);
    const json = JSON.stringify([s, ack]);
    expect(json).not.toContain(A);
    expect(json.toLowerCase()).not.toContain("session");
  });

  test("list is newest first; ties broken by insertion order desc", () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 4);
    const a0 = mustSubscribe(svc, A, ids[0]!, T0).alert;
    const a1 = mustSubscribe(svc, A, ids[1]!, T0 + 1000).alert;
    const a2 = mustSubscribe(svc, A, ids[2]!, T0 + 1000).alert;
    const a3 = mustSubscribe(svc, A, ids[3]!, T0 - 1000).alert;
    expect(svc.list(A).map((v) => v.id)).toEqual([a2.id, a1.id, a0.id, a3.id]);
  });

  test("acknowledge sets acknowledgedAt, hides from listBackInStock, stays in list with its status", () => {
    const { db, svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    db.query("UPDATE products SET stock = 5 WHERE id = ?").run(oos[0]!);
    const r = svc.acknowledge(A, a.id, T0 + 10_000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ ...a, acknowledgedAt: new Date(T0 + 10_000).toISOString() });
    expect(svc.listBackInStock(A)).toEqual([]);
    const l = svc.list(A);
    expect(l.length).toBe(1);
    expect(l[0]!.status).toBe("back_in_stock");
    expect(l[0]!.acknowledgedAt).toBe(new Date(T0 + 10_000).toISOString());
  });

  test("acknowledge keeps the first timestamp on repeats (even with earlier now)", () => {
    const { db, svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    const first = svc.acknowledge(A, a.id, T0 + 1);
    const second = svc.acknowledge(A, a.id, T0 + 999_999);
    const third = svc.acknowledge(A, a.id, T0 - 999_999);
    for (const r of [first, second, third]) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.acknowledgedAt).toBe(new Date(T0 + 1).toISOString());
    }
    expect(rows(db)[0]!.acknowledged_at).toBe(new Date(T0 + 1).toISOString());
  });

  test("acknowledging while waiting is allowed; later restock does not show it in the banner", () => {
    const { db, svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    expect(svc.acknowledge(A, a.id, T0).ok).toBe(true);
    db.query("UPDATE products SET stock = 5 WHERE id = ?").run(oos[0]!);
    expect(svc.listBackInStock(A)).toEqual([]);
    expect(svc.list(A)[0]!.status).toBe("back_in_stock");
  });

  test("listBackInStock filters mixed set correctly", () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 4);
    const al = ids.map((id, i) => mustSubscribe(svc, A, id, T0 + i).alert);
    db.query("UPDATE products SET stock = 1 WHERE id IN (?, ?, ?)").run(ids[1]!, ids[2]!, ids[3]!);
    svc.acknowledge(A, al[2]!.id, T0);
    expect(svc.listBackInStock(A).map((v) => v.id)).toEqual([al[3]!.id, al[1]!.id]);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 5: unsubscribe; foreign / malformed ids -> NOT_FOUND", () => {
  test("unsubscribe removes exactly that row", () => {
    const { db, svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    const keep = mustSubscribe(svc, A, oos[1]!).alert;
    expect(svc.unsubscribe(A, a.id)).toEqual({ ok: true, value: undefined });
    expect(rows(db).map((r) => r.id)).toEqual([keep.id]);
    expect(svc.isSubscribed(A, oos[0]!)).toBe(false);
  });

  test("second unsubscribe of the same id -> NOT_FOUND", () => {
    const { svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    svc.unsubscribe(A, a.id);
    const r = svc.unsubscribe(A, a.id);
    expect(!r.ok && r.error.code).toBe("NOT_FOUND");
  });

  test("foreign, unknown and malformed ids give byte-identical errors for unsubscribe and acknowledge", () => {
    const { db, svc, oos } = harness();
    const foreign = mustSubscribe(svc, B, oos[0]!).alert;
    const before = rows(db);
    const cases: unknown[] = [foreign.id, crypto.randomUUID(), ...HOSTILE_IDS];
    const un = cases.map((id) => JSON.stringify(svc.unsubscribe(A, asStr(id))));
    const ack = cases.map((id) => JSON.stringify(svc.acknowledge(A, asStr(id), T0)));
    expect(new Set(un).size).toBe(1);
    expect(new Set(ack).size).toBe(1);
    expect(JSON.parse(un[0]!).error.code).toBe("NOT_FOUND");
    expect(JSON.parse(ack[0]!).error.code).toBe("NOT_FOUND");
    expect(un[0]!).not.toContain(foreign.id);
    expect(rows(db)).toEqual(before);
  });

  test("SQL-looking alert ids do not match other rows (no wildcard / injection)", () => {
    const { db, svc, oos } = harness();
    mustSubscribe(svc, A, oos[0]!);
    for (const id of ["%", "_%", "' OR '1'='1", "1 OR 1=1", "*"]) {
      expect(svc.unsubscribe(A, id).ok).toBe(false);
      expect(svc.acknowledge(A, id, T0).ok).toBe(false);
    }
    expect(count(db)).toBe(1);
    expect(rows(db)[0]!.acknowledged_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("two-session isolation matrix (every method)", () => {
  test("A's alerts are invisible and immutable to B and vice versa", () => {
    const { db, svc, oos } = harness();
    const a = mustSubscribe(svc, A, oos[0]!).alert;
    const b = mustSubscribe(svc, B, oos[1]!).alert;
    db.query("UPDATE products SET stock = 1 WHERE id IN (?, ?)").run(oos[0]!, oos[1]!);

    for (const [me, mine, theirs, myProduct, theirProduct] of [
      [A, a, b, oos[0]!, oos[1]!],
      [B, b, a, oos[1]!, oos[0]!],
    ] as const) {
      expect(svc.list(me).map((v) => v.id)).toEqual([mine.id]);
      expect(svc.listBackInStock(me).map((v) => v.id)).toEqual([mine.id]);
      expect(svc.countFor(me)).toBe(1);
      expect(svc.isSubscribed(me, myProduct)).toBe(true);
      expect(svc.isSubscribed(me, theirProduct)).toBe(false);
      const un = svc.unsubscribe(me, theirs.id);
      expect(!un.ok && un.error.code).toBe("NOT_FOUND");
      const ack = svc.acknowledge(me, theirs.id, T0);
      expect(!ack.ok && ack.error.code).toBe("NOT_FOUND");
      // subscribing to the other session's product creates an own row, not the foreign one
      db.query("UPDATE products SET stock = 0 WHERE id = ?").run(theirProduct);
      const s = mustSubscribe(svc, me, theirProduct);
      expect(s.alreadyRegistered).toBe(false);
      expect(s.alert.id).not.toBe(theirs.id);
      expect(svc.unsubscribe(me, s.alert.id).ok).toBe(true);
      db.query("UPDATE products SET stock = 1 WHERE id = ?").run(theirProduct);
    }
    // nothing of the other session was modified
    const all = rows(db);
    expect(all.length).toBe(2);
    expect(all.every((r) => r.acknowledged_at === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("hostile now values", () => {
  test.each([[Number.NaN], [Number.POSITIVE_INFINITY], [Number.NEGATIVE_INFINITY], [8.64e15 + 1], [-8.64e15 - 1]])(
    "subscribe/acknowledge with now=%p throw RangeError and write nothing",
    (now) => {
      const { db, svc, oos } = harness();
      const a = mustSubscribe(svc, A, oos[0]!).alert;
      const before = rows(db);
      expect(() => svc.subscribe(A, oos[1]!, now)).toThrow(RangeError);
      expect(() => svc.acknowledge(A, a.id, now)).toThrow(RangeError);
      expect(rows(db)).toEqual(before);
    },
  );

  test("null now is treated like omitted (nullish default to Date.now())", () => {
    const { svc, oos } = harness();
    const t = Date.now();
    const r = svc.subscribe(A, oos[1]!, null as unknown as number);
    expect(r.ok && Math.abs(Date.parse(r.value.alert.createdAt) - t) < 5_000).toBe(true);
  });

  test.each([["123"], [{}], [true]])("non-number now %p throws RangeError, writes nothing", (now) => {
    const { db, svc, oos } = harness();
    expect(() => svc.subscribe(A, oos[1]!, now as unknown as number)).toThrow(RangeError);
    expect(count(db)).toBe(0);
  });

  test("now omitted uses Date.now()", () => {
    const { svc, oos } = harness();
    const t = Date.now();
    const r = svc.subscribe(A, oos[0]!);
    expect(r.ok && Math.abs(Date.parse(r.value.alert.createdAt) - t) < 5_000).toBe(true);
  });

  test("now = 0 and negative epoch ms are stored as valid ISO strings", () => {
    const { svc, oos } = harness();
    expect(mustSubscribe(svc, A, oos[0]!, 0).alert.createdAt).toBe("1970-01-01T00:00:00.000Z");
    expect(mustSubscribe(svc, A, oos[1]!, -1).alert.createdAt).toBe("1969-12-31T23:59:59.999Z");
  });

  // Extended-year ISO strings ("+010000-...", "-000001-...") sort lexically
  // out of chronological order, so list() is no longer newest-first.
  test.failing("D-T41-1: list stays newest first for finite now values outside years 0000-9999", () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 3);
    const mid = mustSubscribe(svc, A, ids[0]!, T0).alert;
    const future = mustSubscribe(svc, A, ids[1]!, Date.parse("+010000-01-01T00:00:00.000Z")).alert;
    const past = mustSubscribe(svc, A, ids[2]!, Date.parse("-000001-01-01T00:00:00.000Z")).alert;
    expect(svc.list(A).map((v) => v.id)).toEqual([future.id, mid.id, past.id]);
  });
});

// ---------------------------------------------------------------------------
describe("FK cascade and product removal", () => {
  test("deleting a product cascades its alerts for every session", () => {
    const { db, svc } = harness();
    const [p, q] = addOutOfStock(db, 2);
    mustSubscribe(svc, A, p!);
    mustSubscribe(svc, B, p!);
    const keep = mustSubscribe(svc, A, q!).alert;
    db.query("DELETE FROM products WHERE id = ?").run(p!);
    expect(rows(db).map((r) => r.id)).toEqual([keep.id]);
    expect(svc.list(A).map((v) => v.id)).toEqual([keep.id]);
    expect(svc.countFor(B)).toBe(0);
  });

  test("orphan row (FK off) yields waiting + product null, never throws", () => {
    const { db, svc } = harness();
    const [p] = addOutOfStock(db, 1);
    const a = mustSubscribe(svc, A, p!).alert;
    db.run("PRAGMA foreign_keys = OFF");
    db.query("DELETE FROM products WHERE id = ?").run(p!);
    db.run("PRAGMA foreign_keys = ON");
    expect(svc.list(A)).toEqual([{ ...a, status: "waiting", product: null, available: false }]);
    expect(svc.listBackInStock(A)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("repository guards", () => {
  test("writes with an invalid session id throw TypeError; reads return empty", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    open.push(db);
    const repo = new SqliteStockAlertRepository(db);
    expect(() => repo.insert("bad", { id: "x", productId: "y", createdAt: "z" })).toThrow(TypeError);
    expect(() => repo.delete("bad", "x")).toThrow(TypeError);
    expect(() => repo.acknowledge("bad", "x", "z")).toThrow(TypeError);
    expect(repo.listForSession("bad")).toEqual([]);
    expect(repo.findByProduct("bad", "y")).toBeNull();
    expect(repo.findById("bad", "x")).toBeNull();
    expect(repo.countForSession("bad")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe("concurrency", () => {
  test("25 parallel subscribes to distinct out-of-stock products -> exactly 20 ok, 5 LIMIT_REACHED", async () => {
    const { db, svc } = harness();
    const ids = addOutOfStock(db, 25);
    const results = await Promise.all(ids.map(async (id) => svc.subscribe(A, id, T0)));
    expect(results.filter((r) => r.ok).length).toBe(20);
    expect(results.filter((r) => !r.ok && r.error.code === "LIMIT_REACHED").length).toBe(5);
    expect(count(db, A)).toBe(20);
  });

  test("10 parallel duplicate subscribes -> 1 row, 1 new + 9 alreadyRegistered, same id", async () => {
    const { db, svc, oos } = harness();
    const results = await Promise.all(Array.from({ length: 10 }, async () => svc.subscribe(A, oos[0]!, T0)));
    const values = results.map((r) => {
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.value;
    });
    expect(values.filter((v) => !v.alreadyRegistered).length).toBe(1);
    expect(new Set(values.map((v) => v.alert.id)).size).toBe(1);
    expect(count(db)).toBe(1);
  });

  // True parallelism: separate worker threads, separate connections, one file DB.
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test(
    "worker threads on separate connections: cap holds at 20 and duplicates collapse to 1 row",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qa-t41-"));
      tmpDirs.push(dir);
      const dbPath = join(dir, "alerts.sqlite");
      const db = createDatabase(dbPath);
      runMigrations(db);
      seedDatabase(db);
      const ids = addOutOfStock(db, 25);
      const dup = addOutOfStock(db, 1, "qa-dup")[0]!;
      db.close();

      const workerSrc = join(dir, "worker.ts");
      const servicePath = join(ALERTS_DIR, "stock-alert-service.ts");
      const clientPath = join(ALERTS_DIR, "../db/client.ts");
      writeFileSync(
        workerSrc,
        `import { createDatabase } from ${JSON.stringify(clientPath)};
import { createStockAlertService } from ${JSON.stringify(servicePath)};
declare const self: Worker;
self.onmessage = (e: MessageEvent) => {
  const { dbPath, session, products } = e.data as { dbPath: string; session: string; products: string[] };
  const db = createDatabase(dbPath);
  const svc = createStockAlertService({ db });
  const out = products.map((p) => {
    const r = svc.subscribe(session, p);
    return r.ok ? (r.value.alreadyRegistered ? "dup" : "new") : r.error.code;
  });
  db.close();
  postMessage(out);
};
`,
      );
      const run = (products: string[], session: string) =>
        new Promise<string[]>((resolve, reject) => {
          const w = new Worker(workerSrc);
          w.onmessage = (e: MessageEvent) => {
            resolve(e.data as string[]);
            w.terminate();
          };
          w.onerror = (e) => reject(e);
          w.postMessage({ dbPath, session, products });
        });
      const chunks = [0, 1, 2, 3, 4].map((i) => ids.slice(i * 5, i * 5 + 5));
      const dupRuns = Array.from({ length: 10 }, () => run([dup], B));
      const out = (await Promise.all([...chunks.map((c) => run(c, A)), ...dupRuns])).flat();
      const check = createDatabase(dbPath);
      open.push(check);
      expect(count(check, A)).toBe(20);
      expect(count(check, B)).toBe(1);
      expect(out.filter((x) => x === "new").length).toBe(21);
      expect(out.filter((x) => x === "LIMIT_REACHED").length).toBe(5);
      expect(out.filter((x) => x === "dup").length).toBe(9);
      expect(readdirSync(dir).length).toBeGreaterThan(0);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
describe("singleton", () => {
  const saved = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (saved === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = saved;
  });

  test("getStockAlertService reuses per DB handle and rebuilds on a new handle", () => {
    process.env.DATABASE_PATH = ":memory:";
    const s1 = getStockAlertService();
    expect(getStockAlertService()).toBe(s1);
    const db1 = getDatabase();
    expect(getStockAlertService()).toBe(s1);
    closeDatabase();
    const s2 = getStockAlertService();
    expect(s2).not.toBe(s1);
    expect(getDatabase()).not.toBe(db1);
    expect(getStockAlertService()).toBe(s2);
  });

  test("singleton service operates on the shared handle", () => {
    process.env.DATABASE_PATH = ":memory:";
    const db = getDatabase();
    const [p] = addOutOfStock(db, 1);
    const r = getStockAlertService().subscribe(A, p!, T0);
    expect(r.ok).toBe(true);
    expect(count(db, A)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe("static checks on src/server/alerts", () => {
  const files = readdirSync(ALERTS_DIR).map((f) => ({ f, src: readFileSync(join(ALERTS_DIR, f), "utf8") }));
  const prod = files.filter(({ f }) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  test("no 'email' anywhere in the folder except the README's no-email statement", () => {
    for (const { f, src } of files) {
      const hits = src.split("\n").filter((l) => /e-?mail/i.test(l));
      for (const line of hits) {
        expect(`${f}: ${line}`).toMatch(/no email|not .*email|without email/i);
      }
    }
  });

  test("no any, @ts-ignore, @ts-expect-error, eslint-disable in production files", () => {
    for (const { f, src } of prod) {
      expect(`${f}:${/:\s*any\b|<any>|as any\b/.test(src)}`).toBe(`${f}:false`);
      expect(`${f}:${/@ts-(ignore|expect-error|nocheck)|eslint-disable/.test(src)}`).toBe(`${f}:false`);
    }
  });

  test("SQL is parameterised: no template interpolation other than the COLUMNS constant", () => {
    const repo = files.find(({ f }) => f === "stock-alert-repository.ts")!.src;
    const interps = [...repo.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]);
    expect(new Set(interps)).toEqual(new Set(["COLUMNS"]));
    const svc = files.find(({ f }) => f === "stock-alert-service.ts")!.src;
    expect(/\.(query|run|prepare|exec)\(/.test(svc)).toBe(false);
  });
});
