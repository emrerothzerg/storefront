/**
 * Shared QA fixtures for the accounts epic (T122; imported by T129).
 * PLAN.md section 4b. QA-owned. Pure helpers only: no `mock.module` here
 * (each test file registers its own `next/*` mocks before importing app code).
 *
 * Never touches ./data: every DB is `createDatabase(":memory:")`.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import type { PasswordHasher } from "@/server/auth/password-policy";

/** PLAN clock origin: aligned to 900 s and 3600 s windows. */
export const T0 = 1_800_000_000_000;
export const MIN = 60_000;
export const PASSWORD = "Tr0ub4dor&3-qa";
export const PASSWORD_B = "Corr3ct-H0rse-qa";
export const INVALID_MSG = "Email or password is incorrect";
export const TOMBSTONE = "00000000-0000-4000-8000-000000000000";
export const FAST_MARKER = "$qa-fast$";

export const IN_STOCK_A = "prod_canvas-tote-bag"; // stock 42
export const IN_STOCK_B = "prod_cast-iron-skillet"; // stock 30
export const LOW_STOCK = "prod_adjustable-dumbbell-pair"; // stock 5
export const OUT_OF_STOCK = "prod_bike-light-set"; // stock 0

export function sha256hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Every DB opened through these helpers; close them with `closeTrackedDbs()` in `afterAll`. */
const trackedDbs = new Set<Database>();

/** Registers a DB opened elsewhere (e.g. `Database.deserialize`) for `closeTrackedDbs()`. */
export function trackDb<T extends Database>(db: T): T {
  trackedDbs.add(db);
  return db;
}

/** Closes every tracked DB (already-closed handles are ignored). */
export function closeTrackedDbs(): void {
  for (const db of trackedDbs) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  trackedDbs.clear();
}

/** Fresh migrated + seeded in-memory DB (tracked for `closeTrackedDbs`). */
export function makeDb(seed = true): Database {
  const db = trackDb(createDatabase(":memory:"));
  runMigrations(db);
  if (seed) seedDatabase(db);
  return db;
}

