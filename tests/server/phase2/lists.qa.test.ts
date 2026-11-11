/**
 * QA adversarial tests for T37 (lists service), src/server/lists/**.
 * Owned by QA (QA-W1-T37). In-memory DB (`:memory:` + seedDatabase); the
 * worker-thread race tests use a temp file DB under os.tmpdir(), never ./data/.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppError, Result } from "@/lib/result";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  MAX_ITEMS_PER_LIST,
  MAX_LISTS_PER_SESSION,
  createListService,
  generateShareToken,
  type ListService,
} from "@/server/lists/list-service";

const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const C = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const LISTS_DIR = join(import.meta.dir, "../../../src/server/lists");
const T0 = Date.parse("2026-11-07T10:00:00.000Z");

const HOSTILE_OWNERS: readonly unknown[] = [
  "",
  " ",
  "x".repeat(10_000),
  "' OR 1=1 --",
  "%",
  `${A}\u0000`,
  A.toUpperCase(),
  ` ${A}`,
  "00000000-0000-0000-0000-000000000000",
  "3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b",
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
  readonly svc: ListService;
  readonly products: string[];
  /** Advances the injected clock by `ms`. */
  advance(ms: number): void;
  nowIso(): string;
}

function harness(): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  open.push(db);
  let t = T0;
  // Each call to now() advances 1 s so added_at values are strictly ordered.
  const now = () => {
    t += 1000;
    return new Date(t);
  };
  const svc = createListService({ db, now });
  const products = db
    .query<{ id: string }, [string]>("SELECT id FROM products WHERE published_at <= ? ORDER BY id")
    .all(new Date(T0).toISOString())
    .map((r) => r.id);
  return {
    db,
    svc,
    products,
    advance: (ms) => {
      t += ms;
    },
    nowIso: () => new Date(t).toISOString(),
  };
}

function ok<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.value)}`);
  return r.error;
}

function n(db: Database, sql: string, ...params: string[]): number {
  return db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;
}

function addProducts(db: Database, count: number, prefix = "qa-p", priceCents = 100): string[] {
  const ids: string[] = [];
  const ins = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock, published_at) VALUES (?, ?, ?, ?, 'USD', '/x.svg', 5, '2020-01-01T00:00:00.000Z')",
  );
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${String(i).padStart(3, "0")}`;
    ins.run(id, id, `QA ${i}`, priceCents);
    ids.push(id);
  }
  return ids;
}

function setPrice(db: Database, id: string, cents: number): void {
  db.query("UPDATE products SET price_cents = ?, list_price_cents = NULL WHERE id = ?").run(cents, id);
}

function priceOf(db: Database, id: string): number {
  return db.query<{ p: number }, [string]>("SELECT price_cents AS p FROM products WHERE id = ?").get(id)!.p;
}

