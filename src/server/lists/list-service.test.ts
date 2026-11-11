import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { AppError, Result } from "@/lib/result";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import {
  DEFAULT_LIST_NAME,
  LIST_NAME_MAX,
  MAX_ITEMS_PER_LIST,
  MAX_LISTS_PER_SESSION,
  NOTE_MAX,
  SAVE_FOR_LATER_NAME,
  createListService,
  generateShareToken,
  getListService,
} from "./list-service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";

function setup(now?: () => Date) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const service = createListService(now === undefined ? { db } : { db, now });
  // Published products only: the seed future-dates a few, and those cannot be listed.
  const productIds = db
    .query<{ id: string }, [string]>("SELECT id FROM products WHERE published_at <= ? ORDER BY id")
    .all(new Date().toISOString())
    .map((r) => r.id);
  return { db, service, productIds };
}

function unwrap<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errCode<T>(r: Result<T, AppError>): string {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.value)}`);
  return r.error.code;
}

function price(db: Database, id: string): number {
  const row = db.query<{ price_cents: number }, [string]>("SELECT price_cents FROM products WHERE id = ?").get(id);
  if (row === null) throw new Error("no product");
  return row.price_cents;
}

function setPrice(db: Database, id: string, cents: number): void {
  db.query("UPDATE products SET price_cents = ?, list_price_cents = NULL WHERE id = ?").run(cents, id);
}

function countRows(db: Database, sql: string, ...params: string[]): number {
  return db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;
}

function insertExtraProducts(db: Database, n: number): string[] {
  const ids: string[] = [];
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 100, 'USD', '/x.svg', 5)",
  );
  for (let i = 0; i < n; i++) {
    const id = `extra-${String(i).padStart(3, "0")}`;
    insert.run(id, id, `Extra ${i}`);
    ids.push(id);
  }
  return ids;
}

function insertOrder(
  db: Database,
  opts: { id: string; session: string; productId: string; createdAt: string; status?: string; fulfillment?: string },
): void {
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
     VALUES (?, ?, ?, 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', ?, ?, ?)`,
  ).run(opts.id, opts.session, opts.status ?? "paid", `idem-${opts.id}`, opts.createdAt, opts.fulfillment ?? "processing");
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'n', 100, 1)").run(
    opts.id,
    opts.productId,
  );
}

afterEach(() => {
  closeDatabase();
});

// 1 ---------------------------------------------------------------------------
describe("default list and save for later (criterion 1)", () => {
  test("ensureDefaultList is idempotent and creates exactly one default wishlist", () => {
    const { db, service } = setup();
    const a = unwrap(service.ensureDefaultList(S1));
    const b = unwrap(service.ensureDefaultList(S1));
    expect(a.id).toBe(b.id);
    expect(a.isDefault).toBe(true);
    expect(a.kind).toBe("wishlist");
    expect(a.name).toBe(DEFAULT_LIST_NAME);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", S1)).toBe(1);
    expect(a).not.toHaveProperty("sessionId");
  });

  test("ensureDefaultList repairs a session whose wishlists lost the default flag", () => {
    const { db, service } = setup();
    const created = unwrap(service.createList(S1, "Gifts"));
    db.query("UPDATE lists SET is_default = 0").run();
    const d = unwrap(service.ensureDefaultList(S1));
    expect(d.id).toBe(created.id);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", S1)).toBe(1);
  });

  test("save for later is created once, lazily", () => {
    const { db, service } = setup();
    expect(service.listLists(S1)).toEqual([]);
    const a = unwrap(service.ensureSaveForLater(S1));
    const b = unwrap(service.ensureSaveForLater(S1));
    expect(a.id).toBe(b.id);
    expect(a.kind).toBe("save_for_later");
    expect(a.name).toBe(SAVE_FOR_LATER_NAME);
    expect(a.isDefault).toBe(false);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE kind = 'save_for_later'")).toBe(1);
  });

  test("concurrent ensureSaveForLater calls create exactly one row", async () => {
    const { db, service } = setup();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => Promise.resolve().then(() => service.ensureSaveForLater(S1))),
    );
    const ids = new Set(results.map((r) => unwrap(r).id));
    expect(ids.size).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", S1)).toBe(1);
  });

  test("ensureSaveForLater returns a row inserted by a competing writer (ON CONFLICT path)", () => {
    const { db, service } = setup();
    db.query(
      "INSERT INTO lists (id, session_id, name, kind) VALUES ('other-writer', ?, 'Saved for later', 'save_for_later')",
    ).run(S1);
    expect(unwrap(service.ensureSaveForLater(S1)).id).toBe("other-writer");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", S1)).toBe(1);
  });

  test("save for later cannot be renamed, shared or deleted", () => {
    const { db, service } = setup();
    const sfl = unwrap(service.ensureSaveForLater(S1));
    expect(errCode(service.renameList(S1, sfl.id, "Mine"))).toBe("FORBIDDEN");
    expect(errCode(service.setSharing(S1, sfl.id, "enable"))).toBe("FORBIDDEN");
    expect(errCode(service.deleteList(S1, sfl.id))).toBe("FORBIDDEN");
    const row = db.query<{ name: string; share_token: string | null }, [string]>(
      "SELECT name, share_token FROM lists WHERE id = ?",
    ).get(sfl.id);
    expect(row).toEqual({ name: SAVE_FOR_LATER_NAME, share_token: null });
  });

  test("save for later accepts items and does not count toward the wishlist cap", () => {
    const { service, productIds } = setup();
    const sfl = unwrap(service.ensureSaveForLater(S1));
    const added = unwrap(service.addItem(S1, sfl.id, productIds[0] as string));
    expect(added.listId).toBe(sfl.id);
    for (let i = 0; i < MAX_LISTS_PER_SESSION; i++) unwrap(service.createList(S1, `L${i}`));
    expect(service.listLists(S1)).toHaveLength(MAX_LISTS_PER_SESSION + 1);
  });

  test("invalid session ids: INVALID_INPUT for writes, empty for reads", () => {
    const { db, service, productIds } = setup();
    for (const s of ["", "nope", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase(), "11111111-1111-1111-8111-111111111111"]) {
      expect(errCode(service.ensureDefaultList(s))).toBe("INVALID_INPUT");
      expect(errCode(service.ensureSaveForLater(s))).toBe("INVALID_INPUT");
      expect(errCode(service.createList(s, "x"))).toBe("INVALID_INPUT");
      expect(errCode(service.addItem(s, null, productIds[0] as string))).toBe("INVALID_INPUT");
      expect(errCode(service.getList(s, "x"))).toBe("INVALID_INPUT");
      expect(service.listLists(s)).toEqual([]);
      expect(service.isInDefaultList(s, productIds[0] as string)).toBe(false);
    }
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists")).toBe(0);
  });
});

