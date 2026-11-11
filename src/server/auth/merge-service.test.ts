import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { DEFAULT_MAX_QUANTITY } from "@/lib/validation";
import { closeDatabase, createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createAuthRepository } from "./auth-repository";
import {
  createMergeService,
  DELETED_OWNER_KEY,
  EMPTY_MERGE_SUMMARY,
  getMergeService,
  type MergeService,
  type MergeSummary,
} from "./merge-service";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = 1_800_000_000_000;
const G = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // merging guest
const H = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // bystander guest

interface Env {
  db: Database;
  svc: MergeService;
  KA: string;
  KB: string;
  logs: unknown[][];
}

function makeEnv(): Env {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(T0) });
  const auth = createAuthRepository(db);
  const a = auth.createUser({ email: "a@example.com", passwordHash: "x", displayName: "A" }, T0);
  const b = auth.createUser({ email: "b@example.com", passwordHash: "x", displayName: "B" }, T0);
  if (!a.ok || !b.ok) throw new Error("fixture users");
  const logs: unknown[][] = [];
  const svc = createMergeService({ db, logger: { error: (...args: unknown[]) => void logs.push(args) } });
  return { db, svc, KA: a.value.ownerKey, KB: b.value.ownerKey, logs };
}

const iso = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();

let idSeq = 0;
const nextId = (prefix: string): string => `${prefix}_${++idSeq}`;

function products(db: Database, n: number, offset = 0): string[] {
  const rows = db
    .query<{ id: string }, [number, number]>("SELECT id FROM products WHERE stock > 0 ORDER BY id LIMIT ? OFFSET ?")
    .all(n, offset)
    .map((r) => r.id);
  if (rows.length < n) throw new Error(`fixture needs ${n} products`);
  return rows;
}

function addProducts(db: Database, n: number, stock = 10): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = nextId("prod_t");
    db.run(
      "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 100, 'USD', '/x.svg', ?)",
      [id, id.replace(/_/g, "-"), `Test ${id}`, stock],
    );
    ids.push(id);
  }
  return ids;
}

function setStock(db: Database, productId: string, stock: number): void {
  db.run("UPDATE products SET stock = ? WHERE id = ?", [stock, productId]);
}

