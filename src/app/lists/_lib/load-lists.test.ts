import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createListService, type ListService } from "@/server/lists/list-service";

import { loadListsIndex, loadOwnerList, loadSharedList } from "./load-lists";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const TOTE = "prod_canvas-tote-bag";
const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const NOW = new Date("2031-01-01T00:00:00.000Z");

let open: Database[] = [];

function setup(): { db: Database; lists: ListService } {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  open.push(db);
  return { db, lists: createListService({ db, now: () => new Date("2030-06-01T12:00:00.000Z") }) };
}

afterEach(() => {
  for (const db of open) db.close();
  open = [];
});

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.value;
}

function countLists(db: Database): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM lists").get()?.n ?? -1;
}

describe("loadListsIndex", () => {
  test("no owner key -> empty, without touching the database (criterion 4)", () => {
    const { db } = setup();
    const query = spyOn(db, "query");
    expect(loadListsIndex({ sessionId: null, now: NOW }, { db })).toEqual({ kind: "empty", hasSession: false });
    expect(loadListsIndex({ sessionId: "not-a-uuid", now: NOW }, { db })).toEqual({ kind: "empty", hasSession: false });
    expect(query).not.toHaveBeenCalled();
    expect(countLists(db)).toBe(0);
  });

  test("owner without lists -> empty with session, and creates nothing", () => {
    const { db } = setup();
    expect(loadListsIndex({ sessionId: S1, now: NOW }, { db })).toEqual({ kind: "empty", hasSession: true });
    expect(countLists(db)).toBe(0);
  });

  test("exactly one list -> single", () => {
    const { db, lists } = setup();
    const only = unwrap(lists.createList(S1, "Gifts"));
    const data = loadListsIndex({ sessionId: S1, now: NOW }, { db });
    expect(data.kind).toBe("single");
    if (data.kind !== "single") return;
    expect(data.listId).toBe(only.id);
    expect(data.lists.map((l) => l.name)).toEqual(["Gifts"]);
  });

  test("several lists -> index of own lists only, without share tokens", () => {
    const { db, lists } = setup();
    const gifts = unwrap(lists.createList(S1, "Gifts"));
    unwrap(lists.addItem(S1, gifts.id, TOTE));
    unwrap(lists.setSharing(S1, gifts.id, "enable"));
    unwrap(lists.ensureSaveForLater(S1));
    unwrap(lists.createList(S2, "Not mine"));
    const data = loadListsIndex({ sessionId: S1, now: NOW }, { db });
    expect(data.kind).toBe("index");
    if (data.kind !== "index") return;
    expect(data.lists.map((l) => [l.name, l.kind, l.itemCount, l.isDefault, l.isPublic])).toEqual([
      ["Gifts", "wishlist", 1, true, true],
      ["Saved for later", "save_for_later", 0, false, false],
    ]);
    for (const list of data.lists) expect(Object.keys(list).sort()).toEqual(["id", "isDefault", "isPublic", "itemCount", "kind", "name"]);
    expect(JSON.stringify(data)).not.toContain(S1);
  });
});