// 2 ---------------------------------------------------------------------------
describe("limits (criterion 2)", () => {
  test("list names are cleaned and must be 1..60 characters", () => {
    const { service } = setup();
    expect(unwrap(service.createList(S1, "  Birthday ​ ideas\t ")).name).toBe("Birthday ideas");
    expect(errCode(service.createList(S1, ""))).toBe("VALIDATION_FAILED");
    expect(errCode(service.createList(S1, "   ​ "))).toBe("VALIDATION_FAILED");
    expect(errCode(service.createList(S1, "x".repeat(LIST_NAME_MAX + 1)))).toBe("TOO_LONG");
    expect(unwrap(service.createList(S1, "x".repeat(LIST_NAME_MAX))).name).toHaveLength(LIST_NAME_MAX);
    expect(errCode(service.createList(S1, 42))).toBe("INVALID_INPUT");
    expect(errCode(service.createList(S1, null))).toBe("INVALID_INPUT");
  });

  test("the 21st list is rejected with LIMIT_REACHED", () => {
    const { db, service } = setup();
    unwrap(service.ensureDefaultList(S1));
    for (let i = 1; i < MAX_LISTS_PER_SESSION; i++) unwrap(service.createList(S1, `List ${i}`));
    const r = service.createList(S1, "One too many");
    expect(errCode(r)).toBe("LIMIT_REACHED");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", S1)).toBe(MAX_LISTS_PER_SESSION);
    // Other sessions are unaffected.
    unwrap(service.createList(S2, "Fine"));
  });

  test("the first created list becomes the default; later ones do not", () => {
    const { service } = setup();
    const first = unwrap(service.createList(S1, "First"));
    const second = unwrap(service.createList(S1, "Second"));
    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);
    expect(unwrap(service.ensureDefaultList(S1)).id).toBe(first.id);
  });

  test("the 201st item is rejected with LIMIT_REACHED", () => {
    const { db, service, productIds } = setup();
    const ids = [...productIds, ...insertExtraProducts(db, MAX_ITEMS_PER_LIST + 1 - productIds.length)];
    const list = unwrap(service.createList(S1, "Big"));
    for (let i = 0; i < MAX_ITEMS_PER_LIST; i++) unwrap(service.addItem(S1, list.id, ids[i] as string));
    expect(errCode(service.addItem(S1, list.id, ids[MAX_ITEMS_PER_LIST] as string))).toBe("LIMIT_REACHED");
    // Re-adding an existing product at the cap is still an idempotent success.
    expect(unwrap(service.addItem(S1, list.id, ids[0] as string)).alreadyPresent).toBe(true);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", list.id)).toBe(MAX_ITEMS_PER_LIST);
  });

  test("Promise.all of 30 distinct adds near the cap stays <= 200 and never duplicates", async () => {
    const { db, service, productIds } = setup();
    const ids = [...productIds, ...insertExtraProducts(db, 220 - productIds.length)];
    const list = unwrap(service.createList(S1, "Race"));
    for (let i = 0; i < 185; i++) unwrap(service.addItem(S1, list.id, ids[i] as string));
    const batch = ids.slice(185, 215);
    const results = await Promise.all(
      [...batch, ...batch].map((id) => Promise.resolve().then(() => service.addItem(S1, list.id, id))),
    );
    const okCount = results.filter((r) => r.ok && !r.value.alreadyPresent).length;
    expect(okCount).toBe(15);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === "LIMIT_REACHED")).toBe(true);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", list.id)).toBe(200);
    expect(
      countRows(db, "SELECT COUNT(*) AS n FROM (SELECT product_id FROM list_items GROUP BY list_id, product_id HAVING COUNT(*) > 1)"),
    ).toBe(0);
  });

  test("Promise.all of 30 adds of distinct products into an empty default list", async () => {
    const { db, service, productIds } = setup();
    const results = await Promise.all(
      productIds.slice(0, 30).map((id) => Promise.resolve().then(() => service.addItem(S1, null, id))),
    );
    const listIds = new Set(results.map((r) => unwrap(r).listId));
    expect(listIds.size).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", S1)).toBe(1);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items")).toBe(30);
  });

  test("note > 200 is TOO_LONG; blank notes are stored as null", () => {
    const { service, productIds } = setup();
    const [p0, p1, p2] = productIds as [string, string, string];
    expect(errCode(service.addItem(S1, null, p0, { note: "n".repeat(NOTE_MAX + 1) }))).toBe("TOO_LONG");
    expect(unwrap(service.addItem(S1, null, p0, { note: "n".repeat(NOTE_MAX) })).item.note).toHaveLength(NOTE_MAX);
    expect(unwrap(service.addItem(S1, null, p1, { note: "   " })).item.note).toBeNull();
    expect(unwrap(service.addItem(S1, null, p2, { note: " for\r\n\r\n\r\nmom " })).item.note).toBe("for\n\nmom");
  });

  test("quantityDesired must be an integer 1..99 and priority 0..2", () => {
    const { service, productIds } = setup();
    const p = productIds[0] as string;
    for (const q of [0, 100, 1.5, -1, Number.NaN, "abc", "1.5", null, true]) {
      expect(errCode(service.addItem(S1, null, p, { quantityDesired: q }))).toBe("INVALID_QUANTITY");
    }
    for (const pr of [3, -1, 1.5, "high", null]) {
      expect(errCode(service.addItem(S1, null, p, { priority: pr }))).toBe("VALIDATION_FAILED");
    }
    const ok1 = unwrap(service.addItem(S1, null, p, { quantityDesired: "99", priority: "2" }));
    expect(ok1.item.quantityDesired).toBe(99);
    expect(ok1.item.priority).toBe(2);
    const defaults = unwrap(service.addItem(S1, null, productIds[1] as string));
    expect(defaults.item.quantityDesired).toBe(1);
    expect(defaults.item.priority).toBe(0);
  });
});