function insertOrder(
  db: Database,
  o: { id: string; session: string; productId: string; createdAt: string; status?: string; fulfillment?: string },
): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, ?, ?, 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?, ?, ?)`,
  ).run(o.id, o.session, o.status ?? "paid", `idem-${o.id}`, o.createdAt, o.fulfillment ?? "processing");
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'n', 100, 1)").run(
    o.id,
    o.productId,
  );
}

function snapshot(db: Database): string {
  const lists = db.query("SELECT * FROM lists ORDER BY id").all();
  const items = db.query("SELECT * FROM list_items ORDER BY list_id, product_id").all();
  return JSON.stringify({ lists, items });
}

// ---------------------------------------------------------------------------
describe("criterion 1: default list and save for later", () => {
  test("ensureDefaultList x5 -> one default wishlist, same id", () => {
    const { db, svc } = harness();
    const ids = new Set(Array.from({ length: 5 }, () => ok(svc.ensureDefaultList(A)).id));
    expect(ids.size).toBe(1);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND is_default = 1", A)).toBe(1);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", A)).toBe(1);
  });

  test("ensureDefaultList repairs: wishlists exist but none default -> promotes the oldest, creates nothing", () => {
    const { db, svc } = harness();
    const first = ok(svc.createList(A, "First"));
    ok(svc.createList(A, "Second"));
    db.query("UPDATE lists SET is_default = 0 WHERE session_id = ?").run(A);
    const d = ok(svc.ensureDefaultList(A));
    expect(d.id).toBe(first.id);
    expect(d.isDefault).toBe(true);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", A)).toBe(2);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND is_default = 1", A)).toBe(1);
  });

  test("save_for_later is lazy: no row until ensureSaveForLater; 25 parallel calls -> 1 row, 1 id", async () => {
    const { db, svc } = harness();
    ok(svc.ensureDefaultList(A));
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE kind = 'save_for_later'")).toBe(0);
    const results = await Promise.all(Array.from({ length: 25 }, async () => svc.ensureSaveForLater(A)));
    expect(new Set(results.map((r) => ok(r).id)).size).toBe(1);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'save_for_later'", A)).toBe(1);
  });

  test("save_for_later cannot be renamed, shared (any mode) or deleted -> FORBIDDEN, nothing written", () => {
    const { db, svc } = harness();
    const sfl = ok(svc.ensureSaveForLater(A));
    const before = snapshot(db);
    expect(errOf(svc.renameList(A, sfl.id, "Renamed")).code).toBe("FORBIDDEN");
    expect(errOf(svc.renameList(A, sfl.id, "")).code).toBe("FORBIDDEN");
    for (const mode of ["enable", "disable", "rotate"] as const) {
      expect(errOf(svc.setSharing(A, sfl.id, mode)).code).toBe("FORBIDDEN");
    }
    expect(errOf(svc.deleteList(A, sfl.id)).code).toBe("FORBIDDEN");
    expect(snapshot(db)).toBe(before);
  });

  test("save_for_later is never the default and ensureDefaultList does not return it", () => {
    const { svc } = harness();
    const sfl = ok(svc.ensureSaveForLater(A));
    expect(sfl.isDefault).toBe(false);
    const d = ok(svc.ensureDefaultList(A));
    expect(d.id).not.toBe(sfl.id);
    expect(d.kind).toBe("wishlist");
  });
});

// ---------------------------------------------------------------------------
describe("criterion 2: limits", () => {
  test("name: 60 ok, 61 TOO_LONG, blank VALIDATION_FAILED, non-string INVALID_INPUT; same on rename", () => {
    const { svc } = harness();
    expect(ok(svc.createList(A, "n".repeat(60))).name).toBe("n".repeat(60));
    expect(errOf(svc.createList(A, "n".repeat(61))).code).toBe("TOO_LONG");
    expect(errOf(svc.createList(A, "   \t\n ")).code).toBe("VALIDATION_FAILED");
    expect(errOf(svc.createList(A, "")).code).toBe("VALIDATION_FAILED");
    expect(errOf(svc.createList(A, 42)).code).toBe("INVALID_INPUT");
    expect(errOf(svc.createList(A, null)).code).toBe("INVALID_INPUT");
    const l = ok(svc.createList(A, "Gifts"));
    expect(errOf(svc.renameList(A, l.id, "n".repeat(61))).code).toBe("TOO_LONG");
    expect(errOf(svc.renameList(A, l.id, "  ")).code).toBe("VALIDATION_FAILED");
    expect(ok(svc.renameList(A, l.id, "  New   name  ")).name).toBe("New name");
  });

  test("name with control chars is cleaned, 10k-char name rejected TOO_LONG", () => {
    const { svc } = harness();
    const l = ok(svc.createList(A, "Gi\u0000fts\u0007"));
    expect(l.name).not.toMatch(/[\u0000-\u001f]/);
    expect(errOf(svc.createList(A, "x".repeat(10_000))).code).toBe("TOO_LONG");
  });

  test("20 wishlists ok, 21st LIMIT_REACHED (details.max 20); save_for_later does not use a slot", () => {
    const { db, svc } = harness();
    ok(svc.ensureSaveForLater(A));
    for (let i = 0; i < MAX_LISTS_PER_SESSION; i++) ok(svc.createList(A, `L${i}`));
    const e = errOf(svc.createList(A, "L21"));
    expect(e.code).toBe("LIMIT_REACHED");
    expect(e.details?.max).toBe(20);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'", A)).toBe(20);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", A)).toBe(21);
    // save_for_later still available at the cap
    expect(ok(svc.ensureSaveForLater(A)).kind).toBe("save_for_later");
    // other sessions are unaffected by A's cap
    expect(ok(svc.createList(B, "B1")).name).toBe("B1");
  });

  test("the auto-created default counts as one of the 20", () => {
    const { svc } = harness();
    ok(svc.ensureDefaultList(A));
    for (let i = 0; i < 19; i++) ok(svc.createList(A, `L${i}`));
    expect(errOf(svc.createList(A, "over")).code).toBe("LIMIT_REACHED");
  });

  test("200 items ok, 201st LIMIT_REACHED; re-adding a present product at the cap is still alreadyPresent", () => {
    const { db, svc } = harness();
    const extra = addProducts(db, 201);
    const l = ok(svc.createList(A, "Big"));
    for (let i = 0; i < 200; i++) ok(svc.addItem(A, l.id, extra[i]!));
    const e = errOf(svc.addItem(A, l.id, extra[200]!));
    expect(e.code).toBe("LIMIT_REACHED");
    expect(e.details?.max).toBe(MAX_ITEMS_PER_LIST);
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", l.id)).toBe(200);
    expect(ok(svc.addItem(A, l.id, extra[0]!)).alreadyPresent).toBe(true);
  });

  test("note: 200 ok, 201 TOO_LONG, non-string INVALID_INPUT, blank -> null; update too", () => {
    const { svc, products } = harness();
    const l = ok(svc.createList(A, "Notes"));
    expect(ok(svc.addItem(A, l.id, products[0]!, { note: "n".repeat(200) })).item.note).toBe("n".repeat(200));
    expect(errOf(svc.addItem(A, l.id, products[1]!, { note: "n".repeat(201) })).code).toBe("TOO_LONG");
    expect(errOf(svc.addItem(A, l.id, products[1]!, { note: "n".repeat(10_000) })).code).toBe("TOO_LONG");
    expect(errOf(svc.addItem(A, l.id, products[1]!, { note: 5 })).code).toBe("INVALID_INPUT");
    expect(ok(svc.addItem(A, l.id, products[2]!, { note: "   " })).item.note).toBeNull();
    expect(errOf(svc.updateItem(A, l.id, products[0]!, { note: "n".repeat(201) })).code).toBe("TOO_LONG");
    expect(ok(svc.updateItem(A, l.id, products[0]!, { note: null })).note).toBeNull();
  });

  test("quantityDesired: 1 and 99 ok, '3' accepted as 3; 0/100/-1/1.5/NaN/Infinity/'abc'/'1e1'/' 3'/true INVALID_QUANTITY", () => {
    const { svc, products } = harness();
    const l = ok(svc.createList(A, "Q"));
    expect(ok(svc.addItem(A, l.id, products[0]!, { quantityDesired: 1 })).item.quantityDesired).toBe(1);
    expect(ok(svc.addItem(A, l.id, products[1]!, { quantityDesired: 99 })).item.quantityDesired).toBe(99);
    expect(ok(svc.addItem(A, l.id, products[2]!, { quantityDesired: "3" })).item.quantityDesired).toBe(3);
    for (const bad of [0, 100, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "abc", "1e1", " 3", "", "100", true, null, {}]) {
      expect(errOf(svc.addItem(A, l.id, products[3]!, { quantityDesired: bad })).code).toBe("INVALID_QUANTITY");
      expect(errOf(svc.updateItem(A, l.id, products[0]!, { quantityDesired: bad })).code).toBe("INVALID_QUANTITY");
    }
    expect(ok(svc.updateItem(A, l.id, products[0]!, { quantityDesired: "7" })).quantityDesired).toBe(7);
  });

  test("priority: 0..2 and '0'..'2' ok; 3/-1/1.5/'high'/null -> VALIDATION_FAILED with details.field = 'priority'", () => {
    const { svc, products } = harness();
    const l = ok(svc.createList(A, "P"));
    expect(ok(svc.addItem(A, l.id, products[0]!, { priority: 2 })).item.priority).toBe(2);
    expect(ok(svc.addItem(A, l.id, products[1]!, { priority: "1" })).item.priority).toBe(1);
    expect(ok(svc.addItem(A, l.id, products[2]!)).item.priority).toBe(0);
    for (const bad of [3, -1, 1.5, "high", "3", null, Number.NaN]) {
      const e = errOf(svc.addItem(A, l.id, products[3]!, { priority: bad }));
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(e.details?.field).toBe("priority");
      const u = errOf(svc.updateItem(A, l.id, products[0]!, { priority: bad }));
      expect(u.code).toBe("VALIDATION_FAILED");
      expect(u.details?.field).toBe("priority");
    }
  });
});

// ---------------------------------------------------------------------------
describe("criterion 3: addItem idempotency and product checks", () => {
  test("second add -> alreadyPresent, one row, note/quantity/priority untouched", () => {
    const { db, svc, products } = harness();
    const l = ok(svc.createList(A, "Idem"));
    const first = ok(svc.addItem(A, l.id, products[0]!, { quantityDesired: 2, note: "orig", priority: 1 }));
    expect(first.alreadyPresent).toBe(false);
    const again = ok(svc.addItem(A, l.id, products[0]!, { quantityDesired: 9, note: "new", priority: 2 }));
    expect(again.alreadyPresent).toBe(true);
    expect(again.item).toEqual(first.item);
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", l.id)).toBe(1);
  });

  test("addItem(null) goes to the default list, creating it once", () => {
    const { db, svc, products } = harness();
    const r1 = ok(svc.addItem(A, null, products[0]!));
    const r2 = ok(svc.addItem(A, null, products[1]!));
    expect(r1.listId).toBe(r2.listId);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", A)).toBe(1);
    expect(svc.isInDefaultList(A, products[0]!)).toBe(true);
    expect(svc.isInDefaultList(B, products[0]!)).toBe(false);
  });

  test("unknown, hostile and unpublished products -> PRODUCT_NOT_FOUND, nothing written (no default created either)", () => {
    const { db, svc, products } = harness();
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(products[5]!);
    const before = snapshot(db);
    for (const pid of ["nope", products[5]!, "", "x".repeat(10_000), "' OR 1=1 --"]) {
      expect(errOf(svc.addItem(A, null, pid)).code).toBe("PRODUCT_NOT_FOUND");
    }
    expect(snapshot(db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 4 + R-9: foreign / unknown / malformed list ids", () => {
  const BAD_IDS: readonly string[] = ["", "not-a-list", "x".repeat(10_000), "' OR 1=1 --", "%", B, crypto.randomUUID()];

  function allOps(svc: ListService, owner: string, listId: string, own: string, product: string): Result<unknown, AppError>[] {
    return [
      svc.getList(owner, listId),
      svc.getList(owner, listId, "price_asc"),
      svc.renameList(owner, listId, "Hijack"),
      svc.deleteList(owner, listId),
      svc.addItem(owner, listId, product),
      svc.addItem(owner, listId, "unknown-product"),
      svc.updateItem(owner, listId, product, { quantityDesired: 5 }),
      svc.removeItem(owner, listId, product),
      svc.moveItem(owner, listId, own, product),
      svc.moveItem(owner, own, listId, product),
      svc.setSharing(owner, listId, "enable"),
      svc.setSharing(owner, listId, "disable"),
      svc.setSharing(owner, listId, "rotate"),
    ];
  }

  test("three-session isolation matrix: every op on another owner's list -> NOT_FOUND 'List not found', nothing written", () => {
    const { db, svc, products } = harness();
    const p = products[0]!;
    const owners = [A, B, C];
    const lists = new Map<string, { list: string; sfl: string; own: string }>();
    for (const o of owners) {
      const list = ok(svc.createList(o, `list of ${o.slice(0, 4)}`)).id;
      const own = ok(svc.createList(o, "second")).id;
      const sfl = ok(svc.ensureSaveForLater(o)).id;
      ok(svc.addItem(o, list, p, { note: "mine" }));
      ok(svc.addItem(o, own, p, { note: "own" }));
      ok(svc.addItem(o, sfl, p));
      ok(svc.setSharing(o, list, "enable"));
      lists.set(o, { list, sfl, own });
    }
    const before = snapshot(db);
    const messages = new Set<string>();
    for (const actor of owners) {
      for (const victim of owners) {
        if (actor === victim) continue;
        const v = lists.get(victim)!;
        const mine = lists.get(actor)!;
        // move uses actor's own list on the other side; the product exists there too
        for (const target of [v.list, v.sfl]) {
          for (const r of allOps(svc, actor, target, mine.own, p)) {
            const e = errOf(r);
            expect(e.code).toBe("NOT_FOUND");
            messages.add(e.message);
          }
        }
      }
    }
    expect([...messages]).toEqual(["List not found"]);
    expect(snapshot(db)).toBe(before);
    // and each owner still sees only their own lists
    for (const o of owners) {
      const ids = svc.listLists(o).map((l) => l.id).sort();
      const mine = lists.get(o)!;
      expect(ids).toEqual([mine.list, mine.own, mine.sfl].sort());
    }
  });

  test("unknown and malformed ids give the identical error for every method", () => {
    const { db, svc, products } = harness();
    const own = ok(svc.createList(A, "Own")).id;
    ok(svc.addItem(A, own, products[0]!));
    const before = snapshot(db);
    const seen = new Set<string>();
    for (const bad of BAD_IDS) {
      for (const r of allOps(svc, A, bad, own, products[0]!)) {
        const e = errOf(r);
        seen.add(`${e.code}|${e.message}`);
      }
    }
    expect([...seen]).toEqual(["NOT_FOUND|List not found"]);
    expect(snapshot(db)).toBe(before);
  });

  test("a share token passed as a list id is NOT_FOUND for every method (token never accepted for mutation)", () => {
    const { db, svc, products } = harness();
    const shared = ok(svc.createList(B, "Shared"));
    ok(svc.addItem(B, shared.id, products[0]!));
    const token = ok(svc.setSharing(B, shared.id, "enable")).shareToken!;
    const own = ok(svc.createList(A, "Own")).id;
    ok(svc.addItem(A, own, products[0]!));
    const before = snapshot(db);
    for (const actor of [A, B]) {
      for (const r of allOps(svc, actor, token, own, products[0]!)) {
        const e = errOf(r);
        expect(e.code).toBe("NOT_FOUND");
        expect(e.message).toBe("List not found");
      }
    }
    expect(snapshot(db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 5: delete", () => {
  test("deleting the default promotes the oldest remaining wishlist (not save_for_later); exactly one default", () => {
    const { db, svc } = harness();
    const d = ok(svc.ensureDefaultList(A));
    ok(svc.ensureSaveForLater(A));
    const second = ok(svc.createList(A, "Second"));
    ok(svc.createList(A, "Third"));
    ok(svc.deleteList(A, d.id));
    const lists = svc.listLists(A);
    expect(lists[0]!.id).toBe(second.id);
    expect(lists[0]!.isDefault).toBe(true);
    expect(n(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND is_default = 1", A)).toBe(1);
  });

  test("deleting the only wishlist -> FORBIDDEN even with save_for_later present; nothing changes", () => {
    const { db, svc, products } = harness();
    const d = ok(svc.ensureDefaultList(A));
    const sfl = ok(svc.ensureSaveForLater(A));
    ok(svc.addItem(A, d.id, products[0]!));
    ok(svc.addItem(A, sfl.id, products[1]!));
    const before = snapshot(db);
    expect(errOf(svc.deleteList(A, d.id)).code).toBe("FORBIDDEN");
    expect(snapshot(db)).toBe(before);
  });

  test("deleting a list removes only its items: other lists (same product, other owners) and products survive", () => {
    const { db, svc, products } = harness();
    const keep = ok(svc.createList(A, "Keep"));
    const gone = ok(svc.createList(A, "Gone"));
    const other = ok(svc.createList(B, "Other"));
    for (const id of [keep.id, gone.id]) {
      ok(svc.addItem(A, id, products[0]!));
      ok(svc.addItem(A, id, products[1]!));
    }
    ok(svc.addItem(B, other.id, products[0]!));
    const productCount = n(db, "SELECT COUNT(*) AS n FROM products");
    ok(svc.deleteList(A, gone.id));
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", gone.id)).toBe(0);
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", keep.id)).toBe(2);
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", other.id)).toBe(1);
    expect(n(db, "SELECT COUNT(*) AS n FROM products")).toBe(productCount);
    expect(errOf(svc.getList(A, gone.id)).code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
describe("criterion 6: sharing", () => {
  test("generateShareToken: 22-char base64url decoding to 16 bytes; 1000 tokens unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const t = generateShareToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(Buffer.from(t, "base64url").length).toBe(16);
      seen.add(t);
    }
    expect(seen.size).toBe(1000);
  });

  test("enable creates token; enable again keeps it; rotate changes it; disable invalidates; re-enable issues a new one", () => {
    const { db, svc, products } = harness();
    const l = ok(svc.createList(A, "Gifts"));
    ok(svc.addItem(A, l.id, products[0]!));
    const t1 = ok(svc.setSharing(A, l.id, "enable")).shareToken!;
    expect(t1).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(ok(svc.setSharing(A, l.id, "enable")).shareToken).toBe(t1);
    expect(ok(svc.getByToken(t1)).name).toBe("Gifts");
    const t2 = ok(svc.setSharing(A, l.id, "rotate")).shareToken!;
    expect(t2).not.toBe(t1);
    expect(errOf(svc.getByToken(t1)).code).toBe("NOT_FOUND");
    expect(ok(svc.getByToken(t2)).itemCount).toBe(1);
    expect(ok(svc.setSharing(A, l.id, "disable")).shareToken).toBeNull();
    expect(errOf(svc.getByToken(t2)).code).toBe("NOT_FOUND");
    const row = db.query<{ t: string | null; p: number }, [string]>("SELECT share_token AS t, is_public AS p FROM lists WHERE id = ?").get(l.id)!;
    expect(row).toEqual({ t: null, p: 0 });
    const t3 = ok(svc.setSharing(A, l.id, "enable")).shareToken!;
    expect([t1, t2]).not.toContain(t3);
    expect(errOf(svc.getByToken(t1)).code).toBe("NOT_FOUND");
    expect(errOf(svc.getByToken(t2)).code).toBe("NOT_FOUND");
  });

  test("50 rotations produce 50 distinct tokens, only the last resolves", () => {
    const { svc } = harness();
    const l = ok(svc.createList(A, "Rot"));
    const tokens = Array.from({ length: 50 }, () => ok(svc.setSharing(A, l.id, "rotate")).shareToken!);
    expect(new Set(tokens).size).toBe(50);
    for (const t of tokens.slice(0, -1)) expect(errOf(svc.getByToken(t)).code).toBe("NOT_FOUND");
    expect(svc.getByToken(tokens[49]!).ok).toBe(true);
  });

  test("unknown sharing mode -> error, not a token", () => {
    const { svc } = harness();
    const l = ok(svc.createList(A, "M"));
    const r = svc.setSharing(A, l.id, "publish" as unknown as "enable");
    expect(r.ok).toBe(false);
  });

  test("getByToken: malformed / 10k-char / non-string / padded / token with is_public=0 -> NOT_FOUND (one message)", () => {
    const { db, svc } = harness();
    const l = ok(svc.createList(A, "Hidden"));
    const t = ok(svc.setSharing(A, l.id, "enable")).shareToken!;
    const bads: unknown[] = [
      "",
      "x".repeat(10_000),
      `${t}=`,
      `${t} `,
      ` ${t}`,
      t.slice(0, 21),
      `${t.slice(0, 21)}+`,
      `${t.slice(0, 21)}/`,
      "' OR 1=1 --xxxxxxxxxxx",
      "%".repeat(22),
      null,
      undefined,
      42,
      {},
      [t],
      l.id,
    ];
    const msgs = new Set<string>();
    for (const b of bads) {
      const e = errOf(svc.getByToken(b));
      expect(e.code).toBe("NOT_FOUND");
      msgs.add(e.message);
    }
    expect(msgs.size).toBe(1);
    db.query("UPDATE lists SET is_public = 0 WHERE id = ?").run(l.id);
    expect(errOf(svc.getByToken(t)).code).toBe("NOT_FOUND");
  });

  test("getByToken is read-only and the serialised view carries no owner key, list id, token or ownership flags", () => {
    const { db, svc, products } = harness();
    const l = ok(svc.createList(A, "Public"));
    ok(svc.addItem(A, l.id, products[0]!, { note: "size M", quantityDesired: 2, priority: 2 }));
    ok(svc.addItem(A, l.id, products[1]!));
    insertOrder(db, { id: "o-shared", session: A, productId: products[0]!, createdAt: "2027-01-01T00:00:00.000Z" });
    const t = ok(svc.setSharing(A, l.id, "enable")).shareToken!;
    const before = snapshot(db);
    const view = ok(svc.getByToken(t, "price_desc"));
    expect(snapshot(db)).toBe(before);
    expect(Object.keys(view).sort()).toEqual(["itemCount", "items", "name"]);
    const json = JSON.stringify(view);
    expect(json).not.toContain(A);
    expect(json).not.toContain(l.id);
    expect(json).not.toContain(t);
    expect(json).not.toMatch(/sessionId|session_id|ownerKey|owner_key|shareToken|isPublic|isDefault/);
    for (const item of view.items) {
      expect(item.listId).toBe("");
      expect(item.purchasedSinceAdded).toBe(false);
    }
    // the owner's own view does see the purchase
    const ownerView = ok(svc.getList(A, l.id));
    expect(ownerView.items.find((i) => i.productId === products[0])!.purchasedSinceAdded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 7: price snapshot, price drop, purchased since added", () => {
  test("price_at_add_cents stored at add time; drop only when current < stored; equal/higher -> null", () => {
    const { db, svc, products } = harness();
    const [p0, p1, p2] = [products[0]!, products[1]!, products[2]!];
    const l = ok(svc.createList(A, "Prices"));
    const orig = [p0, p1, p2].map((p) => priceOf(db, p));
    for (const p of [p0, p1, p2]) ok(svc.addItem(A, l.id, p));
    expect(n(db, "SELECT price_at_add_cents AS n FROM list_items WHERE list_id = ? AND product_id = ?", l.id, p0)).toBe(orig[0]!);
    setPrice(db, p0, orig[0]! - 37);
    setPrice(db, p1, orig[1]! + 500);
    const v = ok(svc.getList(A, l.id));
    const by = (p: string) => v.items.find((i) => i.productId === p)!;
    expect(by(p0).priceDroppedByCents).toBe(37);
    expect(by(p0).priceAtAddCents).toBe(orig[0]!);
    expect(by(p1).priceDroppedByCents).toBeNull();
    expect(by(p2).priceDroppedByCents).toBeNull();
    // stored price never moves with the catalogue
    expect(n(db, "SELECT price_at_add_cents AS n FROM list_items WHERE list_id = ? AND product_id = ?", l.id, p1)).toBe(orig[1]!);
  });

  test("purchasedSinceAdded: only own paid non-cancelled orders created at/after added_at", () => {
    const h = harness();
    const { db, svc, products } = h;
    const l = ok(svc.createList(A, "Bought"));
    const added = products.slice(0, 7).map((p) => ({ p, at: ok(svc.addItem(A, l.id, p)).item.addedAt }));
    const later = (iso: string) => new Date(Date.parse(iso) + 60_000).toISOString();
    const earlier = (iso: string) => new Date(Date.parse(iso) - 60_000).toISOString();
    insertOrder(db, { id: "o1", session: A, productId: added[0]!.p, createdAt: later(added[0]!.at) }); // true
    insertOrder(db, { id: "o2", session: A, productId: added[1]!.p, createdAt: earlier(added[1]!.at) }); // before
    insertOrder(db, { id: "o3", session: A, productId: added[2]!.p, createdAt: later(added[2]!.at), status: "payment_failed" });
    insertOrder(db, { id: "o4", session: A, productId: added[3]!.p, createdAt: later(added[3]!.at), fulfillment: "cancelled" });
    insertOrder(db, { id: "o5", session: B, productId: added[4]!.p, createdAt: later(added[4]!.at) }); // other owner
    insertOrder(db, { id: "o6", session: A, productId: added[5]!.p, createdAt: later(added[5]!.at), fulfillment: "delivered" }); // true
    // added[6]: no order at all
    const v = ok(svc.getList(A, l.id));
    const got = Object.fromEntries(v.items.map((i) => [i.productId, i.purchasedSinceAdded]));
    expect(got).toEqual({
      [added[0]!.p]: true,
      [added[1]!.p]: false,
      [added[2]!.p]: false,
      [added[3]!.p]: false,
      [added[4]!.p]: false,
      [added[5]!.p]: true,
      [added[6]!.p]: false,
    });
  });
});

// ---------------------------------------------------------------------------
describe("criterion 8: sort", () => {
  test("added_desc default, price_asc, price_desc, priority (ties newest first); unknown -> default", () => {
    const { db, svc } = harness();
    const ids = addProducts(db, 4, "qa-sort");
    const prices = [300, 100, 400, 200];
    ids.forEach((id, i) => setPrice(db, id, prices[i]!));
    const prio = [1, 2, 0, 2];
    const l = ok(svc.createList(A, "Sort"));
    ids.forEach((id, i) => ok(svc.addItem(A, l.id, id, { priority: prio[i] })));
    const order = (s?: string) => ok(svc.getList(A, l.id, s)).items.map((i) => i.productId);
    const pick = (...ix: number[]) => ix.map((i) => ids[i]!);
    const addedDesc = [...ids].reverse();
    expect(order()).toEqual(addedDesc);
    expect(order("added_desc")).toEqual(addedDesc);
    expect(order("price_asc")).toEqual(pick(1, 3, 0, 2));
    expect(order("price_desc")).toEqual(pick(2, 0, 3, 1));
    expect(order("priority")).toEqual(pick(3, 1, 0, 2));
    for (const junk of ["bogus", "", "PRICE_ASC", "price_asc; DROP TABLE lists", "__proto__"]) {
      expect(order(junk)).toEqual(addedDesc);
    }
    expect(ok(svc.getByToken(ok(svc.setSharing(A, l.id, "enable")).shareToken!, "price_asc")).items.map((i) => i.productId)).toEqual(pick(1, 3, 0, 2));
  });
});

// ---------------------------------------------------------------------------
describe("criterion 9: moveItem", () => {
  test("merge keeps the larger quantity, target note and priority win, source row removed", () => {
    const { db, svc, products } = harness();
    const p = products[0]!;
    const from = ok(svc.createList(A, "From"));
    const to = ok(svc.createList(A, "To"));
    ok(svc.addItem(A, from.id, p, { quantityDesired: 5, note: "src", priority: 2 }));
    ok(svc.addItem(A, to.id, p, { quantityDesired: 3, note: "tgt", priority: 0 }));
    ok(svc.moveItem(A, from.id, to.id, p));
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", from.id)).toBe(0);
    const item = ok(svc.getList(A, to.id)).items[0]!;
    expect(item.quantityDesired).toBe(5);
    expect(item.note).toBe("tgt");
    expect(item.priority).toBe(0);
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE product_id = ?", p)).toBe(1);
  });

  test("merge where target is larger keeps target quantity; null target note takes source note", () => {
    const { svc, products } = harness();
    const p = products[0]!;
    const from = ok(svc.createList(A, "From"));
    const to = ok(svc.createList(A, "To"));
    ok(svc.addItem(A, from.id, p, { quantityDesired: 2, note: "src" }));
    ok(svc.addItem(A, to.id, p, { quantityDesired: 9 }));
    ok(svc.moveItem(A, from.id, to.id, p));
    const item = ok(svc.getList(A, to.id)).items[0]!;
    expect(item.quantityDesired).toBe(9);
    expect(item.note).toBe("src");
  });

  test("move without merge keeps the snapshot; wishlist <-> save_for_later works", () => {
    const { svc, products } = harness();
    const p = products[0]!;
    const from = ok(svc.createList(A, "From"));
    const sfl = ok(svc.ensureSaveForLater(A));
    const added = ok(svc.addItem(A, from.id, p, { quantityDesired: 4, note: "x", priority: 1 })).item;
    ok(svc.moveItem(A, from.id, sfl.id, p));
    const moved = ok(svc.getList(A, sfl.id)).items[0]!;
    expect({ ...moved, listId: added.listId }).toMatchObject(added);
    ok(svc.moveItem(A, sfl.id, from.id, p));
    expect(ok(svc.getList(A, from.id)).items.length).toBe(1);
  });

  test("full target (200, without the product) -> LIMIT_REACHED, nothing changes; missing source -> NOT_FOUND", () => {
    const { db, svc, products } = harness();
    const extra = addProducts(db, 200);
    const full = ok(svc.createList(A, "Full"));
    for (const id of extra) ok(svc.addItem(A, full.id, id));
    const from = ok(svc.createList(A, "From"));
    ok(svc.addItem(A, from.id, products[0]!));
    const before = snapshot(db);
    expect(errOf(svc.moveItem(A, from.id, full.id, products[0]!)).code).toBe("LIMIT_REACHED");
    expect(snapshot(db)).toBe(before);
    // merge into a full list that already holds the product is fine
    ok(svc.addItem(A, from.id, extra[0]!, { quantityDesired: 7 }));
    ok(svc.moveItem(A, from.id, full.id, extra[0]!));
    expect(n(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", full.id)).toBe(200);
    expect(errOf(svc.moveItem(A, from.id, full.id, "nope")).code).toBe("NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
describe("totals", () => {
  test("totalCents is exact (sum of current price x quantity), itemCount counts rows", () => {
    const { db, svc } = harness();
    const ids = addProducts(db, 3, "qa-tot");
    setPrice(db, ids[0]!, 1999);
    setPrice(db, ids[1]!, 1);
    setPrice(db, ids[2]!, 123_457);
    const l = ok(svc.createList(A, "Tot"));
    ok(svc.addItem(A, l.id, ids[0]!, { quantityDesired: 3 }));
    ok(svc.addItem(A, l.id, ids[1]!, { quantityDesired: 99 }));
    ok(svc.addItem(A, l.id, ids[2]!, { quantityDesired: 7 }));
    const v = ok(svc.getList(A, l.id));
    expect(v.totalCents).toBe(1999 * 3 + 99 + 123_457 * 7);
    expect(v.itemCount).toBe(3);
    // price change is reflected (current price, not snapshot)
    setPrice(db, ids[0]!, 1000);
    expect(ok(svc.getList(A, l.id)).totalCents).toBe(3000 + 99 + 123_457 * 7);
  });

  test("empty list -> totalCents 0, items []", () => {
    const { svc } = harness();
    const l = ok(svc.createList(A, "Empty"));
    const v = ok(svc.getList(A, l.id));
    expect(v.totalCents).toBe(0);
    expect(v.items).toEqual([]);
    expect(v.itemCount).toBe(0);
  });

  test("unsafe line and unsafe sum -> MONEY_OVERFLOW", () => {
    const { db, svc } = harness();
    const ids = addProducts(db, 3, "qa-big");
    const l = ok(svc.createList(A, "Big line"));
    ok(svc.addItem(A, l.id, ids[0]!, { quantityDesired: 2 }));
    setPrice(db, ids[0]!, Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1);
    expect(errOf(svc.getList(A, l.id)).code).toBe("MONEY_OVERFLOW");
    const s = ok(svc.createList(A, "Big sum"));
    ok(svc.addItem(A, s.id, ids[1]!));
    ok(svc.addItem(A, s.id, ids[2]!));
    setPrice(db, ids[1]!, Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1);
    setPrice(db, ids[2]!, Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1);
    expect(errOf(svc.getList(A, s.id)).code).toBe("MONEY_OVERFLOW");
  });
});

// ---------------------------------------------------------------------------
describe("invalid owner key: INVALID_INPUT / [] / false with no SQL", () => {
  test("every method rejects hostile owner keys before touching the database", () => {
    const { db, svc, products } = harness();
    const real = ok(svc.createList(A, "Real")).id;
    let calls = 0;
    const target = db as unknown as Record<string, unknown>;
    const originals = new Map<string, unknown>();
    for (const m of ["query", "prepare", "run", "exec", "transaction"]) {
      const orig = target[m];
      if (typeof orig !== "function") continue;
      originals.set(m, orig);
      target[m] = (...args: unknown[]) => {
        calls++;
        return (orig as (...a: unknown[]) => unknown).apply(db, args);
      };
    }
    try {
      for (const bad of HOSTILE_OWNERS) {
        const s = bad as string;
        const mutations: Result<unknown, AppError>[] = [
          svc.ensureDefaultList(s),
          svc.ensureSaveForLater(s),
          svc.getList(s, real),
          svc.createList(s, "x"),
          svc.renameList(s, real, "x"),
          svc.deleteList(s, real),
          svc.addItem(s, null, products[0]!),
          svc.addItem(s, real, products[0]!),
          svc.updateItem(s, real, products[0]!, { quantityDesired: 2 }),
          svc.removeItem(s, real, products[0]!),
          svc.moveItem(s, real, real, products[0]!),
          svc.setSharing(s, real, "enable"),
        ];
        for (const r of mutations) expect(errOf(r).code).toBe("INVALID_INPUT");
        expect(svc.listLists(s)).toEqual([]);
        expect(svc.isInDefaultList(s, products[0]!)).toBe(false);
      }
      expect(calls).toBe(0);
    } finally {
      for (const [m, orig] of originals) target[m] = orig;
    }
  });
});

// ---------------------------------------------------------------------------
describe("concurrency (worker threads, separate connections, file DB)", () => {
  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  function setupFileDb(): { dir: string; dbPath: string; workerSrc: string } {
    const dir = mkdtempSync(join(tmpdir(), "qa-t37-"));
    tmpDirs.push(dir);
    const dbPath = join(dir, "lists.sqlite");
    const workerSrc = join(dir, "worker.ts");
    writeFileSync(
      workerSrc,
      `import { createDatabase } from ${JSON.stringify(join(LISTS_DIR, "../db/client.ts"))};