export function uuid(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Fast hasher (PLAN 4b-2)
// ---------------------------------------------------------------------------

export interface FastHasher extends PasswordHasher {
  readonly calls: { hash: number; verify: number; verifyArgs: string[] };
  reset(): void;
}

export function fastHasher(): FastHasher {
  const calls = { hash: 0, verify: 0, verifyArgs: [] as string[] };
  return {
    calls,
    reset() {
      calls.hash = 0;
      calls.verify = 0;
      calls.verifyArgs.length = 0;
    },
    async hash(pw: string) {
      calls.hash++;
      await Promise.resolve();
      const salt = sha256hex(crypto.randomUUID()).slice(0, 16);
      return `${FAST_MARKER}${salt}$${sha256hex(salt + pw)}`;
    },
    async verify(pw: string, hash: string) {
      calls.verify++;
      calls.verifyArgs.push(hash);
      await Promise.resolve();
      if (!hash.startsWith(FAST_MARKER)) return false;
      const [salt, digest] = hash.slice(FAST_MARKER.length).split("$");
      return salt !== undefined && digest === sha256hex(salt + pw);
    },
  };
}

export interface TestClock {
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

export function testClock(start = T0): TestClock {
  let t = start;
  return {
    now: () => t,
    set: (ms) => {
      t = ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Cookie jar (PLAN 4b-4)
// ---------------------------------------------------------------------------

export interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: Record<string, unknown> | undefined;
}

export class QaCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  readonly deleteCalls: string[] = [];
  /** Any method call recorded in order (get/set/delete). */
  readonly ops: string[] = [];

  constructor(initial: Readonly<Record<string, string | undefined>> = {}) {
    for (const [k, v] of Object.entries(initial)) if (v !== undefined) this.jar.set(k, v);
  }

  get(name: string): { name: string; value: string } | undefined {
    this.ops.push(`get:${name}`);
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  getAll(): { name: string; value: string }[] {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  set(name: string, value: string, options?: Record<string, unknown>): void {
    this.ops.push(`set:${name}`);
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }

  delete(name: string): void {
    this.ops.push(`delete:${name}`);
    this.deleteCalls.push(name);
    this.jar.delete(name);
  }

  setsOf(name: string): SetCall[] {
    return this.setCalls.filter((c) => c.name === name);
  }

  /** True when the last write to `name` cleared it (maxAge 0 / empty value / delete). */
  isCleared(name: string): boolean {
    if (this.deleteCalls.includes(name) && !this.jar.has(name)) return true;
    const sets = this.setsOf(name);
    const last = sets[sets.length - 1];
    if (last === undefined) return false;
    return last.options?.maxAge === 0 || last.value === "";
  }

  /** The next request of the same browser: same cookies (cleared ones dropped), fresh call logs. */
  next(): QaCookieStore {
    const s = new QaCookieStore();
    for (const [k, v] of this.jar) if (v !== "") s.jar.set(k, v);
    return s;
  }
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export type Entry = readonly [string, string | Blob];

export function form(fields: Record<string, string> | readonly Entry[]): FormData {
  const fd = new FormData();
  const entries: readonly Entry[] = Array.isArray(fields) ? fields : Object.entries(fields);
  for (const [k, v] of entries) fd.append(k, v);
  return fd;
}

/** FormData Proxy recording every method call with its first argument (A-100). */
export function spyFormData(fields: Record<string, string>): { form: FormData; reads: string[] } {
  const target = form(fields);
  const reads: string[] = [];
  const proxy = new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        reads.push(`${String(prop)}:${String(args[0])}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { form: proxy, reads };
}

// ---------------------------------------------------------------------------
// Redirects (PLAN 4b-5)
// ---------------------------------------------------------------------------

export class RedirectSentinel extends Error {
  readonly digest: string;
  constructor(readonly url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

/** Resolves to the redirect URL, or throws if the promise settled with a state. */
export async function captureRedirect(promise: Promise<unknown>): Promise<string> {
  let state: unknown;
  try {
    state = await promise;
  } catch (error) {
    if (error instanceof RedirectSentinel) return error.url;
    const digest = (error as { digest?: unknown } | null)?.digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2] ?? "";
    throw error;
  }
  throw new Error(`expected a redirect, got state ${JSON.stringify(state)}`);
}

// ---------------------------------------------------------------------------
// Secrets (PLAN 4b-10)
// ---------------------------------------------------------------------------

export class SecretRegistry {
  readonly secrets = new Set<string>([FAST_MARKER, "$argon2"]);
  readonly ownerKeys = new Set<string>();

  add(...values: (string | null | undefined)[]): void {
    for (const v of values) if (typeof v === "string" && v.length >= 6) this.secrets.add(v);
  }

  addOwnerKey(...values: string[]): void {
    for (const v of values) this.ownerKeys.add(v);
  }

  /** Every stored password hash and token hash in the DB. */
  harvest(db: Database): void {
    for (const r of db.query("SELECT password_hash, owner_key FROM users").all() as { password_hash: string; owner_key: string }[]) {
      this.add(r.password_hash);
      this.addOwnerKey(r.owner_key);
    }
    for (const r of db.query("SELECT token_hash FROM auth_sessions").all() as { token_hash: string }[]) this.add(r.token_hash);
  }

  /** Returns the secrets found in `haystack` (empty = clean). */
  find(haystack: string, includeOwnerKeys = false): string[] {
    const found: string[] = [];
    for (const s of this.secrets) if (haystack.includes(s)) found.push(s.slice(0, 12) + "...");
    if (includeOwnerKeys) for (const k of this.ownerKeys) if (haystack.includes(k)) found.push(`ownerKey:${k.slice(0, 8)}`);
    return found;
  }
}

/** Console capture for log/info/warn/error/debug. */
export function consoleCapture(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : safeJson(a))).join(" "));
    };
  }
  return {
    lines,
    restore() {
      methods.forEach((m, i) => {
        console[m] = originals[i] as (typeof console)[typeof m];
      });
    },
  };
}

export function safeJson(value: unknown): string {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Owner-keyed tables, snapshots (PLAN 4b-7)
// ---------------------------------------------------------------------------

/** Section 1 owner-keyed tables with their owner column. */
export const OWNER_TABLES: Readonly<Record<string, string>> = {
  carts: "session_id",
  cart_items: "cart_session_id",
  lists: "session_id",
  product_views: "session_id",
  reviews: "session_id",
  review_votes: "session_id",
  questions: "session_id",
  answers: "session_id",
  question_votes: "session_id",
  answer_votes: "session_id",
  stock_alerts: "session_id",
  contact_messages: "session_id",
  addresses: "session_id",
  orders: "session_id",
  coupon_redemptions: "session_id",
};

export function discoverOwnerTables(db: Database): string[] {
  return (
    db
      .query(
        `SELECT DISTINCT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) p
          WHERE m.type = 'table' AND p.name IN ('session_id', 'cart_session_id') ORDER BY 1`,
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

export function counts(db: Database, key: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, col] of Object.entries(OWNER_TABLES)) {
    out[table] = (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(key) as { n: number }).n;
  }
  // list_items via lists
  out.list_items = (
    db.query("SELECT COUNT(*) AS n FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE session_id = ?)").get(key) as {
      n: number;
    }
  ).n;
  return out;
}

export function snapshot(db: Database, key: string): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [table, col] of Object.entries(OWNER_TABLES)) {
    out[table] = db.query(`SELECT * FROM ${table} WHERE ${col} = ? ORDER BY rowid`).all(key);
  }
  out.list_items = db
    .query("SELECT * FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE session_id = ?) ORDER BY list_id, product_id")
    .all(key);
  return out;
}

/** Every user table except FTS shadow tables. */
export function fullSnapshot(db: Database, exclude: readonly string[] = []): Record<string, unknown[]> {
  const tables = (
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'products_fts%' AND name NOT LIKE 'sqlite_%' ORDER BY 1")
      .all() as { name: string }[]
  ).map((r) => r.name);
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    if (exclude.includes(t)) continue;
    out[t] = db.query(`SELECT * FROM ${t} ORDER BY rowid`).all();
  }
  return out;
}

export function zeroCounts(c: Record<string, number>): boolean {
  return Object.values(c).every((n) => n === 0);
}

/** CREATE TEMP TRIGGER raising ABORT on `op` of `table` (A-62/A-72). */
export function injectFailure(db: Database, table: string, op: "INSERT" | "UPDATE" | "DELETE"): () => void {
  const name = `qa_fail_${table}_${op.toLowerCase()}`;
  db.run(`CREATE TEMP TRIGGER ${name} BEFORE ${op} ON main.${table} BEGIN SELECT RAISE(ABORT, 'qa-injected'); END`);
  return () => db.run(`DROP TRIGGER IF EXISTS temp.${name}`);
}

// ---------------------------------------------------------------------------
// Identity fixture (PLAN 4b-6)
// ---------------------------------------------------------------------------

export interface IdentityRows {
  readonly key: string;
  readonly cartProduct: string;
  readonly viewProduct: string;
  readonly defaultListId: string;
  readonly sflListId: string;
  readonly reviewId: string;
  readonly reviewProduct: string;
  readonly questionId: string;
  readonly answerId: string;
  readonly alertId: string;
  readonly contactId: string;
  readonly addressId: string;
  readonly orderId: string;
  readonly coupon: string;
}

let fixtureSeq = 0;

/**
 * One row in every owner-keyed table for `key`. `tag` makes names unique so
 * leakage greps can look for them. Products are chosen per `slot` (0..9) so
 * different identities do not collide on UNIQUE(product_id, session_id)
 * unless the caller wants them to.
 */
export function seedIdentity(
  db: Database,
  key: string,
  opts: { tag: string; slot: number; voteOn?: { reviewId?: string; questionId?: string; answerId?: string }; now?: number },
): IdentityRows {
  const products = (db.query("SELECT id FROM products WHERE stock > 0 ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  const p = (i: number): string => products[(opts.slot * 4 + i) % products.length] as string;
  const tag = opts.tag;
  const seq = ++fixtureSeq;
  const at = new Date((opts.now ?? T0) - 3_600_000 + seq * 1000).toISOString();

  db.query("INSERT OR IGNORE INTO carts (session_id, created_at, updated_at) VALUES (?, ?, ?)").run(key, at, at);
  db.query("INSERT INTO cart_items (cart_session_id, product_id, quantity, created_at, updated_at) VALUES (?, ?, 1, ?, ?)").run(
    key,
    p(0),
    at,
    at,
  );
  const defaultListId = uuid();
  db.query("INSERT INTO lists (id, session_id, name, kind, is_default, created_at, updated_at) VALUES (?, ?, ?, 'wishlist', 1, ?, ?)").run(
    defaultListId,
    key,
    `Wish ${tag}`,
    at,
    at,
  );
  db.query("INSERT INTO list_items (list_id, product_id, price_at_add_cents, note, added_at) VALUES (?, ?, 100, ?, ?)").run(
    defaultListId,
    p(1),
    `note ${tag}`,
    at,
  );
  const sflListId = uuid();
  db.query("INSERT INTO lists (id, session_id, name, kind, created_at, updated_at) VALUES (?, ?, 'Saved for later', 'save_for_later', ?, ?)").run(
    sflListId,
    key,
    at,
    at,
  );
  db.query("INSERT INTO list_items (list_id, product_id, price_at_add_cents, added_at) VALUES (?, ?, 100, ?)").run(sflListId, p(2), at);
  db.query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)").run(key, p(3), at);
  const reviewId = uuid();
  db.query(
    "INSERT INTO reviews (id, product_id, session_id, display_name, rating, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, 4, ?, ?, ?, ?)",
  ).run(reviewId, p(0), key, `Name ${tag}`, `Title ${tag}`, `Body ${tag}`, at, at);
  const questionId = uuid();
  db.query("INSERT INTO questions (id, product_id, session_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    questionId,
    p(1),
    key,
    `Name ${tag}`,
    `Question ${tag}?`,
    at,
  );
  const answerId = uuid();
  db.query("INSERT INTO answers (id, question_id, session_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    answerId,
    questionId,
    key,
    `Name ${tag}`,
    `Answer ${tag}`,
    at,
  );
  if (opts.voteOn?.reviewId) db.query("INSERT INTO review_votes (review_id, session_id) VALUES (?, ?)").run(opts.voteOn.reviewId, key);
  if (opts.voteOn?.questionId)
    db.query("INSERT INTO question_votes (question_id, session_id) VALUES (?, ?)").run(opts.voteOn.questionId, key);
  if (opts.voteOn?.answerId) db.query("INSERT INTO answer_votes (answer_id, session_id) VALUES (?, ?)").run(opts.voteOn.answerId, key);
  const alertId = uuid();
  db.query("INSERT INTO stock_alerts (id, product_id, session_id, created_at) VALUES (?, ?, ?, ?)").run(alertId, OUT_OF_STOCK, key, at);
  const contactId = uuid();
  db.query(
    "INSERT INTO contact_messages (id, reference, session_id, name, email, topic, message, created_at) VALUES (?, ?, ?, ?, ?, 'other', ?, ?)",
  ).run(contactId, `QA${seq}X${tag}`.slice(0, 32).padEnd(4, "0"), key, `Contact ${tag}`, `${tag}@contact.test`, `Message ${tag}`, at);
  const addressId = uuid();
  db.query(
    `INSERT INTO addresses (id, session_id, full_name, phone, line1, line2, city, region, postal_code, country, is_default, created_at, updated_at)
     VALUES (?, ?, ?, '555-0100', ?, 'Apt 1', 'Springfield', 'IL', '62701', 'US', 1, ?, ?)`,
  ).run(addressId, key, `Addr ${tag}`, `${seq} Main St ${tag}`, at, at);
  const orderId = uuid();
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, shipping_cents, total_cents, currency, full_name, email, line1, line2,
       city, region, postal_code, country, card_last4, payment_ref, idempotency_key, created_at, phone, delivery_note, coupon_code)
     VALUES (?, ?, 'paid', 4200, 500, 4700, 'USD', ?, ?, ?, 'Apt 1', 'Springfield', 'IL', '62701', 'US', '4242', ?, ?, ?, '555-0100', ?, 'WELCOME10')`,
  ).run(orderId, key, `Order ${tag}`, `${tag}@order.test`, `${seq} Order St`, `pay_${seq}`, `idem-${seq}-${tag}`, at, `Leave at door ${tag}`);
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'Item', 4200, 1)").run(orderId, p(0));
  db.query("INSERT INTO order_events (order_id, status, at) VALUES (?, 'processing', ?)").run(orderId, at);
  db.query("INSERT INTO coupon_redemptions (coupon_code, session_id, order_id, created_at) VALUES ('WELCOME10', ?, ?, ?)").run(key, orderId, at);

  return {
    key,
    cartProduct: p(0),
    viewProduct: p(3),
    defaultListId,
    sflListId,
    reviewId,
    reviewProduct: p(0),
    questionId,
    answerId,
    alertId,
    contactId,
    addressId,
    orderId,
    coupon: "WELCOME10",
  };
}

/** Rating aggregates match recomputation for every product (D row). */
export function ratingMismatches(db: Database): unknown[] {
  return db
    .query(
      `SELECT p.id, p.rating_count, p.rating_sum, COALESCE(r.c, 0) AS c, COALESCE(r.s, 0) AS s
         FROM products p
         LEFT JOIN (SELECT product_id, COUNT(*) AS c, SUM(rating) AS s FROM reviews WHERE status = 'published' GROUP BY product_id) r
           ON r.product_id = p.id
        WHERE p.rating_count <> COALESCE(r.c, 0) OR p.rating_sum <> COALESCE(r.s, 0)`,
    )
    .all();
}

/** helpful_count equals the vote row count for reviews/questions/answers. */
export function helpfulMismatches(db: Database): unknown[] {
  const q = (t: string, v: string, fk: string): unknown[] =>
    db
      .query(
        `SELECT t.id, t.helpful_count, (SELECT COUNT(*) FROM ${v} WHERE ${v}.${fk} = t.id) AS c FROM ${t} t
          WHERE t.helpful_count <> (SELECT COUNT(*) FROM ${v} WHERE ${v}.${fk} = t.id)`,
      )
      .all();
  return [...q("reviews", "review_votes", "review_id"), ...q("questions", "question_votes", "question_id"), ...q("answers", "answer_votes", "answer_id")];
}

/** Seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Question + answer + contact message + paid order (with item/event) for `key`; no UNIQUE-sensitive rows. */
export function seedOrderAndQa(db: Database, key: string, tag: string): { orderId: string; questionId: string } {
  const seq = ++fixtureSeq;
  const product = (db.query("SELECT id FROM products ORDER BY id LIMIT 1").get() as { id: string }).id;
  const questionId = uuid();
  db.query("INSERT INTO questions (id, product_id, session_id, display_name, body) VALUES (?, ?, ?, 'Q', ?)").run(questionId, product, key, `Q ${tag}?`);
  db.query("INSERT INTO answers (id, question_id, session_id, display_name, body) VALUES (?, ?, ?, 'Q', ?)").run(uuid(), questionId, key, `A ${tag}`);
  db.query(
    "INSERT INTO contact_messages (id, reference, session_id, name, email, topic, message) VALUES (?, ?, ?, 'C', 'c@c.test', 'other', 'm')",
  ).run(uuid(), `QX${seq}${tag}`.slice(0, 32).padEnd(4, "0"), key);
  const orderId = uuid();
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city, region, postal_code, country, card_last4, idempotency_key)
     VALUES (?, ?, 'paid', 100, 100, 'USD', 'O', 'o@o.test', 'l1', 'c', 'r', 'p', 'US', '4242', ?)`,
  ).run(orderId, key, `idem-x-${seq}-${tag}`);
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'I', 100, 1)").run(orderId, product);
  db.query("INSERT INTO order_events (order_id, status) VALUES (?, 'processing')").run(orderId);
  return { orderId, questionId };
}