// 3 ---------------------------------------------------------------------------
describe("addItem idempotency and products (criterion 3)", () => {
  test("adding an existing product returns alreadyPresent and leaves note/quantity untouched", () => {
    const { db, service, productIds } = setup();
    const p = productIds[0] as string;
    const first = unwrap(service.addItem(S1, null, p, { quantityDesired: 3, note: "first" }));
    expect(first.alreadyPresent).toBe(false);
    const again = unwrap(service.addItem(S1, null, p, { quantityDesired: 7, note: "second", priority: 2 }));
    expect(again.alreadyPresent).toBe(true);
    expect(again.listId).toBe(first.listId);
    expect(again.item.quantityDesired).toBe(3);
    expect(again.item.note).toBe("first");
    expect(again.item.priority).toBe(0);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items")).toBe(1);
  });

  test("unknown, malformed or unpublished products are PRODUCT_NOT_FOUND and write nothing", () => {
    const { db, service, productIds } = setup();
    const list = unwrap(service.createList(S1, "L"));
    expect(errCode(service.addItem(S1, list.id, "no-such-product"))).toBe("PRODUCT_NOT_FOUND");
    expect(errCode(service.addItem(S1, list.id, ""))).toBe("PRODUCT_NOT_FOUND");
    expect(errCode(service.addItem(S1, list.id, "x".repeat(5000)))).toBe("PRODUCT_NOT_FOUND");
    const future = productIds[0] as string;
    db.query("UPDATE products SET published_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(future);
    expect(errCode(service.addItem(S1, list.id, future))).toBe("PRODUCT_NOT_FOUND");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items")).toBe(0);
  });

  test("a failed add to the implicit default list rolls back the list creation", () => {
    const { db, service } = setup();
    expect(errCode(service.addItem(S1, null, "missing"))).toBe("PRODUCT_NOT_FOUND");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists")).toBe(0);
  });

  test("isInDefaultList reflects the default wishlist only", () => {
    const { service, productIds } = setup();
    const [p0, p1] = productIds as [string, string];
    expect(service.isInDefaultList(S1, p0)).toBe(false);
    unwrap(service.addItem(S1, null, p0));
    const other = unwrap(service.createList(S1, "Other"));
    unwrap(service.addItem(S1, other.id, p1));
    expect(service.isInDefaultList(S1, p0)).toBe(true);
    expect(service.isInDefaultList(S1, p1)).toBe(false);
    expect(service.isInDefaultList(S2, p0)).toBe(false);
    expect(service.isInDefaultList(S1, "")).toBe(false);
  });
});

// 4 ---------------------------------------------------------------------------
describe("ownership (criterion 4)", () => {
  test("another session's list id and malformed ids give NOT_FOUND for every operation", () => {
    const { db, service, productIds } = setup();
    const [p0, p1] = productIds as [string, string];
    const mine = unwrap(service.createList(S1, "Mine"));
    unwrap(service.addItem(S1, mine.id, p0, { note: "keep" }));
    const other = unwrap(service.createList(S2, "Other"));
    const before = db.query("SELECT * FROM list_items ORDER BY list_id, product_id").all();
    const beforeLists = db.query("SELECT * FROM lists ORDER BY id").all();

    for (const id of [mine.id, "does-not-exist", "", "x".repeat(10_000), "' OR 1=1 --"]) {
      const results: Result<unknown, AppError>[] = [
        service.getList(S2, id),
        service.renameList(S2, id, "Hacked"),
        service.deleteList(S2, id),
        service.addItem(S2, id, p1),
        service.updateItem(S2, id, p0, { note: "hacked" }),
        service.removeItem(S2, id, p0),
        service.moveItem(S2, id, other.id, p0),
        service.moveItem(S2, other.id, id, p0),
        service.setSharing(S2, id, "enable"),
      ];
      for (const r of results) {
        expect(r.ok).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe("NOT_FOUND");
          expect(r.error.message).toBe("List not found");
        }
      }
    }
    expect(db.query("SELECT * FROM list_items ORDER BY list_id, product_id").all()).toEqual(before);
    expect(db.query("SELECT * FROM lists ORDER BY id").all()).toEqual(beforeLists);
  });

  test("listLists only returns the caller's lists, without owner keys", () => {
    const { service, productIds } = setup();
    unwrap(service.addItem(S1, null, productIds[0] as string));
    unwrap(service.createList(S2, "Theirs"));
    const lists = service.listLists(S1);
    expect(lists).toHaveLength(1);
    expect(lists[0]?.itemCount).toBe(1);
    expect(JSON.stringify(lists)).not.toContain(S1);
  });

  test("listLists orders default first and save for later last", () => {
    const { service } = setup();
    unwrap(service.ensureSaveForLater(S1));
    const a = unwrap(service.createList(S1, "A"));
    const b = unwrap(service.createList(S1, "B"));
    expect(service.listLists(S1).map((l) => l.id)).toEqual([a.id, b.id, unwrap(service.ensureSaveForLater(S1)).id]);
  });
});

