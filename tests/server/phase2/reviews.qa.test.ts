/**
 * QA adversarial tests for T34 (reviews service), src/server/reviews/**.
 * Owned by QA (QA-W1-T34). In-memory DB + seedDatabase; one worker-thread race
 * uses a temp file under os.tmpdir(). Orders are inserted as raw rows.
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
import { HIDDEN_REVIEW_IDS } from "@/server/db/seed-data/community";
import {
  DEFAULT_DISPLAY_NAME,
  createReviewService,
  type CreateReviewInput,
  type ReviewService,
} from "@/server/reviews/review-service";

const A = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const B = "7c1d2e3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f";
const C = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const FIXTURE_KEYS = [A, B, C] as const;
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const REVIEWS_DIR = join(import.meta.dir, "../../../src/server/reviews");

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
  readonly svc: ReviewService;
  /** Seeded product ids, sorted. */
  readonly products: string[];
  /** A seeded product with no seeded reviews is not guaranteed; QA products below have none. */
  readonly fresh: string[];
}

function harness(extraProducts = 3): Harness {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  open.push(db);
  const products = db
    .query<{ id: string }, []>("SELECT id FROM products ORDER BY id")
    .all()
    .map((r) => r.id);
  const ins = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 1000, 'USD', '/x.svg', 5)",
  );
  const fresh: string[] = [];
  for (let i = 0; i < extraProducts; i++) {
    const id = `qa-rev-${i}`;
    ins.run(id, `${id}-slug`, `QA ${i}`);
    fresh.push(id);
  }
  let clock = T0;
  const svc = createReviewService({ db, now: () => (clock += 1000) });
  return { db, svc, products, fresh };
}

function input(productId: string, overrides: Partial<CreateReviewInput> = {}): CreateReviewInput {
  return { productId, rating: 4, title: "Solid", body: "Does the job.", ...overrides };
}

function unwrap<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error(`expected error, got ${JSON.stringify(r.value)}`);
  return r.error;
}

function fieldCodes(e: AppError): Record<string, string> {
  const f = (e.details?.fields ?? {}) as Record<string, { code: string; message: string }>;
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.code]));
}

function count(db: Database, where = "1=1", ...params: string[]): number {
  return db.query<{ n: number }, string[]>(`SELECT COUNT(*) AS n FROM reviews WHERE ${where}`).get(...params)!.n;
}

function storedAgg(db: Database, productId: string) {
  return db
    .query<{ c: number; s: number }, [string]>("SELECT rating_count AS c, rating_sum AS s FROM products WHERE id = ?")
    .get(productId)!;
}

function freshAgg(db: Database, productId: string) {
  return db
    .query<{ c: number; s: number }, [string]>(
      "SELECT COUNT(*) AS c, coalesce(SUM(rating), 0) AS s FROM reviews WHERE product_id = ? AND status = 'published'",
    )
    .get(productId)!;
}