function cart(db: Database, key: string, coupon: string | null = null, shipping: string | null = null): void {
  db.run("INSERT INTO carts (session_id, coupon_code, shipping_method_id) VALUES (?, ?, ?)", [key, coupon, shipping]);
}
function line(db: Database, key: string, productId: string, qty: number): void {
  db.run("INSERT INTO cart_items (cart_session_id, product_id, quantity) VALUES (?, ?, ?)", [key, productId, qty]);
}
function list(
  db: Database,
  key: string,
  name: string,
  opts: { kind?: "wishlist" | "save_for_later"; isDefault?: boolean; createdAt?: string } = {},
): string {
  const id = nextId("list");
  db.run("INSERT INTO lists (id, session_id, name, kind, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id,
    key,
    name,
    opts.kind ?? "wishlist",
    opts.isDefault === true ? 1 : 0,
    opts.createdAt ?? iso(idSeq),
  ]);
  return id;
}
function item(db: Database, listId: string, productId: string, opts: { note?: string; priority?: number; addedAt?: string } = {}): void {
  db.run(
    "INSERT INTO list_items (list_id, product_id, priority, price_at_add_cents, note, added_at) VALUES (?, ?, ?, 100, ?, ?)",
    [listId, productId, opts.priority ?? 0, opts.note ?? null, opts.addedAt ?? iso(idSeq++)],
  );
}
function view(db: Database, key: string, productId: string, at: string): void {
  db.run("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)", [key, productId, at]);
}
function review(db: Database, key: string, productId: string, rating: number, body = ""): string {
  const id = nextId("rev");
  db.run("INSERT INTO reviews (id, product_id, session_id, display_name, rating, body) VALUES (?, ?, ?, 'N', ?, ?)", [
    id,
    productId,
    key,
    rating,
    body,
  ]);
  return id;
}
function reviewVote(db: Database, reviewId: string, key: string): void {
  db.run("INSERT INTO review_votes (review_id, session_id) VALUES (?, ?)", [reviewId, key]);
}
function question(db: Database, key: string, productId: string): string {
  const id = nextId("q");
  db.run("INSERT INTO questions (id, product_id, session_id, display_name, body) VALUES (?, ?, ?, 'N', 'Q?')", [id, productId, key]);
  return id;
}
function answer(db: Database, key: string, questionId: string): string {
  const id = nextId("a");
  db.run("INSERT INTO answers (id, question_id, session_id, display_name, body) VALUES (?, ?, ?, 'N', 'A.')", [id, questionId, key]);
  return id;
}
function alert(db: Database, key: string, productId: string, createdAt = iso(idSeq)): string {
  const id = nextId("alert");
  db.run("INSERT INTO stock_alerts (id, product_id, session_id, created_at) VALUES (?, ?, ?, ?)", [id, productId, key, createdAt]);
  return id;
}
function message(db: Database, key: string | null): string {
  const id = nextId("msg");
  db.run(
    "INSERT INTO contact_messages (id, reference, session_id, name, email, topic, message) VALUES (?, ?, ?, 'N', 'n@example.com', 'other', 'Hello')",
    [id, `C-${id}`, key],
  );
  return id;
}
interface AddressOpts {
  fullName?: string;
  line1?: string;
  postal?: string;
  country?: string;
  isDefault?: boolean;
  createdAt?: string;
}
function address(db: Database, key: string, opts: AddressOpts = {}): string {
  const id = nextId("addr");
  db.run(
    `INSERT INTO addresses (id, session_id, full_name, line1, city, region, postal_code, country, is_default, created_at)
     VALUES (?, ?, ?, ?, 'City', 'Region', ?, ?, ?, ?)`,
    [
      id,
      key,
      opts.fullName ?? `Name ${id}`,
      opts.line1 ?? `${id} Street`,
      opts.postal ?? "12345",
      opts.country ?? "US",
      opts.isDefault === true ? 1 : 0,
      opts.createdAt ?? iso(idSeq),
    ],
  );
  return id;
}
function order(db: Database, key: string, productId: string): string {
  const id = nextId("ord");
  db.run(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city, region,
                         postal_code, country, card_last4, idempotency_key)
     VALUES (?, ?, 'paid', 1000, 1200, 'USD', 'N', 'n@example.com', 'L1', 'C', 'R', 'P', 'US', '4242', ?)`,
    [id, key, `idem_${id}`],
  );
  db.run("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'P', 500, 2)", [id, productId]);
  db.run("INSERT INTO order_events (order_id, status, at) VALUES (?, 'processing', ?)", [id, iso(0)]);
  return id;
}
function redemption(db: Database, key: string, code: string): void {
  db.run("INSERT INTO coupon_redemptions (coupon_code, session_id) VALUES (?, ?)", [code, key]);
}

const count = (db: Database, sql: string, ...params: string[]): number =>
  db.query<{ n: number }, string[]>(sql).get(...params)?.n ?? 0;

/** Owner tables and how to select a key's rows (children through their parent). */
const OWNER_SELECTS: Record<string, string> = {
  carts: "SELECT * FROM carts WHERE session_id = ?1 ORDER BY rowid",
  cart_items: "SELECT * FROM cart_items WHERE cart_session_id = ?1 ORDER BY rowid",
  lists: "SELECT * FROM lists WHERE session_id = ?1 ORDER BY rowid",
  list_items: "SELECT li.* FROM list_items li JOIN lists l ON l.id = li.list_id WHERE l.session_id = ?1 ORDER BY li.rowid",
  product_views: "SELECT * FROM product_views WHERE session_id = ?1 ORDER BY rowid",
  reviews: "SELECT * FROM reviews WHERE session_id = ?1 ORDER BY rowid",
  review_votes: "SELECT * FROM review_votes WHERE session_id = ?1 ORDER BY rowid",
  questions: "SELECT * FROM questions WHERE session_id = ?1 ORDER BY rowid",
  answers: "SELECT * FROM answers WHERE session_id = ?1 ORDER BY rowid",
  question_votes: "SELECT * FROM question_votes WHERE session_id = ?1 ORDER BY rowid",
  answer_votes: "SELECT * FROM answer_votes WHERE session_id = ?1 ORDER BY rowid",
  stock_alerts: "SELECT * FROM stock_alerts WHERE session_id = ?1 ORDER BY rowid",
  contact_messages: "SELECT * FROM contact_messages WHERE session_id = ?1 ORDER BY rowid",
  addresses: "SELECT * FROM addresses WHERE session_id = ?1 ORDER BY rowid",
  orders: "SELECT * FROM orders WHERE session_id = ?1 ORDER BY rowid",
  order_items: "SELECT oi.* FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.session_id = ?1 ORDER BY oi.rowid",
  order_events: "SELECT oe.* FROM order_events oe JOIN orders o ON o.id = oe.order_id WHERE o.session_id = ?1 ORDER BY oe.id",
  coupon_redemptions: "SELECT * FROM coupon_redemptions WHERE session_id = ?1 ORDER BY rowid",
};

function snapshot(db: Database, key: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [table, sql] of Object.entries(OWNER_SELECTS)) out[table] = db.query(sql).all(key);
  return out;
}

function counts(db: Database, key: string): Record<string, number> {
  const snap = snapshot(db, key);
  return Object.fromEntries(Object.entries(snap).map(([t, rows]) => [t, rows.length]));
}

/** Every real table (FTS shadow tables excluded), every row. */
function fullSnapshot(db: Database): Record<string, unknown[]> {
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'products_fts%' ORDER BY name",
    )
    .all()
    .map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = db.query(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  return out;
}

/** Derived counters must equal a fresh aggregate (PLAN row D). */
function expectAggregatesConsistent(db: Database): void {
  expect(
    count(
      db,
      `SELECT COUNT(*) AS n FROM products p
        WHERE p.rating_count <> (SELECT COUNT(*) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')
           OR p.rating_sum <> (SELECT COALESCE(SUM(rating), 0) FROM reviews r WHERE r.product_id = p.id AND r.status = 'published')`,
    ),
  ).toBe(0);
  for (const [target, votes, fk] of [
    ["reviews", "review_votes", "review_id"],
    ["questions", "question_votes", "question_id"],
    ["answers", "answer_votes", "answer_id"],
  ] as const) {
    expect(
      count(db, `SELECT COUNT(*) AS n FROM ${target} t WHERE t.helpful_count <> (SELECT COUNT(*) FROM ${votes} v WHERE v.${fk} = t.id)`),
    ).toBe(0);
  }
}

/**
 * Seeded votes are inserted with explicit helpful counts that may not equal
 * the vote rows; align them so aggregate assertions start from a consistent DB.
 */
function normaliseSeedCounters(db: Database): void {
  db.run("UPDATE reviews SET helpful_count = (SELECT COUNT(*) FROM review_votes v WHERE v.review_id = reviews.id)");
  db.run("UPDATE questions SET helpful_count = (SELECT COUNT(*) FROM question_votes v WHERE v.question_id = questions.id)");
  db.run("UPDATE answers SET helpful_count = (SELECT COUNT(*) FROM answer_votes v WHERE v.answer_id = answers.id)");
}

function mustMerge(env: Env, guest = G, owner = env.KA): MergeSummary {
  const r = env.svc.mergeGuestIntoUser(guest, owner, T0 + 1000);
  if (!r.ok) throw new Error(`merge failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** One row per owner table for `key`, products chosen by `slot` so identities do not collide. */
function seedIdentity(env: Env, key: string, slot: number): void {
  const { db } = env;
  const [p1, p2, p3] = products(db, 3, slot * 3);
  if (p1 === undefined || p2 === undefined || p3 === undefined) throw new Error("products");
  const shared = products(db, 1, 40)[0] ?? "";
  cart(db, key, "SAVE5", null);
  line(db, key, p1, 1);
  const wl = list(db, key, "Shopping List", { isDefault: true });
  item(db, wl, p1);
  item(db, wl, shared, { note: `note-${slot}` });
  const sfl = list(db, key, "Saved for later", { kind: "save_for_later" });
  item(db, sfl, p2);
  list(db, key, `Gifts`);
  view(db, key, p1, iso(slot));
  view(db, key, shared, iso(slot + 10));
  review(db, key, shared, 2 + slot, `review-${slot}`);
  const seedReviewId = db.query<{ id: string }, []>("SELECT id FROM reviews WHERE id LIKE 'rev_seed_%' ORDER BY id LIMIT 1").get()?.id ?? "";
  reviewVote(db, seedReviewId, key);
  const q = question(db, key, p2);
  answer(db, key, q);
  const seedQ = db.query<{ id: string }, []>("SELECT id FROM questions WHERE id LIKE 'q_seed_%' ORDER BY id LIMIT 1").get()?.id ?? "";
  db.run("INSERT INTO question_votes (question_id, session_id) VALUES (?, ?)", [seedQ, key]);
  const seedA = db.query<{ id: string }, []>("SELECT id FROM answers WHERE id LIKE 'a_seed_%' ORDER BY id LIMIT 1").get()?.id ?? "";
  db.run("INSERT INTO answer_votes (answer_id, session_id) VALUES (?, ?)", [seedA, key]);
  alert(db, key, p3);
  message(db, key);
  address(db, key, { fullName: "Same Person", line1: "1 Shared Rd", isDefault: true });
  order(db, key, p1);
  redemption(db, key, "SAVE5");
  db.run("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 3)", [`900:review:${key}`, T0]);
}

let env: Env;
beforeEach(() => {
  env = makeEnv();
  normaliseSeedCounters(env.db);
});
afterEach(() => {
  env.db.close();
});

// ---------------------------------------------------------------------------
// Guards (criterion 8, A-64)
// ---------------------------------------------------------------------------

describe("guards (A-64)", () => {
  test("invalid inputs return VALIDATION_FAILED and change nothing", () => {
    seedIdentity(env, G, 0);
    seedIdentity(env, env.KA, 1);
    seedIdentity(env, env.KB, 2);
    const before = fullSnapshot(env.db);
    const cases: [unknown, unknown, string][] = [
      ["not-a-uuid", env.KA, "invalid_guest_id"],
      [G.toUpperCase(), env.KA, "invalid_guest_id"],
      [G, "x", "invalid_owner_key"],
      [G, undefined, "invalid_owner_key"],
      [42, env.KA, "invalid_guest_id"],
      [env.KA, env.KA, "same_id"],
      [env.KB, env.KA, "guest_is_owner_key"],
      [DELETED_OWNER_KEY, env.KA, "guest_is_owner_key"],
      [G, H, "unknown_owner"],
      [G, DELETED_OWNER_KEY, "unknown_owner"],
    ];
    for (const [guest, owner, reason] of cases) {
      const r = env.svc.mergeGuestIntoUser(guest, owner, T0);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("VALIDATION_FAILED");
        expect(r.error.details).toEqual({ reason });
      }
    }
    expect(fullSnapshot(env.db)).toEqual(before);
  });

  test("a non-finite clock is rejected without writes", () => {
    seedIdentity(env, G, 0);
    const before = fullSnapshot(env.db);
    const r = env.svc.mergeGuestIntoUser(G, env.KA, Number.NaN);
    expect(r.ok).toBe(false);
    expect(fullSnapshot(env.db)).toEqual(before);
  });

  test("B's data never moves to A when B's owner key is passed as the guest id (K-4)", () => {
    seedIdentity(env, env.KB, 2);
    const before = snapshot(env.db, env.KB);
    expect(env.svc.mergeGuestIntoUser(env.KB, env.KA, T0).ok).toBe(false);
    expect(snapshot(env.db, env.KB)).toEqual(before);
    expect(counts(env.db, env.KA).orders).toBe(0);
  });

  test("an empty guest merges to the all-zero summary without creating rows", () => {
    const before = fullSnapshot(env.db);
    expect(mustMerge(env)).toEqual(EMPTY_MERGE_SUMMARY);
    expect(fullSnapshot(env.db)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Carts (A-46..A-48, K-7)
// ---------------------------------------------------------------------------

describe("carts", () => {
  test("A-46: {A x2, B x1} + {A x3}, stock A=4 -> {A x4, B x1}", () => {
    const [a, b] = products(env.db, 2);
    if (a === undefined || b === undefined) throw new Error("products");
    setStock(env.db, a, 4);
    setStock(env.db, b, 10);
    cart(env.db, G);
    line(env.db, G, a, 2);
    line(env.db, G, b, 1);
    cart(env.db, env.KA);
    line(env.db, env.KA, a, 3);
    const s = mustMerge(env);
    expect(s.movedCartLines).toBe(2);
    expect(s.droppedCartLines).toEqual([]);
    expect(
      env.db.query("SELECT cart_session_id, product_id, quantity FROM cart_items ORDER BY product_id").all(),
    ).toEqual(
      [
        { cart_session_id: env.KA, product_id: a, quantity: 4 },
        { cart_session_id: env.KA, product_id: b, quantity: 1 },
      ].sort((x, y) => (x.product_id < y.product_id ? -1 : 1)),
    );
    expect(count(env.db, "SELECT COUNT(*) AS n FROM carts WHERE session_id = ?", G)).toBe(0);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM carts WHERE session_id = ?", env.KA)).toBe(1);
  });

  test("A-47: stock-0 guest line is dropped and reported; no zero-quantity row", () => {
    const [a, b] = products(env.db, 2);
    if (a === undefined || b === undefined) throw new Error("products");
    setStock(env.db, a, 0);
    cart(env.db, G);
    line(env.db, G, a, 2);
    line(env.db, G, b, 1);
    const s = mustMerge(env);
    expect(s.droppedCartLines).toEqual([{ productId: a, reason: "out_of_stock" }]);
    expect(s.movedCartLines).toBe(1);
    expect(env.db.query("SELECT product_id FROM cart_items").all()).toEqual([{ product_id: b }]);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM cart_items WHERE quantity <= 0")).toBe(0);
  });

  test("guest line over stock with no user line is capped at stock", () => {
    const [a] = products(env.db, 1);
    if (a === undefined) throw new Error("products");
    setStock(env.db, a, 3);
    cart(env.db, G);
    line(env.db, G, a, 3);
    setStock(env.db, a, 2); // stock fell after the guest added it
    mustMerge(env);
    expect(env.db.query("SELECT quantity FROM cart_items WHERE cart_session_id = ?").get(env.KA)).toEqual({ quantity: 2 });
  });

  test("A-48: guest coupon used only when the user's is NULL", () => {
    cart(env.db, G, "SAVE5");
    cart(env.db, env.KA, null);
    mustMerge(env);
    expect(env.db.query("SELECT coupon_code FROM carts WHERE session_id = ?").get(env.KA)).toEqual({ coupon_code: "SAVE5" });

    const env2 = makeEnv();
    cart(env2.db, G, "SAVE5");
    cart(env2.db, env2.KA, "FREESHIP");
    mustMerge(env2);
    expect(env2.db.query("SELECT coupon_code FROM carts WHERE session_id = ?").get(env2.KA)).toEqual({ coupon_code: "FREESHIP" });
    env2.db.close();
  });

  test("K-7: carts.session_id is never UPDATEd", () => {
    env.db.run(
      "CREATE TEMP TRIGGER t_no_cart_rekey BEFORE UPDATE OF session_id ON carts BEGIN SELECT RAISE(ABORT, 'rekey'); END",
    );
    const [a] = products(env.db, 1);
    cart(env.db, G);
    line(env.db, G, a ?? "", 1);
    expect(env.svc.mergeGuestIntoUser(G, env.KA, T0).ok).toBe(true);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM cart_items WHERE cart_session_id = ?", env.KA)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Lists (A-51..A-55)
// ---------------------------------------------------------------------------

describe("carts: per-line cap (D-T117-1)", () => {
  test("stock 500, guest 60 + user 60 -> 99 (DEFAULT_MAX_QUANTITY), not 120", () => {
    const [a] = addProducts(env.db, 1, 500);
    if (a === undefined) throw new Error("products");
    cart(env.db, G);
    line(env.db, G, a, 60);
    cart(env.db, env.KA);
    line(env.db, env.KA, a, 60);
    const s = mustMerge(env);
    expect(s.movedCartLines).toBe(1);
    expect(env.db.query("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?").get(env.KA, a)).toEqual({
      quantity: DEFAULT_MAX_QUANTITY,
    });
    expect(DEFAULT_MAX_QUANTITY).toBe(99);
  });

  test("stock below the cap still wins; sums below both are kept as-is", () => {
    const [low, high] = addProducts(env.db, 2, 500);
    if (low === undefined || high === undefined) throw new Error("products");
    setStock(env.db, low, 70);
    cart(env.db, G);
    line(env.db, G, low, 60);
    line(env.db, G, high, 30);
    cart(env.db, env.KA);
    line(env.db, env.KA, low, 60);
    line(env.db, env.KA, high, 40);
    mustMerge(env);
    const q = (id: string): unknown => env.db.query("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?").get(env.KA, id);
    expect(q(low)).toEqual({ quantity: 70 });
    expect(q(high)).toEqual({ quantity: 70 });
  });

  test("guest-only line above the cap (legacy row) is clamped to 99 on insert", () => {
    const [a] = addProducts(env.db, 1, 500);
    if (a === undefined) throw new Error("products");
    cart(env.db, G);
    line(env.db, G, a, 150);
    mustMerge(env);
    expect(env.db.query("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?").get(env.KA, a)).toEqual({
      quantity: 99,
    });
  });
});

describe("lists", () => {
  test("A-51: same product in both default wishlists -> one row with the user's note and priority", () => {
    const [p, q] = products(env.db, 2);
    if (p === undefined || q === undefined) throw new Error("products");
    const gl = list(env.db, G, "Shopping List", { isDefault: true });
    item(env.db, gl, p, { note: "guest", priority: 2 });
    item(env.db, gl, q);
    const ul = list(env.db, env.KA, "Shopping List", { isDefault: true });
    item(env.db, ul, p, { note: "user", priority: 1 });
    const s = mustMerge(env);
    expect(s.mergedListItems).toBe(1);
    expect(s.droppedListItems).toBe(1);
    expect(s.movedLists).toBe(0);
    expect(env.db.query("SELECT note, priority FROM list_items WHERE list_id = ? AND product_id = ?").get(ul, p)).toEqual({
      note: "user",
      priority: 1,
    });
    expect(count(env.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", ul)).toBe(2);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", G)).toBe(0);
    expect(
      count(env.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist' AND is_default = 1", env.KA),
    ).toBe(1);
  });

  test("user without a default wishlist: the guest default is re-keyed and stays default", () => {
    const [p] = products(env.db, 1);
    const gl = list(env.db, G, "Shopping List", { isDefault: true });
    item(env.db, gl, p ?? "");
    list(env.db, env.KA, "Shopping List");
    const s = mustMerge(env);
    expect(s.movedLists).toBe(1);
    expect(env.db.query("SELECT session_id, name, is_default FROM lists WHERE id = ?").get(gl)).toEqual({
      session_id: env.KA,
      name: "Shopping List (2)",
      is_default: 1,
    });
  });

  test("A-52: user has 19 lists, guest 3 non-default -> 20, 2 dropped with their items", () => {
    for (let i = 0; i < 19; i++) list(env.db, env.KA, `U${i}`);
    const ps = products(env.db, 3);
    const guestLists = [list(env.db, G, "G1"), list(env.db, G, "G2"), list(env.db, G, "G3")];
    guestLists.forEach((id, i) => item(env.db, id, ps[i] ?? ""));
    const s = mustMerge(env);
    expect(s.movedLists).toBe(1);
    expect(s.droppedLists).toBe(2);
    expect(s.droppedListItems).toBe(2);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'", env.KA)).toBe(20);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ?", G)).toBe(0);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id NOT IN (SELECT id FROM lists)")).toBe(0);
    // The oldest guest list survived.
    expect(env.db.query("SELECT session_id FROM lists WHERE id = ?").get(guestLists[0] ?? "")).toEqual({ session_id: env.KA });
  });

  test("A-53: user default holds 195 items, guest default 10 new -> 200, 5 dropped", () => {
    const extra = addProducts(env.db, 205);
    const ul = list(env.db, env.KA, "Shopping List", { isDefault: true });
    extra.slice(0, 195).forEach((p) => item(env.db, ul, p));
    const gl = list(env.db, G, "Shopping List", { isDefault: true });
    extra.slice(195).forEach((p) => item(env.db, gl, p));
    const s = mustMerge(env);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", ul)).toBe(200);
    expect(s.mergedListItems).toBe(5);
    expect(s.droppedListItems).toBe(5);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", gl)).toBe(0);
  });

  test("re-keyed list over 200 items is trimmed to 200 (oldest dropped)", () => {
    const extra = addProducts(env.db, 203);
    const gl = list(env.db, G, "Big");
    extra.forEach((p, i) => item(env.db, gl, p, { addedAt: iso(i * 1000) }));
    const s = mustMerge(env);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", gl)).toBe(200);
    expect(s.droppedListItems).toBe(3);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ? AND product_id = ?", gl, extra[0] ?? "")).toBe(0);
  });

  test("A-54: names deduped 'Gifts', 'Gifts (2)', 'Gifts (3)'; 60-char name stays <= 60", () => {
    const long = "L".repeat(60);
    list(env.db, env.KA, "Gifts");
    list(env.db, env.KA, long);
    list(env.db, G, "Gifts", { createdAt: iso(1) });
    list(env.db, G, "Gifts (2)", { createdAt: iso(2) });
    list(env.db, G, long, { createdAt: iso(3) });
    mustMerge(env);
    const names = env.db
      .query<{ name: string }, [string]>("SELECT name FROM lists WHERE session_id = ? ORDER BY name")
      .all(env.KA)
      .map((r) => r.name);
    expect(names).toEqual(["Gifts", "Gifts (2)", "Gifts (3)", `${"L".repeat(56)} (2)`, long].sort());
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const n of names) expect(Array.from(n).length).toBeLessThanOrEqual(60);
  });

  test("A-55: both have save_for_later -> one SFL row, items merged, no unique-index violation", () => {
    const [p, q, r] = products(env.db, 3);
    const gs = list(env.db, G, "Saved for later", { kind: "save_for_later" });
    item(env.db, gs, p ?? "");
    item(env.db, gs, q ?? "");
    const us = list(env.db, env.KA, "Saved for later", { kind: "save_for_later" });
    item(env.db, us, q ?? "");
    item(env.db, us, r ?? "");
    const s = mustMerge(env);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'save_for_later'", env.KA)).toBe(1);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM list_items WHERE list_id = ?", us)).toBe(3);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM lists WHERE id = ?", gs)).toBe(0);
    expect(s.mergedListItems).toBe(1);
    expect(s.droppedListItems).toBe(1);
  });

  test("guest SFL is re-keyed when the user has none; share token kept on re-keyed wishlists", () => {
    const gs = list(env.db, G, "Saved for later", { kind: "save_for_later" });
    const gw = list(env.db, G, "Public");
    env.db.run("UPDATE lists SET is_public = 1, share_token = 'tok_1' WHERE id = ?", [gw]);
    const s = mustMerge(env);
    expect(s.movedLists).toBe(2);
    expect(env.db.query("SELECT session_id FROM lists WHERE id = ?").get(gs)).toEqual({ session_id: env.KA });
    expect(env.db.query("SELECT session_id, share_token FROM lists WHERE id = ?").get(gw)).toEqual({
      session_id: env.KA,
      share_token: "tok_1",
    });
  });
});

// ---------------------------------------------------------------------------
// Views (A-56, criterion 5)
// ---------------------------------------------------------------------------

describe("product views", () => {
  test("criterion 5: 60 combined distinct rows leave exactly the newest 50", () => {
    const ps = addProducts(env.db, 60);
    ps.forEach((p, i) => view(env.db, i % 2 === 0 ? G : env.KA, p, iso(i * 1000)));
    const s = mustMerge(env);
    expect(s.movedViews).toBe(30);
    expect(s.droppedViews).toBe(10);
    const kept = env.db
      .query<{ product_id: string }, [string]>("SELECT product_id FROM product_views WHERE session_id = ?")
      .all(env.KA)
      .map((r) => r.product_id)
      .sort();
    expect(kept).toEqual(ps.slice(10).sort());
    expect(count(env.db, "SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?", G)).toBe(0);
  });

  test("A-56: 30 + 30 with 5 overlapping -> 50 newest, overlap uses MAX(viewed_at)", () => {
    const ps = products(env.db, 55);
    // user: ps[0..29], guest: ps[25..54]; overlap ps[25..29]
    ps.slice(0, 30).forEach((p, i) => view(env.db, env.KA, p, iso(i * 1000)));
    ps.slice(25).forEach((p, i) => view(env.db, G, p, iso(100_000 + i * 1000)));
    mustMerge(env);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM product_views WHERE session_id = ?", env.KA)).toBe(50);
    // Overlap took the guest's (newer) time.
    expect(env.db.query("SELECT viewed_at FROM product_views WHERE session_id = ? AND product_id = ?").get(env.KA, ps[25] ?? "")).toEqual({
      viewed_at: iso(100_000),
    });
    // The 5 oldest user-only views are gone.
    for (const p of ps.slice(0, 5)) {
      expect(count(env.db, "SELECT COUNT(*) AS n FROM product_views WHERE session_id = ? AND product_id = ?", env.KA, p)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Reviews, Q&A, votes (A-49, A-50, R-5)
// ---------------------------------------------------------------------------

describe("reviews, questions, answers, votes", () => {
  test("A-49: UNIQUE review conflict -> user's kept, guest's deleted (R-5), aggregates exact", () => {
    const [p, q] = products(env.db, 2);
    if (p === undefined || q === undefined) throw new Error("products");
    review(env.db, env.KA, p, 5, "user body");
    review(env.db, G, p, 1, "guest body");
    review(env.db, G, q, 4, "moved");
    expectAggregatesConsistent(env.db);
    const s = mustMerge(env);
    expect(s.droppedReviews).toBe(1);
    expect(s.movedReviews).toBe(1);
    expect(env.db.query("SELECT body FROM reviews WHERE session_id = ? AND product_id = ?").all(env.KA, p)).toEqual([{ body: "user body" }]);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM reviews WHERE session_id = ?", G)).toBe(0);
    expectAggregatesConsistent(env.db);
  });

  test("A-50: both voted on review R -> one vote under KA, helpful_count equals the vote count", () => {
    const [p] = products(env.db, 1);
    const r = review(env.db, H, p ?? "", 4);
    reviewVote(env.db, r, G);
    reviewVote(env.db, r, env.KA);
    reviewVote(env.db, r, env.KB);
    const s = mustMerge(env);
    expect(s.droppedVotes).toBe(1);
    expect(env.db.query("SELECT session_id FROM review_votes WHERE review_id = ? ORDER BY session_id").all(r)).toEqual(
      [{ session_id: env.KA }, { session_id: env.KB }].sort((a, b) => (a.session_id < b.session_id ? -1 : 1)),
    );
    expect(env.db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(r)).toEqual({ helpful_count: 2 });
    expectAggregatesConsistent(env.db);
  });

  test("questions, answers and their votes are re-keyed; duplicate votes deleted", () => {
    const [p] = products(env.db, 1);
    const q = question(env.db, G, p ?? "");
    const a = answer(env.db, G, q);
    const other = question(env.db, H, p ?? "");
    const otherA = answer(env.db, H, other);
    env.db.run("INSERT INTO question_votes (question_id, session_id) VALUES (?, ?), (?, ?)", [other, G, other, env.KA]);
    env.db.run("INSERT INTO answer_votes (answer_id, session_id) VALUES (?, ?)", [otherA, G]);
    const s = mustMerge(env);
    expect(s.movedQuestions).toBe(1);
    expect(s.movedAnswers).toBe(1);
    expect(s.droppedVotes).toBe(1);
    expect(env.db.query("SELECT session_id FROM questions WHERE id = ?").get(q)).toEqual({ session_id: env.KA });
    expect(env.db.query("SELECT session_id FROM answers WHERE id = ?").get(a)).toEqual({ session_id: env.KA });
    expect(env.db.query("SELECT session_id FROM answer_votes WHERE answer_id = ?").all(otherA)).toEqual([{ session_id: env.KA }]);
    expectAggregatesConsistent(env.db);
  });
});

describe("self-votes after merge (D-T117-2)", () => {
  const selfVotes = (db: Database): number =>
    count(db, "SELECT COUNT(*) AS n FROM review_votes v JOIN reviews r ON r.id = v.review_id WHERE v.session_id = r.session_id") +
    count(db, "SELECT COUNT(*) AS n FROM question_votes v JOIN questions q ON q.id = v.question_id WHERE v.session_id = q.session_id") +
    count(db, "SELECT COUNT(*) AS n FROM answer_votes v JOIN answers a ON a.id = v.answer_id WHERE v.session_id = a.session_id");

  test("guest vote on the user's own review is deleted, helpful_count exact", () => {
    const [p] = products(env.db, 1);
    const own = review(env.db, env.KA, p ?? "", 5);
    reviewVote(env.db, own, G);
    reviewVote(env.db, own, H);
    expect(env.db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(own)).toEqual({ helpful_count: 2 });
    const s = mustMerge(env);
    expect(s.droppedVotes).toBe(1);
    expect(env.db.query("SELECT session_id FROM review_votes WHERE review_id = ?").all(own)).toEqual([{ session_id: H }]);
    expect(env.db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(own)).toEqual({ helpful_count: 1 });
    expect(selfVotes(env.db)).toBe(0);
    expectAggregatesConsistent(env.db);
  });

  test("user's earlier vote on a review the guest wrote is deleted once the review is re-keyed", () => {
    const [p] = products(env.db, 1);
    const guestReview = review(env.db, G, p ?? "", 4);
    reviewVote(env.db, guestReview, env.KA);
    reviewVote(env.db, guestReview, env.KB);
    const s = mustMerge(env);
    expect(s.movedReviews).toBe(1);
    expect(s.droppedVotes).toBe(1);
    expect(env.db.query("SELECT session_id FROM review_votes WHERE review_id = ?").all(guestReview)).toEqual([{ session_id: env.KB }]);
    expect(env.db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(guestReview)).toEqual({ helpful_count: 1 });
    expect(selfVotes(env.db)).toBe(0);
    expectAggregatesConsistent(env.db);
  });

  test("same rule for question and answer votes (Q&A service forbids self-votes)", () => {
    const [p] = products(env.db, 1);
    const ownQ = question(env.db, env.KA, p ?? "");
    const ownA = answer(env.db, env.KA, ownQ);
    const guestQ = question(env.db, G, p ?? "");
    const guestA = answer(env.db, G, guestQ);
    env.db.run("INSERT INTO question_votes (question_id, session_id) VALUES (?, ?), (?, ?), (?, ?)", [ownQ, G, ownQ, H, guestQ, env.KA]);
    env.db.run("INSERT INTO answer_votes (answer_id, session_id) VALUES (?, ?), (?, ?)", [ownA, G, guestA, env.KA]);
    const s = mustMerge(env);
    expect(s.droppedVotes).toBe(4);
    expect(env.db.query("SELECT session_id FROM question_votes WHERE question_id = ?").all(ownQ)).toEqual([{ session_id: H }]);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM question_votes WHERE question_id = ?", guestQ)).toBe(0);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM answer_votes WHERE answer_id IN (?, ?)", ownA, guestA)).toBe(0);
    expect(env.db.query("SELECT helpful_count FROM questions WHERE id = ?").get(ownQ)).toEqual({ helpful_count: 1 });
    expect(env.db.query("SELECT helpful_count FROM answers WHERE id = ?").get(ownA)).toEqual({ helpful_count: 0 });
    expect(selfVotes(env.db)).toBe(0);
    expectAggregatesConsistent(env.db);
  });

  test("self-vote deletion is inside the merge transaction: an injected failure later rolls it back", () => {
    const [p] = products(env.db, 1);
    const own = review(env.db, env.KA, p ?? "", 5);
    reviewVote(env.db, own, G);
    env.db.run(
      "CREATE TEMP TRIGGER fail_redemptions BEFORE UPDATE ON coupon_redemptions BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    env.db.run("CREATE TEMP TRIGGER fail_orders BEFORE UPDATE ON orders BEGIN SELECT RAISE(ABORT, 'injected'); END");
    order(env.db, G, p ?? "");
    const r = env.svc.mergeGuestIntoUser(G, env.KA, T0 + 1000);
    expect(r.ok).toBe(false);
    expect(env.db.query("SELECT session_id FROM review_votes WHERE review_id = ?").all(own)).toEqual([{ session_id: G }]);
    expect(env.db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(own)).toEqual({ helpful_count: 1 });
  });

  test("idempotent: a second merge drops nothing more", () => {
    const [p] = products(env.db, 1);
    const own = review(env.db, env.KA, p ?? "", 5);
    reviewVote(env.db, own, G);
    mustMerge(env);
    const again = env.svc.mergeGuestIntoUser(G, env.KA, T0 + 2000);
    expect(again.ok && again.value).toEqual(EMPTY_MERGE_SUMMARY);
  });
});

// ---------------------------------------------------------------------------
// Alerts, messages, addresses, orders, redemptions
// ---------------------------------------------------------------------------

describe("stock alerts (A-61, R-5)", () => {
  test("guest 25, user 0 -> 20 kept (newest), 5 deleted and reported", () => {
    const ps = products(env.db, 25);
    const ids = ps.map((p, i) => alert(env.db, G, p, iso(i * 1000)));
    const s = mustMerge(env);
    expect(s.movedAlerts).toBe(20);
    expect(s.droppedAlerts).toBe(5);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", env.KA)).toBe(20);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", G)).toBe(0);
    for (const id of ids.slice(0, 5)) expect(count(env.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE id = ?", id)).toBe(0);
  });

  test("UNIQUE conflict deleted from the guest; user's row kept", () => {
    const [p, q] = products(env.db, 2);
    const userAlert = alert(env.db, env.KA, p ?? "");
    alert(env.db, G, p ?? "");
    alert(env.db, G, q ?? "");
    const s = mustMerge(env);
    expect(s).toMatchObject({ movedAlerts: 1, droppedAlerts: 1 });
    expect(env.db.query("SELECT session_id FROM stock_alerts WHERE id = ?").get(userAlert)).toEqual({ session_id: env.KA });
    expect(count(env.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", G)).toBe(0);
  });

  test("user already at 20: every guest alert dropped", () => {
    const ps = products(env.db, 22);
    ps.slice(0, 20).forEach((p) => alert(env.db, env.KA, p));
    ps.slice(20).forEach((p) => alert(env.db, G, p));
    expect(mustMerge(env)).toMatchObject({ movedAlerts: 0, droppedAlerts: 2 });
    expect(count(env.db, "SELECT COUNT(*) AS n FROM stock_alerts WHERE session_id = ?", env.KA)).toBe(20);
  });
});

describe("contact messages", () => {
  test("guest messages re-keyed; NULL-owner and other rows untouched", () => {
    const mine = message(env.db, G);
    const anon = message(env.db, null);
    const other = message(env.db, H);
    expect(mustMerge(env).movedMessages).toBe(1);
    expect(env.db.query("SELECT id, session_id FROM contact_messages ORDER BY id").all()).toEqual(
      [
        { id: mine, session_id: env.KA },
        { id: anon, session_id: null },
        { id: other, session_id: H },
      ].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });
});

describe("addresses (A-57, A-58, criterion 6)", () => {
  const defaults = (db: Database, key: string): string[] =>
    db
      .query<{ id: string }, [string]>("SELECT id FROM addresses WHERE session_id = ? AND is_default = 1")
      .all(key)
      .map((r) => r.id);

  test("A-57: user 8 (default D1), guest 4 incl. case/whitespace duplicate of D1 -> 10, D1 sole default", () => {
    const d1 = address(env.db, env.KA, { fullName: "Ada Lovelace", line1: "1 Main St", postal: "AB1 2CD", country: "GB", isDefault: true });
    for (let i = 0; i < 7; i++) address(env.db, env.KA);
    address(env.db, G, { fullName: "  ada   LOVELACE", line1: "1 main  st ", postal: "ab1 2cd", country: "gb" });
    address(env.db, G, { isDefault: true });
    address(env.db, G);
    address(env.db, G);
    const s = mustMerge(env);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", env.KA)).toBe(10);
    expect(s.movedAddresses).toBe(2);
    expect(s.droppedAddresses).toBe(2); // 1 duplicate + 1 over the cap
    expect(defaults(env.db, env.KA)).toEqual([d1]);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", G)).toBe(0);
    expect(
      count(env.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ? AND lower(full_name) LIKE '%lovelace%'", env.KA),
    ).toBe(1);
  });

  test("A-58: user at 10 -> guest's 2 dropped and reported", () => {
    for (let i = 0; i < 10; i++) address(env.db, env.KA, { isDefault: i === 0 });
    address(env.db, G);
    address(env.db, G, { isDefault: true });
    const s = mustMerge(env);
    expect(s).toMatchObject({ movedAddresses: 0, droppedAddresses: 2 });
    expect(count(env.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", env.KA)).toBe(10);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM addresses WHERE session_id = ?", G)).toBe(0);
    expect(defaults(env.db, env.KA)).toHaveLength(1);
  });

  test("user without a default takes the guest's default", () => {
    address(env.db, env.KA);
    const gd = address(env.db, G, { isDefault: true });
    address(env.db, G);
    mustMerge(env);
    expect(defaults(env.db, env.KA)).toEqual([gd]);
  });

  test("neither side has a default -> the newest address becomes default", () => {
    address(env.db, env.KA, { createdAt: iso(1) });
    const newest = address(env.db, G, { createdAt: iso(9_000) });
    address(env.db, G, { createdAt: iso(5) });
    mustMerge(env);
    expect(defaults(env.db, env.KA)).toEqual([newest]);
  });
});

describe("orders (A-59, criterion 2) and coupon redemptions (A-60)", () => {
  test("guest orders re-keyed; items, events and totals row-equal", () => {
    const [p] = products(env.db, 1);
    const o1 = order(env.db, G, p ?? "");
    const o2 = order(env.db, G, p ?? "");
    const itemsBefore = env.db.query("SELECT * FROM order_items ORDER BY rowid").all();
    const eventsBefore = env.db.query("SELECT * FROM order_events ORDER BY id").all();
    const totalsBefore = env.db.query("SELECT id, subtotal_cents, total_cents FROM orders ORDER BY id").all();
    expect(mustMerge(env).movedOrders).toBe(2);
    expect(env.db.query("SELECT session_id FROM orders WHERE id IN (?, ?)").all(o1, o2)).toEqual([
      { session_id: env.KA },
      { session_id: env.KA },
    ]);
    expect(env.db.query("SELECT * FROM order_items ORDER BY rowid").all()).toEqual(itemsBefore);
    expect(env.db.query("SELECT * FROM order_events ORDER BY id").all()).toEqual(eventsBefore);
    expect(env.db.query("SELECT id, subtotal_cents, total_cents FROM orders ORDER BY id").all()).toEqual(totalsBefore);
  });

  test("both redeemed C -> KA keeps one, guest row deleted (R-5), used_count unchanged", () => {
    redemption(env.db, G, "SAVE5");
    redemption(env.db, env.KA, "SAVE5");
    redemption(env.db, G, "FREESHIP");
    const usedBefore = env.db.query("SELECT code, used_count FROM coupons ORDER BY code").all();
    const s = mustMerge(env);
    expect(s).toMatchObject({ movedRedemptions: 1, droppedRedemptions: 1 });
    expect(count(env.db, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE session_id = ?", env.KA)).toBe(2);
    expect(count(env.db, "SELECT COUNT(*) AS n FROM coupon_redemptions WHERE session_id = ?", G)).toBe(0);
    expect(env.db.query("SELECT code, used_count FROM coupons ORDER BY code").all()).toEqual(usedBefore);
  });
});

// ---------------------------------------------------------------------------
// Three-party isolation, idempotency, atomicity (A-62, A-63, A-65)
// ---------------------------------------------------------------------------

describe("three-party fixture", () => {
  beforeEach(() => {
    seedIdentity(env, G, 0);
    seedIdentity(env, env.KA, 1);
    seedIdentity(env, env.KB, 2);
    seedIdentity(env, H, 3);
  });

  test("A-65: B's and H's rows, rate_limits and auth_sessions are untouched; no guest rows remain", () => {
    const kb = snapshot(env.db, env.KB);
    const h = snapshot(env.db, H);
    const limits = env.db.query("SELECT * FROM rate_limits ORDER BY rowid").all();
    const sessions = env.db.query("SELECT * FROM auth_sessions ORDER BY rowid").all();
    const s = mustMerge(env);
    expect(snapshot(env.db, env.KB)).toEqual(kb);
    expect(snapshot(env.db, H)).toEqual(h);
    expect(env.db.query("SELECT * FROM rate_limits ORDER BY rowid").all()).toEqual(limits);
    expect(env.db.query("SELECT * FROM auth_sessions ORDER BY rowid").all()).toEqual(sessions);
    for (const [table, n] of Object.entries(counts(env.db, G))) {
      expect({ table, n }).toEqual({ table, n: 0 });
    }
    expect(s.droppedReviews).toBe(1); // both reviewed the shared product
    expect(s.droppedRedemptions).toBe(1); // both redeemed SAVE5
    expect(s.droppedAddresses).toBe(1); // same normalised address
    expect(s.droppedVotes).toBe(3); // same seed review/question/answer
    expectAggregatesConsistent(env.db);
  });

  test("A-63: idempotent; the second call is an all-zero summary and changes no row", () => {
    mustMerge(env);
    const after1 = fullSnapshot(env.db);
    const second = env.svc.mergeGuestIntoUser(G, env.KA, T0 + 999_999);
    expect(second).toEqual({ ok: true, value: EMPTY_MERGE_SUMMARY });
    expect(fullSnapshot(env.db)).toEqual(after1);
  });

  const WRITTEN_TABLES = [
    "carts",
    "cart_items",
    "lists",
    "list_items",
    "product_views",
    "reviews",
    "review_votes",
    "questions",
    "answers",
    "question_votes",
    "answer_votes",
    "stock_alerts",
    "contact_messages",
    "addresses",
    "orders",
    "coupon_redemptions",
  ] as const;

  const install = (db: Database, table: string): void => {
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      db.run(`CREATE TEMP TRIGGER qa_fail_${op.toLowerCase()} BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'qa-injected'); END`);
    }
  };
  const uninstall = (db: Database): void => {
    for (const op of ["insert", "update", "delete"]) db.run(`DROP TRIGGER IF EXISTS qa_fail_${op}`);
  };

  test("criterion 7: failure on the LAST table (coupon_redemptions) rolls back every earlier change", () => {
    const before = fullSnapshot(env.db);
    install(env.db, "coupon_redemptions");
    const r = env.svc.mergeGuestIntoUser(G, env.KA, T0);
    uninstall(env.db);
    expect(r).toEqual({
      ok: false,
      error: { code: "VALIDATION_FAILED", message: "Could not merge guest data into the account.", details: { reason: "merge_failed" } },
    });
    expect(fullSnapshot(env.db)).toEqual(before);
    // Logged once, without ids.
    expect(env.logs).toHaveLength(1);
    const logged = JSON.stringify(env.logs);
    for (const secret of [G, env.KA, env.KB, H, "a@example.com", "n@example.com"]) expect(logged).not.toContain(secret);
    // After the failure is removed the merge succeeds.
    expect(env.svc.mergeGuestIntoUser(G, env.KA, T0).ok).toBe(true);
  });

  test("A-62: a failure on ANY written table rolls back everything", () => {
    const before = fullSnapshot(env.db);
    for (const table of WRITTEN_TABLES) {
      install(env.db, table);
      const r = env.svc.mergeGuestIntoUser(G, env.KA, T0);
      uninstall(env.db);
      expect({ table, ok: r.ok }).toEqual({ table, ok: false });
      expect(fullSnapshot(env.db)).toEqual(before);
    }
  });

  test("tables the merge must not write (rate_limits, users, auth_sessions, order_items, order_events, coupons) never fire", () => {
    for (const table of ["rate_limits", "users", "auth_sessions", "order_items", "order_events", "coupons", "shipping_methods"]) {
      const db = makeEnv();
      seedIdentity(db, G, 0);
      install(db.db, table);
      const r = db.svc.mergeGuestIntoUser(G, db.KA, T0);
      expect({ table, ok: r.ok }).toEqual({ table, ok: true });
      db.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Randomised invariants (A-66, reduced: 25 fixtures)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("A-66 randomised invariants", () => {
  test("25 seeded fixtures keep every cap, uniqueness and aggregate invariant", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const e = makeEnv();
      normaliseSeedCounters(e.db);
      const rnd = mulberry32(seed);
      const pick = (n: number): number => Math.floor(rnd() * n);
      const ps = products(e.db, 50);
      const p = (): string => ps[pick(ps.length)] ?? "";
      for (const pid of new Set(Array.from({ length: 10 }, p))) setStock(e.db, pid, pick(4));
      const stockOf = (pid: string): number =>
        e.db.query<{ stock: number }, [string]>("SELECT stock FROM products WHERE id = ?").get(pid)?.stock ?? 0;
      for (const key of [G, e.KA]) {
        cart(e.db, key);
        for (const pid of new Set(Array.from({ length: pick(6) }, p))) {
          const qty = 1 + pick(5);
          // The user's own lines start within stock; guest lines may exceed it or be out of stock.
          if (key === G) line(e.db, key, pid, qty);
          else if (stockOf(pid) > 0) line(e.db, key, pid, Math.min(qty, stockOf(pid)));
        }
        for (const pid of new Set(Array.from({ length: pick(40) }, p))) view(e.db, key, pid, iso(pick(1_000_000)));
        for (const pid of new Set(Array.from({ length: pick(15) }, p))) alert(e.db, key, pid, iso(pick(1_000_000)));
        for (const pid of new Set(Array.from({ length: pick(4) }, p))) review(e.db, key, pid, 1 + pick(5));
        for (let i = 0; i < pick(8); i++) address(e.db, key, { isDefault: i === 0 && rnd() < 0.7, fullName: `N${pick(3)}`, line1: "L" });
        const lists = 1 + pick(12);
        for (let i = 0; i < lists; i++) {
          const name = key === G ? `L${pick(6)}` : `L${i}`;
          const id = list(e.db, key, name, { isDefault: i === 0 });
          for (const pid of new Set(Array.from({ length: pick(5) }, p))) item(e.db, id, pid);
        }
      }
      const r = e.svc.mergeGuestIntoUser(G, e.KA, T0);
      expect({ seed, ok: r.ok }).toEqual({ seed, ok: true });
      const c = (sql: string): number => count(e.db, sql, e.KA);
      const inv = {
        seed,
        guestRows: Object.values(counts(e.db, G)).reduce((a, b) => a + b, 0),
        overStock: count(e.db, "SELECT COUNT(*) AS n FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.quantity > p.stock"),
        wishlistsOver: c("SELECT COUNT(*) > 20 AS n FROM lists WHERE session_id = ? AND kind = 'wishlist'"),
        defaults: c("SELECT COUNT(*) AS n FROM lists WHERE session_id = ? AND kind = 'wishlist' AND is_default = 1"),
        views: c("SELECT COUNT(*) > 50 AS n FROM product_views WHERE session_id = ?"),
        alerts: c("SELECT COUNT(*) > 20 AS n FROM stock_alerts WHERE session_id = ?"),
        addrOver: c("SELECT COUNT(*) > 10 AS n FROM addresses WHERE session_id = ?"),
        addrDefaults: c("SELECT COUNT(*) AS n FROM addresses WHERE session_id = ? AND is_default = 1"),
        hasAddr: c("SELECT COUNT(*) > 0 AS n FROM addresses WHERE session_id = ?"),
        dupNames: c("SELECT COUNT(*) - COUNT(DISTINCT lower(name)) AS n FROM lists WHERE session_id = ?"),
      };
      expect(inv).toEqual({
        seed,
        guestRows: 0,
        overStock: 0,
        wishlistsOver: 0,
        defaults: 1,
        views: 0,
        alerts: 0,
        addrOver: 0,
        addrDefaults: inv.hasAddr,
        hasAddr: inv.hasAddr,
        dupNames: 0,
      });
      expectAggregatesConsistent(e.db);
      const snap = fullSnapshot(e.db);
      expect(e.svc.mergeGuestIntoUser(G, e.KA, T0)).toEqual({ ok: true, value: EMPTY_MERGE_SUMMARY });
      expect(fullSnapshot(e.db)).toEqual(snap);
      e.db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe("getMergeService", () => {
  const previous = process.env.DATABASE_PATH;
  afterEach(() => {
    closeDatabase();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
  });

  test("returns one cached instance over the shared :memory: database", () => {
    closeDatabase();
    process.env.DATABASE_PATH = ":memory:";
    const a = getMergeService();
    expect(getMergeService()).toBe(a);
    expect(a.mergeGuestIntoUser("bad", "bad").ok).toBe(false);
  });
});