// 5 ---------------------------------------------------------------------------
describe("deleting lists (criterion 5)", () => {
  test("the only wishlist (default) cannot be deleted", () => {
    const { db, service } = setup();
    const d = unwrap(service.ensureDefaultList(S1));
    unwrap(service.ensureSaveForLater(S1));
    expect(errCode(service.deleteList(S1, d.id))).toBe("FORBIDDEN");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE id = ?", d.id)).toBe(1);
  });

  test("deleting the default promotes the oldest remaining wishlist", () => {
    const { db, service } = setup();
    const d = unwrap(service.ensureDefaultList(S1));
    const b = unwrap(service.createList(S1, "B"));
    unwrap(service.createList(S1, "C"));
    unwrap(service.deleteList(S1, d.id));
    const now = unwrap(service.ensureDefaultList(S1));
    expect(now.id).toBe(b.id);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND is_default = 1", S1)).toBe(1);
  });

  test("deleting a list deletes only its items", () => {
    const { db, service, productIds } = setup();
    const [p0, p1] = productIds as [string, string];
    const keep = unwrap(service.createList(S1, "Keep"));
    const drop = unwrap(service.createList(S1, "Drop"));
    unwrap(service.addItem(S1, keep.id, p0));
    unwrap(service.addItem(S1, drop.id, p0));
    unwrap(service.addItem(S1, drop.id, p1));
    unwrap(service.addItem(S2, null, p0));
    unwrap(service.deleteList(S1, drop.id));
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", drop.id)).toBe(0);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items")).toBe(2);
    expect(countRows(db, "SELECT COUNT(*) AS n FROM products WHERE id IN (?, ?)", p0, p1)).toBe(2);
  });

  test("rename updates the name and validates it", () => {
    const { service } = setup();
    const l = unwrap(service.createList(S1, "Old"));
    expect(unwrap(service.renameList(S1, l.id, "  New  ")).name).toBe("New");
    expect(errCode(service.renameList(S1, l.id, ""))).toBe("VALIDATION_FAILED");
    expect(errCode(service.renameList(S1, l.id, "y".repeat(61)))).toBe("TOO_LONG");
    expect(unwrap(service.getList(S1, l.id)).name).toBe("New");
  });
});