let orderSeq = 0;
function insertOrder(
  db: Database,
  sessionId: string,
  productIds: readonly string[],
  status: "paid" | "payment_failed" = "paid",
  fulfillment = "processing",
): string {
  const id = `qa_ord_${++orderSeq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, fulfillment_status, created_at)
     VALUES (?, ?, ?, 1000, 1000, 'USD', 'A', 'a@example.com', 'L1', 'C', 'R', '00000', 'US', '4242', ?, ?, ?)`,
  ).run(id, sessionId, status, `qa_idem_${id}`, fulfillment, new Date(T0).toISOString());
  const item = db.query(
    "INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'N', 1000, 1)",
  );
  for (const p of productIds) item.run(id, p);
  return id;
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function uuidFrom(r: () => number): string {
  const hex = () => Math.floor(r() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, hex).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-${"89ab"[Math.floor(r() * 4)]}${s(3)}-${s(12)}`;
}

/** A db proxy that records (and refuses) every property access: proves "no SQL". */
function trapDb(): { db: Database; touched: string[] } {
  const touched: string[] = [];
  const target = {} as Database;
  const db = new Proxy(target, {
    get(_t, prop) {
      touched.push(String(prop));
      throw new Error(`db touched: ${String(prop)}`);
    },
  });
  return { db, touched };
}

const INVALID_KEYS: readonly unknown[] = [
  "",
  " ",
  "not-a-uuid",
  A.toUpperCase(),
  ` ${A}`,
  `${A} `,
  `${A}\u0000`,
  "00000000-0000-0000-0000-000000000000",
  "3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b", // v1
  "seed_session_01",
  "' OR 1=1 --",
  "x".repeat(10_000),
  null,
  undefined,
  42,
  {},
  [A],
];

// ---------------------------------------------------------------------------
describe("criterion 1: validation, field errors, top-level code", () => {
  test("valid review stores trimmed/cleaned title, body, name", () => {
    const { db, svc, fresh } = harness();
    const r = unwrap(
      svc.create(A, input(fresh[0]!, { title: "   Nice\n\tkettle  ", body: "  a  \n\n\n\n b  ", displayName: "  Zoë  K " })),
    );
    expect(r.title).toBe("Nice kettle");
    expect(r.body).toBe("a\n\nb");
    expect(r.displayName).toBe("Zoë K");
    const row = db.query<{ title: string; body: string; display_name: string }, [string]>(
      "SELECT title, body, display_name FROM reviews WHERE id = ?",
    ).get(r.id)!;
    expect(row).toEqual({ title: "Nice kettle", body: "a\n\nb", display_name: "Zoë K" });
  });

  test.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace-only", "   \t "],
    ["zero-width only", "​​﻿"],
  ])("display name %s -> default %p", (_label, displayName) => {
    const { svc, fresh } = harness();
    expect(unwrap(svc.create(A, input(fresh[0]!, { displayName }))).displayName).toBe(DEFAULT_DISPLAY_NAME);
    expect(DEFAULT_DISPLAY_NAME).toBe("Anonymous shopper");
  });

  test.each([1, 2, 3, 4, 5, "1", "4", "5", " 3 "].map((v) => [v]))("rating %p accepted", (rating) => {
    const { svc, fresh } = harness();
    const r = unwrap(svc.create(A, input(fresh[0]!, { rating })));
    expect(r.rating as number).toBe(Number(String(rating).trim()));
  });

  test.each(
    [4.5, "4.0", "4.5", 0, 6, -1, "0", "6", "04", "+4", "4e0", "0x4", true, false, Number.NaN, Infinity, 4n, [4], {}].map(
      (v) => [v],
    ),
  )("rating %p -> VALIDATION_FAILED rating INVALID, nothing stored", (rating) => {
    const { db, svc, fresh } = harness();
    const e = errorOf(svc.create(A, input(fresh[0]!, { rating })));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fieldCodes(e)).toEqual({ rating: "INVALID" });
    expect(count(db, "product_id = ?", fresh[0]!)).toBe(0);
  });

  test.each([undefined, null, ""].map((v) => [v]))("rating %p -> REQUIRED", (rating) => {
    const { svc, fresh } = harness();
    expect(fieldCodes(errorOf(svc.create(A, input(fresh[0]!, { rating }))))).toEqual({ rating: "REQUIRED" });
  });

  test("missing title and body -> REQUIRED per field; non-string -> INVALID", () => {
    const { svc, fresh } = harness();
    const e1 = errorOf(svc.create(A, { productId: fresh[0]!, rating: 5, title: undefined, body: "  " }));
    expect(e1.code).toBe("VALIDATION_FAILED");
    expect(fieldCodes(e1)).toEqual({ title: "REQUIRED", body: "REQUIRED" });
    const e2 = errorOf(svc.create(A, { productId: fresh[0]!, rating: 5, title: 7, body: ["x"], displayName: {} }));
    expect(fieldCodes(e2)).toEqual({ title: "INVALID", body: "INVALID", displayName: "INVALID" });
  });

  test("limits: title 100 / body 2000 / name 50 accepted exactly, +1 -> TOO_LONG top-level", () => {
    const { db, svc, fresh } = harness();
    unwrap(svc.create(A, input(fresh[0]!, { title: "t".repeat(100), body: "b".repeat(2000), displayName: "n".repeat(50) })));
    const e = errorOf(
      svc.create(B, input(fresh[0]!, { title: "t".repeat(101), body: "b".repeat(2001), displayName: "n".repeat(51) })),
    );
    expect(e.code).toBe("TOO_LONG");
    expect(fieldCodes(e)).toEqual({ title: "TOO_LONG", body: "TOO_LONG", displayName: "TOO_LONG" });
    expect(count(db, "product_id = ?", fresh[0]!)).toBe(1);
  });

  test("length is measured after cleaning (101 chars with surrounding spaces is fine)", () => {
    const { svc, fresh } = harness();
    expect(unwrap(svc.create(A, input(fresh[0]!, { title: `  ${"t".repeat(100)}  ` }))).title.length).toBe(100);
  });

  test("TOO_LONG + any non-length error -> VALIDATION_FAILED with both field codes", () => {
    const { svc, fresh } = harness();
    const cases: [Partial<CreateReviewInput>, Record<string, string>][] = [
      [{ title: "t".repeat(101), rating: 0 }, { title: "TOO_LONG", rating: "INVALID" }],
      [{ displayName: "n".repeat(51), body: "" }, { displayName: "TOO_LONG", body: "REQUIRED" }],
      [
        { title: "t".repeat(101), body: "see http://a.example http://b.example http://c.example" },
        { title: "TOO_LONG", body: "TOO_MANY_URLS" },
      ],
    ];
    for (const [over, codes] of cases) {
      const e = errorOf(svc.create(A, input(fresh[0]!, over)));
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(fieldCodes(e)).toEqual(codes);
    }
  });

  test("body with 2 URLs ok; 3 URLs -> VALIDATION_FAILED body TOO_MANY_URLS", () => {
    const { db, svc, fresh } = harness();
    unwrap(svc.create(A, input(fresh[0]!, { body: "https://a.example and www.b.example" })));
    const e = errorOf(svc.create(B, input(fresh[0]!, { body: "https://a.example www.b.example http://c.example/x" })));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fieldCodes(e)).toEqual({ body: "TOO_MANY_URLS" });
    expect(count(db, "product_id = ?", fresh[0]!)).toBe(1);
  });

  test("every field error carries a non-empty message", () => {
    const { svc, fresh } = harness();
    const e = errorOf(svc.create(A, { productId: fresh[0]!, rating: 9, title: "", body: 3, displayName: "n".repeat(51) }));
    const f = e.details?.fields as Record<string, { code: string; message: string }>;
    expect(Object.keys(f).sort()).toEqual(["body", "displayName", "rating", "title"]);
    for (const v of Object.values(f)) expect(v.message.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("owner key guard: INVALID_INPUT before any SQL", () => {
  test.each(INVALID_KEYS.map((k) => [k]))("create/vote with key %p never touches db", (key) => {
    const { db, touched } = trapDb();
    const svc = createReviewService({ db, now: () => T0 });
    expect(errorOf(svc.create(key as string, input("p1"))).code).toBe("INVALID_INPUT");
    expect(errorOf(svc.voteHelpful(key as string, "rev_seed_002_01")).code).toBe("INVALID_INPUT");
    expect(svc.listMine(key as string)).toEqual([]);
    expect(svc.hasReviewed(key as string, "p1")).toBe(false);
    expect(touched).toEqual([]);
  });

  test("product id > 200 chars -> PRODUCT_NOT_FOUND without any query (create, list); summary zeros", () => {
    const { db, touched } = trapDb();
    const svc = createReviewService({ db, now: () => T0 });
    const long = "p".repeat(201);
    expect(errorOf(svc.create(A, input(long))).code).toBe("PRODUCT_NOT_FOUND");
    expect(errorOf(svc.list(long)).code).toBe("PRODUCT_NOT_FOUND");
    expect(errorOf(svc.list(long, {}, A)).code).toBe("PRODUCT_NOT_FOUND");
    expect(svc.summary(long)).toEqual({ count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
    expect(svc.hasReviewed(A, long)).toBe(false);
    expect(errorOf(svc.voteHelpful(A, "r".repeat(201))).code).toBe("NOT_FOUND");
    expect(touched).toEqual([]);
  });

  test("non-string product ids -> PRODUCT_NOT_FOUND without query", () => {
    const { db, touched } = trapDb();
    const svc = createReviewService({ db, now: () => T0 });
    for (const pid of [null, undefined, 42, {}, ""]) {
      expect(errorOf(svc.create(A, input(pid as string))).code).toBe("PRODUCT_NOT_FOUND");
    }
    expect(touched).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 2: DUPLICATE, race safety", () => {
  test("second review by same key -> DUPLICATE, nothing changes; other product succeeds", () => {
    const { db, svc, fresh } = harness();
    const first = unwrap(svc.create(A, input(fresh[0]!, { rating: 5, title: "First" })));
    const aggBefore = storedAgg(db, fresh[0]!);
    const snapshot = db.query("SELECT * FROM reviews WHERE product_id = ?").all(fresh[0]!);
    const e = errorOf(svc.create(A, input(fresh[0]!, { rating: 1, title: "Second" })));
    expect(e.code).toBe("DUPLICATE");
    expect(db.query("SELECT * FROM reviews WHERE product_id = ?").all(fresh[0]!)).toEqual(snapshot);
    expect(storedAgg(db, fresh[0]!)).toEqual(aggBefore);
    expect(svc.list(fresh[0]!).ok && unwrap(svc.list(fresh[0]!)).items.map((i) => i.id)).toEqual([first.id]);
    unwrap(svc.create(A, input(fresh[1]!)));
    expect(count(db, "session_id = ?", A)).toBe(2);
  });

  test("Promise.all of 10 creates for one key/product -> exactly 1 row, 9 DUPLICATE", async () => {
    const { db, svc, fresh } = harness();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() => svc.create(A, input(fresh[0]!, { rating: (i % 5) + 1 })))),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok && r.error.code === "DUPLICATE").length).toBe(9);
    expect(count(db, "product_id = ?", fresh[0]!)).toBe(1);
    expect(storedAgg(db, fresh[0]!)).toEqual(freshAgg(db, fresh[0]!));
  });

  const tmpDirs: string[] = [];
  afterAll(() => {
    for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  });

  test(
    "worker threads on separate connections: 10 creates -> 1 row; 10 double-votes -> 1 vote",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "qa-t34-"));
      tmpDirs.push(dir);
      const dbPath = join(dir, "reviews.sqlite");
      const db = createDatabase(dbPath);
      runMigrations(db);
      seedDatabase(db);
      db.query(
        "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('qa-w', 'qa-w', 'W', 100, 'USD', '/x.svg', 1)",
      ).run();
      const target = unwrap(createReviewService({ db }).create(C, input("qa-w")));
      db.close();

      const workerSrc = join(dir, "worker.ts");
      writeFileSync(
        workerSrc,
        `import { createDatabase } from ${JSON.stringify(join(REVIEWS_DIR, "../db/client.ts"))};
import { createReviewService } from ${JSON.stringify(join(REVIEWS_DIR, "review-service.ts"))};
declare const self: Worker;
self.onmessage = (e: MessageEvent) => {
  const { dbPath, kind, session, reviewId } = e.data as { dbPath: string; kind: string; session: string; reviewId: string };
  const db = createDatabase(dbPath);
  db.exec("PRAGMA busy_timeout = 10000");
  const svc = createReviewService({ db });
  const r = kind === "create"
    ? svc.create(session, { productId: "qa-w", rating: 3, title: "t", body: "b" })
    : svc.voteHelpful(session, reviewId);
  db.close();
  postMessage(r.ok ? "ok" : r.error.code);
};
`,
      );
      const run = (kind: string, session: string) =>
        new Promise<string>((resolve, reject) => {
          const w = new Worker(workerSrc);
          w.onmessage = (e: MessageEvent) => {
            resolve(e.data as string);
            w.terminate();
          };
          w.onerror = (e) => reject(e);
          w.postMessage({ dbPath, kind, session, reviewId: target.id });
        });
      const out = await Promise.all([
        ...Array.from({ length: 10 }, () => run("create", A)),
        ...Array.from({ length: 10 }, () => run("vote", B)),
      ]);
      const creates = out.slice(0, 10);
      const votes = out.slice(10);
      expect(creates.filter((x) => x === "ok").length).toBe(1);
      expect(creates.filter((x) => x === "DUPLICATE").length).toBe(9);
      expect(votes.filter((x) => x === "ok").length).toBe(1);
      expect(votes.filter((x) => x === "DUPLICATE").length).toBe(9);
      const check = createDatabase(dbPath);
      open.push(check);
      expect(count(check, "product_id = 'qa-w' AND session_id = ?", A)).toBe(1);
      expect(storedAgg(check, "qa-w")).toEqual(freshAgg(check, "qa-w"));
      expect(
        check.query<{ h: number }, [string]>("SELECT helpful_count AS h FROM reviews WHERE id = ?").get(target.id)!.h,
      ).toBe(1);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
describe("criterion 3: unknown product", () => {
  test.each(["nope", "' OR 1=1 --", "%", "p".repeat(200)].map((v) => [v]))("create/list %p -> PRODUCT_NOT_FOUND", (pid) => {
    const { db, svc } = harness();
    const before = count(db);
    expect(errorOf(svc.create(A, input(pid))).code).toBe("PRODUCT_NOT_FOUND");
    expect(errorOf(svc.list(pid)).code).toBe("PRODUCT_NOT_FOUND");
    expect(count(db)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 4: verified purchase", () => {
  test("true only for paid, non-cancelled order of that key containing the product", () => {
    const { svc, db, fresh } = harness(8);
    const [pPaid, pCancelled, pFailed, pOther, pOtherKey, pShipped, pDelivered, pMixed] = fresh as [
      string, string, string, string, string, string, string, string,
    ];
    insertOrder(db, A, [pPaid]);
    insertOrder(db, A, [pCancelled], "paid", "cancelled");
    insertOrder(db, A, [pFailed], "payment_failed");
    insertOrder(db, A, ["some-other-product"]);
    insertOrder(db, B, [pOtherKey]);
    insertOrder(db, A, [pShipped], "paid", "shipped");
    insertOrder(db, A, [pDelivered, "x-1"], "paid", "delivered");
    insertOrder(db, A, [pMixed], "paid", "cancelled");
    insertOrder(db, A, [pMixed], "payment_failed", "processing");
    const v = (p: string) => unwrap(svc.create(A, input(p))).verifiedPurchase;
    expect(v(pPaid)).toBe(true);
    expect(v(pCancelled)).toBe(false);
    expect(v(pFailed)).toBe(false);
    expect(v(pOther)).toBe(false);
    expect(v(pOtherKey)).toBe(false);
    expect(v(pShipped)).toBe(true);
    expect(v(pDelivered)).toBe(true);
    expect(v(pMixed)).toBe(false);
    // stored column agrees
    expect(count(db, "session_id = ? AND verified_purchase = 1", A)).toBe(3);
  });

  test("verified flag in input is ignored", () => {
    const { svc, fresh } = harness();
    const hostile = { ...input(fresh[0]!), verifiedPurchase: true, verified_purchase: 1, helpfulCount: 99, status: "hidden" };
    const r = unwrap(svc.create(A, hostile));
    expect(r.verifiedPurchase).toBe(false);
    expect(r.helpfulCount).toBe(0);
    expect(r.status).toBe("published");
  });
});

// ---------------------------------------------------------------------------
describe("criterion 5: rating aggregates and histogram", () => {
  function assertAll(db: Database, svc: ReviewService, products: readonly string[]): void {
    for (const p of products) {
      const s = storedAgg(db, p);
      const f = freshAgg(db, p);
      expect({ p, ...s }).toEqual({ p, ...f });
      const sum = svc.summary(p);
      const h = sum.histogram;
      expect(h[1] + h[2] + h[3] + h[4] + h[5]).toBe(sum.count);
      expect(sum.count).toBe(f.c);
      expect(sum.avg).toBe(f.c === 0 ? 0 : Math.round((f.s / f.c) * 10) / 10);
    }
  }

  test("50 random creates (incl. duplicates/invalid) across seeded + fresh products keep aggregates exact", () => {
    const { db, svc, products, fresh } = harness(5);
    const r = rng(34);
    const pool = [...products.slice(0, 10), ...fresh];
    const keys = Array.from({ length: 12 }, () => uuidFrom(r));
    let ok = 0;
    for (let i = 0; i < 50; i++) {
      const p = pool[Math.floor(r() * pool.length)]!;
      const k = keys[Math.floor(r() * keys.length)]!;
      const rating = r() < 0.1 ? 7 : Math.floor(r() * 5) + 1;
      const res = svc.create(k, input(p, { rating }));
      if (res.ok) ok++;
      else expect(["DUPLICATE", "VALIDATION_FAILED"]).toContain(res.error.code);
      assertAll(db, svc, [p]);
    }
    expect(ok).toBeGreaterThan(20);
    assertAll(db, svc, pool);

    // direct moderation SQL: hide some, unhide one, delete one
    const ids = db
      .query<{ id: string; product_id: string }, []>(
        "SELECT id, product_id FROM reviews WHERE product_id LIKE 'qa-rev-%' OR product_id IN (SELECT id FROM products ORDER BY id LIMIT 10) ORDER BY id",
      )
      .all();
    for (const row of ids.filter((_, i) => i % 3 === 0)) {
      db.query("UPDATE reviews SET status = 'hidden' WHERE id = ?").run(row.id);
    }
    assertAll(db, svc, pool);
    db.query("UPDATE reviews SET status = 'published' WHERE id = ?").run(ids[0]!.id);
    db.query("DELETE FROM reviews WHERE id = ?").run(ids[1]!.id);
    assertAll(db, svc, pool);
    // creating after moderation still exact
    unwrap(svc.create(uuidFrom(r), input(fresh[0]!, { rating: 2 })));
    assertAll(db, svc, pool);
  });

  test("seeded catalogue: every product's stored aggregate equals a fresh one; hidden seed reviews excluded", () => {
    const { db, svc, products } = harness(0);
    assertAll(db, svc, products);
    const hiddenProducts = db
      .query<{ product_id: string }, [string, string]>("SELECT product_id FROM reviews WHERE id IN (?, ?)")
      .all(HIDDEN_REVIEW_IDS[0]!, HIDDEN_REVIEW_IDS[1]!)
      .map((x) => x.product_id);
    expect(hiddenProducts.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 6: helpful votes", () => {
  test("vote once; second DUPLICATE (count unchanged); own review FORBIDDEN; unknown/hidden NOT_FOUND", () => {
    const { db, svc, fresh } = harness();
    const rev = unwrap(svc.create(A, input(fresh[0]!)));
    expect(unwrap(svc.voteHelpful(B, rev.id))).toEqual({ helpfulCount: 1 });
    expect(errorOf(svc.voteHelpful(B, rev.id)).code).toBe("DUPLICATE");
    expect(errorOf(svc.voteHelpful(A, rev.id)).code).toBe("FORBIDDEN");
    expect(unwrap(svc.voteHelpful(C, rev.id))).toEqual({ helpfulCount: 2 });
    expect(db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM review_votes WHERE review_id = ?").get(rev.id)!.n).toBe(2);
    expect(errorOf(svc.voteHelpful(B, "missing-review")).code).toBe("NOT_FOUND");
    expect(errorOf(svc.voteHelpful(B, "")).code).toBe("NOT_FOUND");
    expect(errorOf(svc.voteHelpful(B, HIDDEN_REVIEW_IDS[0]!)).code).toBe("NOT_FOUND");
    db.query("UPDATE reviews SET status = 'hidden' WHERE id = ?").run(rev.id);
    expect(errorOf(svc.voteHelpful(uuidFrom(rng(1)), rev.id)).code).toBe("NOT_FOUND");
  });

  test("Promise.all double vote counts once", async () => {
    const { db, svc, fresh } = harness();
    const rev = unwrap(svc.create(A, input(fresh[0]!)));
    const out = await Promise.all([
      Promise.resolve().then(() => svc.voteHelpful(B, rev.id)),
      Promise.resolve().then(() => svc.voteHelpful(B, rev.id)),
    ]);
    expect(out.filter((r) => r.ok).length).toBe(1);
    expect(out.filter((r) => !r.ok && r.error.code === "DUPLICATE").length).toBe(1);
    expect(db.query<{ h: number }, [string]>("SELECT helpful_count AS h FROM reviews WHERE id = ?").get(rev.id)!.h).toBe(1);
  });

  test("seeded review: vote increments from seeded count", () => {
    const { db, svc } = harness(0);
    const row = db
      .query<{ id: string; h: number }, []>("SELECT id, helpful_count AS h FROM reviews WHERE status = 'published' ORDER BY id LIMIT 1")
      .get()!;
    expect(unwrap(svc.voteHelpful(A, row.id)).helpfulCount).toBe(row.h + 1);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 7: list", () => {
  function setupList() {
    const h = harness(1);
    const p = h.fresh[0]!;
    const r = rng(7);
    const keys = Array.from({ length: 25 }, () => uuidFrom(r));
    const voters = Array.from({ length: 6 }, () => uuidFrom(r));
    const created = keys.map((k, i) => unwrap(h.svc.create(k, input(p, { rating: (i % 5) + 1, title: `R${i}` }))));
    // helpful votes: review i gets (i % 4) votes
    created.forEach((rev, i) => {
      for (let v = 0; v < i % 4; v++) unwrap(h.svc.voteHelpful(voters[v]!, rev.id));
    });
    // verified: buyer keys[3] purchase before review? verified is computed at create; create one verified review
    const buyer = uuidFrom(r);
    insertOrder(h.db, buyer, [p]);
    const verified = unwrap(h.svc.create(buyer, input(p, { rating: 2 })));
    return { ...h, p, keys, voters, created, verified, buyer };
  }

  test("sort helpful: helpful_count desc then recency desc; default and unknown sort = helpful", () => {
    const { svc, p } = setupList();
    const all = unwrap(svc.list(p, { pageSize: 20, sort: "helpful" }));
    const rest = unwrap(svc.list(p, { pageSize: 20, page: 2, sort: "helpful" }));
    const items = [...all.items, ...rest.items];
    expect(items.length).toBe(26);
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1]!;
      const b = items[i]!;
      expect(a.helpfulCount > b.helpfulCount || (a.helpfulCount === b.helpfulCount && a.createdAt >= b.createdAt)).toBe(true);
    }
    expect(unwrap(svc.list(p, { pageSize: 20 })).items.map((i) => i.id)).toEqual(all.items.map((i) => i.id));
    expect(unwrap(svc.list(p, { pageSize: 20, sort: "DROP TABLE" })).items.map((i) => i.id)).toEqual(all.items.map((i) => i.id));
  });

  test("sort recent: strictly by created_at desc", () => {
    const { svc, p } = setupList();
    const items = unwrap(svc.list(p, { sort: "recent", pageSize: 20 })).items;
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.createdAt > items[i]!.createdAt).toBe(true);
  });

  test("stars filter returns only that rating and filters total/pageCount; summary unfiltered", () => {
    const { svc, p } = setupList();
    const base = unwrap(svc.list(p));
    for (const stars of [1, 2, 3, 4, 5] as const) {
      const res = unwrap(svc.list(p, { stars, pageSize: 20 }));
      expect(res.items.every((i) => i.rating === stars)).toBe(true);
      expect(res.total).toBe(base.summary.histogram[stars]);
      expect(res.summary).toEqual(base.summary);
    }
  });

  test("verifiedOnly filter; summary ignores filters", () => {
    const { svc, p, verified } = setupList();
    const res = unwrap(svc.list(p, { verifiedOnly: true }));
    expect(res.items.map((i) => i.id)).toEqual([verified.id]);
    expect(res.total).toBe(1);
    expect(res.summary.count).toBe(26);
    expect(unwrap(svc.list(p, { verifiedOnly: true, stars: 5 })).items).toEqual([]);
  });

  test.each([
    [0, 1],
    [-5, 1],
    [1, 1],
    [2.9, 2],
    [20, 20],
    [21, 20],
    [1e9, 20],
    [Number.NaN, 10],
    [Infinity, 10],
    [undefined, 10],
  ])("pageSize %p -> %p items per page", (pageSize, expected) => {
    const { svc, p } = setupList();
    const res = unwrap(svc.list(p, { pageSize: pageSize as number }));
    expect(res.items.length).toBe(expected);
    expect(res.pageCount).toBe(Math.ceil(26 / expected));
  });

  test("page past end -> empty items echoing page; invalid page -> 1", () => {
    const { svc, p } = setupList();
    const past = unwrap(svc.list(p, { page: 4, pageSize: 10 }));
    expect(past.items).toEqual([]);
    expect(past.page).toBe(4);
    expect(past.total).toBe(26);
    expect(past.pageCount).toBe(3);
    const huge = unwrap(svc.list(p, { page: 999_999 }));
    expect(huge.items).toEqual([]);
    expect(huge.page).toBe(999_999);
    for (const page of [0, -1, Number.NaN]) expect(unwrap(svc.list(p, { page })).page).toBe(1);
    const last = unwrap(svc.list(p, { page: 3, pageSize: 10 }));
    expect(last.items.length).toBe(6);
  });

  test("pages are disjoint and cover everything exactly once", () => {
    const { svc, p } = setupList();
    const seen = new Set<string>();
    for (let page = 1; page <= 6; page++) for (const i of unwrap(svc.list(p, { page, pageSize: 5 })).items) seen.add(i.id);
    expect(seen.size).toBe(26);
  });

  test("hidden reviews never listed, counted or summarised (seed + direct UPDATE)", () => {
    const { db, svc, p, created } = setupList();
    db.query("UPDATE reviews SET status = 'hidden' WHERE id = ?").run(created[0]!.id);
    const res = unwrap(svc.list(p, { pageSize: 20 }));
    const page2 = unwrap(svc.list(p, { pageSize: 20, page: 2 }));
    const ids = [...res.items, ...page2.items].map((i) => i.id);
    expect(ids).not.toContain(created[0]!.id);
    expect(res.total).toBe(25);
    expect(res.summary.count).toBe(25);
    expect(svc.summary(p).count).toBe(25);
    expect(unwrap(svc.list(p, { stars: 1, pageSize: 20 })).items.map((i) => i.id)).not.toContain(created[0]!.id);
    // seeded hidden reviews
    for (const hid of HIDDEN_REVIEW_IDS) {
      const prod = db.query<{ product_id: string }, [string]>("SELECT product_id FROM reviews WHERE id = ?").get(hid)!.product_id;
      const listed: string[] = [];
      for (let page = 1; page <= 5; page++) listed.push(...unwrap(svc.list(prod, { page, pageSize: 20 })).items.map((i) => i.id));
      expect(listed).not.toContain(hid);
      expect(unwrap(svc.list(prod)).total).toBe(freshAgg(db, prod).c);
    }
  });

  test("isOwn/votedByViewer only with a valid viewer key", () => {
    const { svc, p, keys, voters, created } = setupList();
    const anon = unwrap(svc.list(p, { pageSize: 20 }));
    for (const i of anon.items) {
      expect("isOwn" in i).toBe(false);
      expect("votedByViewer" in i).toBe(false);
    }
    for (const bad of ["nope", A.toUpperCase(), null, undefined, ""]) {
      for (const i of unwrap(svc.list(p, { pageSize: 20 }, bad as string | null)).items) {
        expect("isOwn" in i || "votedByViewer" in i).toBe(false);
      }
    }
    const asAuthor = unwrap(svc.list(p, { pageSize: 20, sort: "recent", page: 1 }, keys[5]!));
    const asAuthor2 = unwrap(svc.list(p, { pageSize: 20, sort: "recent", page: 2 }, keys[5]!));
    const own = [...asAuthor.items, ...asAuthor2.items].filter((i) => i.isOwn === true);
    expect(own.map((i) => i.id)).toEqual([created[5]!.id]);
    const asVoter = [
      ...unwrap(svc.list(p, { pageSize: 20 }, voters[0]!)).items,
      ...unwrap(svc.list(p, { pageSize: 20, page: 2 }, voters[0]!)).items,
    ];
    const votedIds = new Set(asVoter.filter((i) => i.votedByViewer === true).map((i) => i.id));
    const expected = new Set(created.filter((_, i) => i % 4 >= 1).map((r) => r.id));
    expect(votedIds).toEqual(expected);
    expect(asVoter.every((i) => typeof i.isOwn === "boolean" && typeof i.votedByViewer === "boolean")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("criterion 8 + hostile text", () => {
  test("<img src=x onerror=1> stored and returned verbatim", () => {
    const { db, svc, fresh } = harness();
    const payload = "<img src=x onerror=1>";
    const r = unwrap(svc.create(A, input(fresh[0]!, { title: payload, body: `${payload} <script>alert(1)</script>`, displayName: payload })));
    expect(r.title).toBe(payload);
    expect(r.body).toBe(`${payload} <script>alert(1)</script>`);
    expect(r.displayName).toBe(payload);
    expect(unwrap(svc.list(fresh[0]!)).items[0]!.title).toBe(payload);
    expect(db.query<{ t: string }, [string]>("SELECT title AS t FROM reviews WHERE id = ?").get(r.id)!.t).toBe(payload);
  });

  test("SQL-looking, RTL, emoji text stored verbatim; zero-width/NUL/bidi controls stripped", () => {
    const { svc, fresh } = harness();
    const sql = "Robert'); DROP TABLE reviews;-- %_";
    expect(unwrap(svc.create(A, input(fresh[0]!, { title: sql }))).title).toBe(sql);
    const rtl = "مرحبا بالعالم שלום";
    expect(unwrap(svc.create(B, input(fresh[0]!, { title: rtl, body: "\u{1F600} ok \u{1F44D}" })))).toMatchObject({
      title: rtl,
      body: "\u{1F600} ok \u{1F44D}",
    });
    const r = unwrap(svc.create(C, input(fresh[0]!, { title: "a\u0000b​c‮d﻿e", body: "x\u0000\u0007y" })));
    expect(r.title).toBe("abcde");
    expect(r.body).toBe("xy");
  });

  test("10k-char and 100k-char inputs -> TOO_LONG, never throw", () => {
    const { db, svc, fresh } = harness();
    for (const len of [10_000, 100_000]) {
      for (const field of ["title", "body", "displayName"] as const) {
        const e = errorOf(svc.create(A, input(fresh[0]!, { [field]: "x".repeat(len) })));
        expect(e.code).toBe("TOO_LONG");
        expect(fieldCodes(e)).toEqual({ [field]: "TOO_LONG" });
      }
    }
    expect(count(db, "product_id = ?", fresh[0]!)).toBe(0);
  });

  test("lone surrogates / NUL-only / control-only text never throws", () => {
    const { svc, fresh } = harness();
    expect(() => svc.create(A, input(fresh[0]!, { title: "\ud800x", body: "\udc00" }))).not.toThrow();
    const e = errorOf(svc.create(B, input(fresh[0]!, { title: "\u0000\u0000", body: "\u0001\u001f" })));
    expect(fieldCodes(e)).toEqual({ title: "REQUIRED", body: "REQUIRED" });
  });
});

// ---------------------------------------------------------------------------
describe("owner keys never serialised", () => {
  test("JSON of every service output and error contains none of the fixture keys", () => {
    const { db, svc, fresh } = harness();
    insertOrder(db, A, [fresh[0]!]);
    const outputs: unknown[] = [];
    const ra = svc.create(A, input(fresh[0]!));
    outputs.push(ra, svc.create(A, input(fresh[0]!)), svc.create(B, input(fresh[0]!)));
    const id = unwrap(ra).id;
    outputs.push(svc.voteHelpful(B, id), svc.voteHelpful(B, id), svc.voteHelpful(A, id), svc.voteHelpful(C, "missing"));
    for (const viewer of [A, B, C, null]) outputs.push(svc.list(fresh[0]!, { pageSize: 20 }, viewer));
    outputs.push(svc.listMine(A), svc.listMine(B), svc.summary(fresh[0]!), svc.hasReviewed(A, fresh[0]!));
    outputs.push(svc.create(A, input(fresh[1]!, { rating: 0, title: "" })), svc.create(A, input("nope")));
    const json = JSON.stringify(outputs);
    for (const key of FIXTURE_KEYS) expect(json).not.toContain(key);
    expect(json).not.toContain("session");
    expect(json).not.toContain("seed_session");
  });
});

// ---------------------------------------------------------------------------
describe("listMine / hasReviewed isolation", () => {
  test("two keys see only their own reviews; hidden own reviews included in listMine", () => {
    const { db, svc, fresh } = harness();
    const a1 = unwrap(svc.create(A, input(fresh[0]!)));
    const a2 = unwrap(svc.create(A, input(fresh[1]!)));
    const b1 = unwrap(svc.create(B, input(fresh[0]!)));
    expect(svc.listMine(A).map((r) => r.id).sort()).toEqual([a1.id, a2.id].sort());
    expect(svc.listMine(B).map((r) => r.id)).toEqual([b1.id]);
    expect(svc.listMine(C)).toEqual([]);
    expect(svc.hasReviewed(A, fresh[1]!)).toBe(true);
    expect(svc.hasReviewed(B, fresh[1]!)).toBe(false);
    expect(svc.hasReviewed(C, fresh[0]!)).toBe(false);
    db.query("UPDATE reviews SET status = 'hidden' WHERE id = ?").run(a1.id);
    expect(svc.listMine(A).find((r) => r.id === a1.id)?.status).toBe("hidden");
    expect(svc.hasReviewed(A, fresh[0]!)).toBe(true);
    expect(svc.listMine(A)[0]!.id).toBe(a2.id); // newest first
  });
});

// ---------------------------------------------------------------------------
describe("static checks on src/server/reviews", () => {
  const files = readdirSync(REVIEWS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, src: readFileSync(join(REVIEWS_DIR, f), "utf8") }));
  const prod = files.filter(({ f }) => !f.endsWith(".test.ts"));

  test("no any / ts-ignore / ts-expect-error / console in production files", () => {
    for (const { f, src } of prod) {
      expect({ f, hit: /:\s*any\b|\bas any\b|<any>/.test(src) }).toEqual({ f, hit: false });
      expect({ f, hit: /@ts-(ignore|expect-error|nocheck)/.test(src) }).toEqual({ f, hit: false });
      expect({ f, hit: /console\./.test(src) }).toEqual({ f, hit: false });
    }
  });

  test("SQL interpolations are limited to module constants / built clauses (no values)", () => {
    const repo = prod.find(({ f }) => f === "review-repository.ts")!.src;
    const interps = [...repo.matchAll(/\$\{([^}]+)\}/g)].map((m) => m[1]!.trim());
    expect(new Set(interps)).toEqual(new Set(["REVIEW_COLUMNS", "where.sql", "order"]));
    const svc = prod.find(({ f }) => f === "review-service.ts")!.src;
    expect(/\.(query|prepare|run|exec)\(/.test(svc)).toBe(false);
  });
});