import { createListService } from ${JSON.stringify(join(LISTS_DIR, "list-service.ts"))};
declare const self: Worker;
self.onmessage = (e: MessageEvent) => {
  const { dbPath, op, session, listId, products } = e.data as { dbPath: string; op: string; session: string; listId: string | null; products: string[] };
  const db = createDatabase(dbPath);
  const svc = createListService({ db });
  let out: string[] = [];
  if (op === "sfl") {
    const r = svc.ensureSaveForLater(session);
    out = [r.ok ? r.value.id : r.error.code];
  } else if (op === "create") {
    const r = svc.createList(session, "race");
    out = [r.ok ? "new" : r.error.code];
  } else {
    out = products.map((p) => {
      const r = svc.addItem(session, listId, p);
      return r.ok ? (r.value.alreadyPresent ? "dup" : "new:" + r.value.listId) : r.error.code;
    });
  }
  db.close();
  postMessage(out);
};
`,
    );
    return { dir, dbPath, workerSrc };
  }

  function run(workerSrc: string, data: Record<string, unknown>): Promise<string[]> {
    return new Promise<string[]>((resolve, reject) => {
      const w = new Worker(workerSrc);
      w.onmessage = (e: MessageEvent) => {
        resolve(e.data as string[]);
        w.terminate();
      };
      w.onerror = (e) => reject(e);
      w.postMessage(data);
    });
  }

  test(
    "25 workers ensureSaveForLater -> exactly 1 row, every worker gets the same id",
    async () => {
      const { dbPath, workerSrc } = setupFileDb();
      const db = createDatabase(dbPath);
      runMigrations(db);
      seedDatabase(db);
      db.close();
      const out = (await Promise.all(Array.from({ length: 25 }, () => run(workerSrc, { dbPath, op: "sfl", session: A })))).flat();
      expect(new Set(out).size).toBe(1);
      expect(out[0]).not.toBe("INVALID_INPUT");
      const check = createDatabase(dbPath);
      open.push(check);
      expect(n(check, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'save_for_later'", A)).toBe(1);
    },
    60_000,
  );

  test(
    "near-cap race: 185 items + 30 parallel adds of distinct products -> exactly 200 rows, 15 LIMIT_REACHED",
    async () => {
      const { dbPath, workerSrc } = setupFileDb();
      const db = createDatabase(dbPath);
      runMigrations(db);
      seedDatabase(db);
      const extra = addProducts(db, 215, "qa-race");
      const svc = createListService({ db });
      const l = ok(svc.createList(A, "Race"));
      for (let i = 0; i < 185; i++) ok(svc.addItem(A, l.id, extra[i]!));
      db.close();
      const rest = extra.slice(185);
      const out = (
        await Promise.all(rest.map((p) => run(workerSrc, { dbPath, op: "add", session: A, listId: l.id, products: [p] })))
      ).flat();
      expect(out.filter((x) => x.startsWith("new:")).length).toBe(15);
      expect(out.filter((x) => x === "LIMIT_REACHED").length).toBe(15);
      const check = createDatabase(dbPath);
      open.push(check);
      expect(n(check, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", l.id)).toBe(200);
    },
    60_000,
  );

  test(
    "15 lists + 10 parallel createList -> exactly 20 wishlists; 10 parallel addItem(null) -> one default list",
    async () => {
      const { dbPath, workerSrc } = setupFileDb();
      const db = createDatabase(dbPath);
      runMigrations(db);
      seedDatabase(db);
      const svc = createListService({ db });
      for (let i = 0; i < 15; i++) ok(svc.createList(A, `L${i}`));
      const pids = db.query<{ id: string }, []>("SELECT id FROM products ORDER BY id LIMIT 10").all().map((r) => r.id);
      db.close();
      const created = (await Promise.all(Array.from({ length: 10 }, () => run(workerSrc, { dbPath, op: "create", session: A })))).flat();
      expect(created.filter((x) => x === "new").length).toBe(5);
      expect(created.filter((x) => x === "LIMIT_REACHED").length).toBe(5);
      const adds = (
        await Promise.all(pids.map((p) => run(workerSrc, { dbPath, op: "add", session: B, listId: null, products: [p] })))
      ).flat();
      expect(new Set(adds).size).toBe(1);
      expect(adds[0]!.startsWith("new:")).toBe(true);
      const check = createDatabase(dbPath);
      open.push(check);
      expect(n(check, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'", A)).toBe(20);
      expect(n(check, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND is_default = 1", A)).toBe(1);
      expect(n(check, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", B)).toBe(1);
      expect(n(check, "SELECT COUNT(*) AS n FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.session_id = ?", B)).toBe(10);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
describe("static checks on src/server/lists", () => {
  const files = readdirSync(LISTS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ f, src: readFileSync(join(LISTS_DIR, f), "utf8") }));

  test("SQL is parameterised: the only interpolations inside SQL strings are the column-list constants", () => {
    const allowed = new Set([
      "${LIST_COLUMNS}",
      "${ITEM_COLUMNS}",
      '${LIST_COLUMNS.split(", ").map((c) => `l.${c}`).join(", ")}',
    ]);
    for (const { src } of files) {
      const templates = src.match(/`[^`]*(SELECT|INSERT|UPDATE|DELETE)[\s\S]*?`/g) ?? [];
      for (const t of templates) {
        const interps = t.match(/\$\{[^}]*\}(?:`\)\.join\(", "\)\})?/g) ?? [];
        for (const i of interps) {
          const normalised = i.includes("LIST_COLUMNS.split") ? '${LIST_COLUMNS.split(", ").map((c) => `l.${c}`).join(", ")}' : i;
          expect(allowed.has(normalised) || i === "${c}").toBe(true);
        }
      }
    }
  });

  test("no any, @ts-ignore, console.* or Math.random in production files", () => {
    for (const { src } of files) {
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error/);
      expect(src).not.toMatch(/console\./);
      expect(src).not.toMatch(/Math\.random/);
    }
  });
});