// 6 ---------------------------------------------------------------------------
describe("sharing (criterion 6)", () => {
  test("enable creates a 22-char base64url token; enable again is idempotent", () => {
    const { service } = setup();
    const l = unwrap(service.createList(S1, "Gifts"));
    const { shareToken } = unwrap(service.setSharing(S1, l.id, "enable"));
    expect(shareToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(unwrap(service.setSharing(S1, l.id, "enable")).shareToken).toBe(shareToken);
    const view = unwrap(service.getList(S1, l.id));
    expect(view.isPublic).toBe(true);
    expect(view.shareToken).toBe(shareToken);
  });

  test("generateShareToken yields 128 random bits", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateShareToken()));
    expect(tokens.size).toBe(500);
    for (const t of tokens) {
      expect(t).toHaveLength(22);
      expect(Buffer.from(t, "base64url")).toHaveLength(16);
    }
  });

  test("getByToken returns a read-only view with no session id, owner details or list id", () => {
    const { db, service, productIds } = setup();
    const [p0] = productIds as [string];
    const l = unwrap(service.createList(S1, "Gifts"));
    unwrap(service.addItem(S1, l.id, p0, { note: "size M", quantityDesired: 2 }));
    insertOrder(db, { id: "o1", session: S1, productId: p0, createdAt: "2999-01-01T00:00:00.000Z" });
    const token = unwrap(service.setSharing(S1, l.id, "enable")).shareToken as string;
    const before = db.query("SELECT * FROM lists ORDER BY id").all();

    const shared = unwrap(service.getByToken(token));
    expect(Object.keys(shared).sort()).toEqual(["itemCount", "items", "name"]);
    expect(shared.name).toBe("Gifts");
    expect(shared.itemCount).toBe(1);
    expect(shared.items[0]?.product?.id).toBe(p0);
    expect(shared.items[0]?.note).toBe("size M");
    expect(shared.items[0]?.listId).toBe("");
    expect(shared.items[0]?.purchasedSinceAdded).toBe(false);
    const json = JSON.stringify(shared);
    expect(json).not.toContain(S1);
    expect(json).not.toContain(l.id);
    expect(json).not.toContain(token);
    expect(db.query("SELECT * FROM lists ORDER BY id").all()).toEqual(before);
  });

  test("disable and rotate invalidate the old token; malformed tokens are NOT_FOUND", () => {
    const { db, service } = setup();
    const l = unwrap(service.createList(S1, "Gifts"));
    const t1 = unwrap(service.setSharing(S1, l.id, "enable")).shareToken as string;
    const t2 = unwrap(service.setSharing(S1, l.id, "rotate")).shareToken as string;
    expect(t2).not.toBe(t1);
    expect(errCode(service.getByToken(t1))).toBe("NOT_FOUND");
    unwrap(service.getByToken(t2));
    expect(unwrap(service.setSharing(S1, l.id, "disable")).shareToken).toBeNull();
    expect(errCode(service.getByToken(t2))).toBe("NOT_FOUND");
    const row = db.query<{ is_public: number; share_token: string | null }, [string]>(
      "SELECT is_public, share_token FROM lists WHERE id = ?",
    ).get(l.id);
    expect(row).toEqual({ is_public: 0, share_token: null });
    for (const bad of [undefined, null, 1, "", "short", "x".repeat(23), "%".repeat(22), `${t2.slice(0, 21)}=`, {}]) {
      expect(errCode(service.getByToken(bad))).toBe("NOT_FOUND");
    }
  });

  test("a share token is never accepted where a list id is expected", () => {
    const { service, productIds } = setup();
    const l = unwrap(service.createList(S1, "Gifts"));
    const token = unwrap(service.setSharing(S1, l.id, "enable")).shareToken as string;
    expect(errCode(service.addItem(S1, token, productIds[0] as string))).toBe("NOT_FOUND");
    expect(errCode(service.addItem(S2, token, productIds[0] as string))).toBe("NOT_FOUND");
    expect(errCode(service.renameList(S1, token, "x"))).toBe("NOT_FOUND");
    expect(errCode(service.deleteList(S1, token))).toBe("NOT_FOUND");
    expect(errCode(service.getList(S1, token))).toBe("NOT_FOUND");
  });

  test("a non-public row with a stale token is not readable", () => {
    const { db, service } = setup();
    const l = unwrap(service.createList(S1, "Gifts"));
    const token = unwrap(service.setSharing(S1, l.id, "enable")).shareToken as string;
    db.query("UPDATE lists SET is_public = 0 WHERE id = ?").run(l.id);
    expect(errCode(service.getByToken(token))).toBe("NOT_FOUND");
  });

  test("unknown sharing modes are rejected", () => {
    const { service } = setup();
    const l = unwrap(service.createList(S1, "Gifts"));
    expect(errCode(service.setSharing(S1, l.id, "publish" as "enable"))).toBe("INVALID_INPUT");
  });
});