describe("loadOwnerList (criterion 1)", () => {
  test("own list loads with the requested sort and all the owner's lists", () => {
    const { db, lists } = setup();
    const a = unwrap(lists.createList(S1, "A"));
    const b = unwrap(lists.createList(S1, "B"));
    unwrap(lists.addItem(S1, a.id, TOTE));
    unwrap(lists.addItem(S1, a.id, POUR_OVER));
    const data = loadOwnerList({ sessionId: S1, id: a.id, sort: "price_asc", now: NOW }, { db });
    expect(data?.list.id).toBe(a.id);
    const prices = (data?.list.items ?? []).map((i) => i.product?.priceCents ?? 0);
    expect(prices).toEqual([...prices].sort((x, y) => x - y));
    expect(data?.otherLists.map((l) => l.id)).toEqual([a.id, b.id]);
  });

  test("another owner's id, unknown id, malformed id and no cookie are all null", () => {
    const { db, lists } = setup();
    const mine = unwrap(lists.createList(S1, "Mine"));
    const theirs = unwrap(lists.createList(S2, "Theirs"));
    const shared = unwrap(lists.setSharing(S2, theirs.id, "enable")).shareToken ?? "";
    const before = countLists(db);
    for (const input of [
      { sessionId: S1, id: theirs.id },
      { sessionId: S1, id: crypto.randomUUID() },
      { sessionId: S1, id: "not-an-id" },
      { sessionId: S1, id: shared },
      { sessionId: null, id: mine.id },
      { sessionId: "garbage", id: mine.id },
    ]) {
      expect(loadOwnerList({ ...input, sort: "added_desc", now: NOW }, { db })).toBeNull();
    }
    expect(countLists(db)).toBe(before);
  });

  test("malformed id or missing owner key never queries the database", () => {
    const { db, lists } = setup();
    const mine = unwrap(lists.createList(S1, "Mine"));
    const query = spyOn(db, "query");
    expect(loadOwnerList({ sessionId: S1, id: "../x", sort: "added_desc", now: NOW }, { db })).toBeNull();
    expect(loadOwnerList({ sessionId: null, id: mine.id, sort: "added_desc", now: NOW }, { db })).toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  test("price-drop, purchased and stock states come from the service view (criterion 5)", () => {
    const { db, lists } = setup();
    const l = unwrap(lists.createList(S1, "L"));
    unwrap(lists.addItem(S1, l.id, TOTE));
    unwrap(lists.addItem(S1, l.id, POUR_OVER));
    db.query("UPDATE products SET price_cents = price_cents - 500 WHERE id = ?").run(TOTE);
    db.query(
      `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
         region, postal_code, country, card_last4, idempotency_key, created_at, fulfillment_status)
       VALUES ('o-1', ?, 'paid', 100, 100, 'USD', 'A', 'a@b.co', 'l1', 'c', 'r', 'p', 'US', '4242', 'idem-1', '2030-07-01T00:00:00.000Z', 'processing')`,
    ).run(S1);
    db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES ('o-1', ?, 'n', 100, 1)").run(TOTE);
    const items = new Map((loadOwnerList({ sessionId: S1, id: l.id, sort: "added_desc", now: NOW }, { db })?.list.items ?? []).map((i) => [i.productId, i]));
    expect(items.get(TOTE)).toMatchObject({ priceDroppedByCents: 500, purchasedSinceAdded: true, available: true });
    expect(items.get(POUR_OVER)).toMatchObject({ priceDroppedByCents: null, purchasedSinceAdded: false, available: false });
  });

  test("service faults other than not-found propagate (error boundary, not a 404)", () => {
    const { db, lists } = setup();
    const l = unwrap(lists.createList(S1, "L"));
    unwrap(lists.addItem(S1, l.id, TOTE, { quantityDesired: 99 }));
    db.query("UPDATE products SET price_cents = ? WHERE id = ?").run(Number.MAX_SAFE_INTEGER, TOTE);
    expect(() => loadOwnerList({ sessionId: S1, id: l.id, sort: "added_desc", now: NOW }, { db })).toThrow("MONEY_OVERFLOW");
  });
});

describe("loadSharedList (criterion 2)", () => {
  test("active token loads without an owner key; rotate and revoke make old tokens null", () => {
    const { db, lists } = setup();
    const l = unwrap(lists.createList(S1, "Birthday"));
    unwrap(lists.addItem(S1, l.id, TOTE, { note: "size M" }));
    const first = unwrap(lists.setSharing(S1, l.id, "enable")).shareToken ?? "";
    const view = loadSharedList({ token: first, sort: "added_desc", now: NOW }, { db });
    expect(view?.name).toBe("Birthday");
    expect(view?.items.map((i) => [i.productId, i.listId, i.purchasedSinceAdded, i.note])).toEqual([[TOTE, "", false, "size M"]]);
    expect(JSON.stringify(view)).not.toContain(S1);
    expect(JSON.stringify(view)).not.toContain(l.id);

    const second = unwrap(lists.setSharing(S1, l.id, "rotate")).shareToken ?? "";
    expect(second).not.toBe(first);
    expect(loadSharedList({ token: first, sort: "added_desc", now: NOW }, { db })).toBeNull();
    expect(loadSharedList({ token: second, sort: "added_desc", now: NOW }, { db })?.name).toBe("Birthday");

    unwrap(lists.setSharing(S1, l.id, "disable"));
    expect(loadSharedList({ token: second, sort: "added_desc", now: NOW }, { db })).toBeNull();
  });

  test("malformed and unknown tokens are null; malformed never queries", () => {
    const { db } = setup();
    expect(loadSharedList({ token: "A".repeat(22), sort: "added_desc", now: NOW }, { db })).toBeNull();
    const query = spyOn(db, "query");
    for (const token of ["", "short", "A".repeat(23), S1, "abcdefghijklmnopqrstu="]) {
      expect(loadSharedList({ token, sort: "added_desc", now: NOW }, { db })).toBeNull();
    }
    expect(query).not.toHaveBeenCalled();
  });
});