// 7 ---------------------------------------------------------------------------
describe("price snapshot and purchases (criterion 7)", () => {
  test("price_at_add_cents is stored at add time and drops are exposed", () => {
    const { db, service, productIds } = setup();
    const [p0, p1, p2] = productIds as [string, string, string];
    const original = price(db, p0);
    const l = unwrap(service.createList(S1, "L"));
    expect(unwrap(service.addItem(S1, l.id, p0)).item.priceAtAddCents).toBe(original);
    unwrap(service.addItem(S1, l.id, p1));
    unwrap(service.addItem(S1, l.id, p2));
    setPrice(db, p0, original - 150);
    setPrice(db, p1, price(db, p1) + 500);
    const items = unwrap(service.getList(S1, l.id)).items;
    const byId = new Map(items.map((i) => [i.productId, i]));
    expect(byId.get(p0)?.priceDroppedByCents).toBe(150);
    expect(byId.get(p0)?.priceAtAddCents).toBe(original);
    expect(byId.get(p1)?.priceDroppedByCents).toBeNull();
    expect(byId.get(p2)?.priceDroppedByCents).toBeNull();
  });

  test("purchasedSinceAdded needs a paid, non-cancelled order of the same owner at or after added_at", () => {
    const addedAt = new Date("2030-06-01T12:00:00.000Z");
    const { db, service, productIds } = setup(() => addedAt);
    const [a, b, c, d, e, f] = productIds as [string, string, string, string, string, string];
    const l = unwrap(service.createList(S1, "L"));
    for (const p of [a, b, c, d, e, f]) unwrap(service.addItem(S1, l.id, p));
    insertOrder(db, { id: "o-a", session: S1, productId: a, createdAt: "2030-06-02T00:00:00.000Z" });
    insertOrder(db, { id: "o-b", session: S1, productId: b, createdAt: "2030-05-31T00:00:00.000Z" }); // before
    insertOrder(db, { id: "o-c", session: S2, productId: c, createdAt: "2030-06-02T00:00:00.000Z" }); // other owner
    insertOrder(db, { id: "o-d", session: S1, productId: d, createdAt: "2030-06-02T00:00:00.000Z", status: "payment_failed" });
    insertOrder(db, { id: "o-e", session: S1, productId: e, createdAt: "2030-06-02T00:00:00.000Z", fulfillment: "cancelled" });
    insertOrder(db, { id: "o-f", session: S1, productId: f, createdAt: "2030-06-01T12:00:00.000Z" }); // equal
    const flags = Object.fromEntries(unwrap(service.getList(S1, l.id)).items.map((i) => [i.productId, i.purchasedSinceAdded]));
    expect(flags).toEqual({ [a]: true, [b]: false, [c]: false, [d]: false, [e]: false, [f]: true });
  });

  test("vanished and out-of-stock products are flagged, total counts existing products only", () => {
    const { db, service, productIds } = setup();
    const [p0, p1, p2] = productIds as [string, string, string];
    const l = unwrap(service.createList(S1, "L"));
    unwrap(service.addItem(S1, l.id, p0, { quantityDesired: 2 }));
    unwrap(service.addItem(S1, l.id, p1));
    unwrap(service.addItem(S1, l.id, p2));
    db.query("UPDATE products SET stock = 0 WHERE id = ?").run(p1);
    // The FK cascades on product delete, so simulate a vanished product with FKs off.
    db.run("PRAGMA foreign_keys = OFF");
    db.query("DELETE FROM products WHERE id = ?").run(p2);
    db.run("PRAGMA foreign_keys = ON");
    const view = unwrap(service.getList(S1, l.id));
    const byId = new Map(view.items.map((i) => [i.productId, i]));
    expect(byId.get(p0)?.available).toBe(true);
    expect(byId.get(p1)?.available).toBe(false);
    expect(byId.get(p2)?.product).toBeNull();
    expect(byId.get(p2)?.available).toBe(false);
    expect(byId.get(p2)?.priceDroppedByCents).toBeNull();
    expect(view.itemCount).toBe(3);
    expect(view.totalCents).toBe(price(db, p0) * 2 + price(db, p1));
  });
});

// 8 ---------------------------------------------------------------------------
describe("sorting (criterion 8)", () => {
  function sortedSetup() {
    let t = Date.parse("2030-01-01T00:00:00.000Z");
    const { db, service, productIds } = setup(() => new Date((t += 1000)));
    const [a, b, c] = productIds as [string, string, string];
    setPrice(db, a, 300);
    setPrice(db, b, 100);
    setPrice(db, c, 200);
    const l = unwrap(service.createList(S1, "L"));
    unwrap(service.addItem(S1, l.id, a, { priority: 1 }));
    unwrap(service.addItem(S1, l.id, b, { priority: 2 }));
    unwrap(service.addItem(S1, l.id, c, { priority: 1 }));
    return { service, list: l, a, b, c };
  }

  test("added_desc, price_asc, price_desc, priority", () => {
    const { service, list, a, b, c } = sortedSetup();
    const order = (sort?: string) => unwrap(service.getList(S1, list.id, sort)).items.map((i) => i.productId);
    expect(order("added_desc")).toEqual([c, b, a]);
    expect(order("price_asc")).toEqual([b, c, a]);
    expect(order("price_desc")).toEqual([a, c, b]);
    expect(order("priority")).toEqual([b, c, a]);
    expect(order()).toEqual([c, b, a]);
    expect(order("bogus")).toEqual([c, b, a]);
    expect(order("__proto__")).toEqual([c, b, a]);
  });

  test("getByToken honours the sort too", () => {
    const { service, list, a, b, c } = sortedSetup();
    const token = unwrap(service.setSharing(S1, list.id, "enable")).shareToken as string;
    expect(unwrap(service.getByToken(token, "price_asc")).items.map((i) => i.productId)).toEqual([b, c, a]);
    expect(unwrap(service.getByToken(token, "nope")).items.map((i) => i.productId)).toEqual([c, b, a]);
  });
});

// 9 ---------------------------------------------------------------------------
describe("moving items (criterion 9)", () => {
  test("move to a list without the item carries the snapshot over", () => {
    const { db, service, productIds } = setup();
    const p = productIds[0] as string;
    const from = unwrap(service.createList(S1, "From"));
    const to = unwrap(service.createList(S1, "To"));
    const added = unwrap(service.addItem(S1, from.id, p, { quantityDesired: 4, priority: 2, note: "n" })).item;
    unwrap(service.moveItem(S1, from.id, to.id, p));
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", from.id)).toBe(0);
    const moved = unwrap(service.getList(S1, to.id)).items[0];
    expect(moved?.quantityDesired).toBe(4);
    expect(moved?.priority).toBe(2);
    expect(moved?.note).toBe("n");
    expect(moved?.priceAtAddCents).toBe(added.priceAtAddCents);
    expect(moved?.addedAt).toBe(added.addedAt);
  });

  test("move to a list that already holds it merges keeping the larger quantity", () => {
    const { db, service, productIds } = setup();
    const [p, q] = productIds as [string, string];
    const from = unwrap(service.createList(S1, "From"));
    const to = unwrap(service.createList(S1, "To"));
    unwrap(service.addItem(S1, from.id, p, { quantityDesired: 5, note: "from-note" }));
    unwrap(service.addItem(S1, to.id, p, { quantityDesired: 2 }));
    unwrap(service.moveItem(S1, from.id, to.id, p));
    let target = unwrap(service.getList(S1, to.id)).items;
    expect(target).toHaveLength(1);
    expect(target[0]?.quantityDesired).toBe(5);
    expect(target[0]?.note).toBe("from-note");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", from.id)).toBe(0);

    unwrap(service.addItem(S1, from.id, q, { quantityDesired: 1 }));
    unwrap(service.addItem(S1, to.id, q, { quantityDesired: 9, note: "keep" }));
    unwrap(service.moveItem(S1, from.id, to.id, q));
    target = unwrap(service.getList(S1, to.id)).items;
    const merged = target.find((i) => i.productId === q);
    expect(merged?.quantityDesired).toBe(9);
    expect(merged?.note).toBe("keep");
  });

  test("move into save for later and back; same list is a no-op; missing item is NOT_FOUND", () => {
    const { db, service, productIds } = setup();
    const p = productIds[0] as string;
    const wish = unwrap(service.addItem(S1, null, p)).listId;
    const sfl = unwrap(service.ensureSaveForLater(S1)).id;
    unwrap(service.moveItem(S1, wish, sfl, p));
    expect(service.isInDefaultList(S1, p)).toBe(false);
    unwrap(service.moveItem(S1, sfl, wish, p));
    expect(service.isInDefaultList(S1, p)).toBe(true);
    unwrap(service.moveItem(S1, wish, wish, p));
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items")).toBe(1);
    expect(errCode(service.moveItem(S1, sfl, wish, p))).toBe("NOT_FOUND");
  });

  test("move into a full list is LIMIT_REACHED and leaves the source intact", () => {
    const { db, service, productIds } = setup();
    const ids = [...productIds, ...insertExtraProducts(db, MAX_ITEMS_PER_LIST + 1 - productIds.length)];
    const full = unwrap(service.createList(S1, "Full"));
    const from = unwrap(service.createList(S1, "From"));
    for (let i = 0; i < MAX_ITEMS_PER_LIST; i++) unwrap(service.addItem(S1, full.id, ids[i] as string));
    const last = ids[MAX_ITEMS_PER_LIST] as string;
    unwrap(service.addItem(S1, from.id, last));
    expect(errCode(service.moveItem(S1, from.id, full.id, last))).toBe("LIMIT_REACHED");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", from.id)).toBe(1);
  });
});

describe("updateItem / removeItem", () => {
  test("updateItem patches only the given fields", () => {
    const { service, productIds } = setup();
    const p = productIds[0] as string;
    const { listId } = unwrap(service.addItem(S1, null, p, { quantityDesired: 2, note: "a" }));
    const u1 = unwrap(service.updateItem(S1, listId, p, { priority: 2 }));
    expect(u1).toMatchObject({ quantityDesired: 2, priority: 2, note: "a" });
    const u2 = unwrap(service.updateItem(S1, listId, p, { quantityDesired: 5, note: null }));
    expect(u2).toMatchObject({ quantityDesired: 5, priority: 2, note: null });
    const u3 = unwrap(service.updateItem(S1, listId, p, { note: "  hi  " }));
    expect(u3.note).toBe("hi");
    expect(unwrap(service.updateItem(S1, listId, p, {}))).toEqual(u3);
  });

  test("updateItem validates and reports missing items", () => {
    const { db, service, productIds } = setup();
    const [p, q] = productIds as [string, string];
    const { listId } = unwrap(service.addItem(S1, null, p));
    expect(errCode(service.updateItem(S1, listId, p, { quantityDesired: 0 }))).toBe("INVALID_QUANTITY");
    expect(errCode(service.updateItem(S1, listId, p, { priority: 5 }))).toBe("VALIDATION_FAILED");
    expect(errCode(service.updateItem(S1, listId, p, { note: "z".repeat(201) }))).toBe("TOO_LONG");
    expect(errCode(service.updateItem(S1, listId, q, { priority: 1 }))).toBe("NOT_FOUND");
    expect(db.query("SELECT quantity_desired, priority, note FROM list_items").get()).toEqual({
      quantity_desired: 1,
      priority: 0,
      note: null,
    });
  });

  test("removeItem deletes the row and is idempotent", () => {
    const { db, service, productIds } = setup();
    const p = productIds[0] as string;
    const { listId } = unwrap(service.addItem(S1, null, p));
    unwrap(service.removeItem(S1, listId, p));
    unwrap(service.removeItem(S1, listId, p));
    unwrap(service.removeItem(S1, listId, "never-there"));
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items")).toBe(0);
  });
});

describe("failure paths", () => {
  test("a database error inside a mutation propagates and rolls back", () => {
    const { db, service, productIds } = setup();
    const p = productIds[0] as string;
    const l = unwrap(service.createList(S1, "L"));
    db.run(
      "CREATE TRIGGER boom BEFORE INSERT ON list_items BEGIN SELECT RAISE(ABORT, 'disk on fire'); END",
    );
    expect(() => service.addItem(S1, l.id, p)).toThrow("disk on fire");
    expect(countRows(db, "SELECT COUNT(*) AS n FROM list_items")).toBe(0);
    expect(unwrap(service.getList(S1, l.id)).updatedAt).toBe(l.updatedAt);
  });

  test("getList reports MONEY_OVERFLOW instead of an unsafe total", () => {
    const { db, service, productIds } = setup();
    const p = productIds[0] as string;
    const l = unwrap(service.createList(S1, "L"));
    unwrap(service.addItem(S1, l.id, p, { quantityDesired: 99 }));
    db.query("UPDATE products SET price_cents = ?, list_price_cents = NULL WHERE id = ?").run(Number.MAX_SAFE_INTEGER, p);
    expect(errCode(service.getList(S1, l.id))).toBe("MONEY_OVERFLOW");
  });
});

describe("getListService", () => {
  test("returns a cached singleton over the shared database", () => {
    const prev = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ":memory:";
    try {
      const a = getListService();
      const b = getListService();
      expect(a).toBe(b);
      expect(a.listLists(S1)).toEqual([]);
    } finally {
      closeDatabase();
      if (prev === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = prev;
    }
  });
});
