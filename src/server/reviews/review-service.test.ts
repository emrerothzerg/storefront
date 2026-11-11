import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Review } from "@/lib/types";
import type { AppError, Result } from "@/lib/result";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { HIDDEN_REVIEW_IDS } from "@/server/db/seed-data/community";
import {
  createReviewService,
  DEFAULT_DISPLAY_NAME,
  type CreateReviewInput,
  type ReviewListResult,
  type ReviewService,
} from "./review-service";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";
const T0 = Date.UTC(2026, 10, 7, 12, 0, 0);

function setup(productIds: readonly string[] = ["p1", "p2"]) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  const insert = db.query(
    "INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES (?, ?, ?, 1000, 'USD', '/x.svg', 5)",
  );
  for (const id of productIds) insert.run(id, `${id}-slug`, `Name ${id}`);
  let clock = T0;
  const service = createReviewService({ db, now: () => (clock += 1000) });
  return { db, service };
}

function uuid(n: number): string {
  return `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function input(overrides: Partial<CreateReviewInput> = {}): CreateReviewInput {
  return { productId: "p1", rating: 5, title: "Great", body: "Works well.", ...overrides };
}

function unwrap<T>(r: Result<T, AppError>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}

function errorOf<T>(r: Result<T, AppError>): AppError {
  if (r.ok) throw new Error("expected error");
  return r.error;
}

function fields(e: AppError): Record<string, { code: string }> {
  return (e.details?.fields ?? {}) as Record<string, { code: string }>;
}

function reviewCount(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM reviews").get() as { n: number }).n;
}

function stored(db: Database, productId: string) {
  return db.query("SELECT rating_count AS c, rating_sum AS s FROM products WHERE id = ?").get(productId) as {
    c: number;
    s: number;
  };
}

function fresh(db: Database, productId: string) {
  return db
    .query(
      "SELECT COUNT(*) AS c, coalesce(SUM(rating), 0) AS s FROM reviews WHERE product_id = ? AND status = 'published'",
    )
    .get(productId) as { c: number; s: number };
}

let orderSeq = 0;
function insertOrder(
  db: Database,
  sessionId: string,
  productId: string,
  status: "paid" | "payment_failed" = "paid",
  fulfillment = "processing",
) {
  const id = `ord_${++orderSeq}`;
  db.query(
    `INSERT INTO orders (id, session_id, status, subtotal_cents, total_cents, currency, full_name, email, line1, city,
       region, postal_code, country, card_last4, idempotency_key, fulfillment_status)
     VALUES (?, ?, ?, 1000, 1000, 'USD', 'A', 'a@example.com', 'L1', 'C', 'R', '00000', 'US', '4242', ?, ?)`,
  ).run(id, sessionId, status, `idem_${id}`, fulfillment);
  db.query("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, 'N', 1000, 1)").run(
    id,
    productId,
  );
}

describe("create: validation (criterion 1)", () => {
  test("valid review stores cleaned title/body/name and returns it", () => {
    const { db, service } = setup();
    const review = unwrap(
      service.create(S1, input({ title: "  Great \t mug  ", body: "  Line one  \r\n\r\n\r\n line two ", displayName: "  Ann  B " })),
    );
    expect(review).toMatchObject({
      productId: "p1",
      rating: 5,
      title: "Great mug",
      body: "Line one\n\nline two",
      displayName: "Ann B",
      verifiedPurchase: false,
      helpfulCount: 0,
      status: "published",
    });
    expect(review.createdAt).toBe(new Date(T0 + 1000).toISOString());
    expect(review.updatedAt).toBe(review.createdAt);
    expect("sessionId" in review).toBe(false);
    expect(JSON.stringify(review)).not.toContain(S1);
    const row = db.query("SELECT title, body, display_name, session_id FROM reviews").get();
    expect(row).toEqual({ title: "Great mug", body: "Line one\n\nline two", display_name: "Ann B", session_id: S1 });
  });

  test("explicit now argument sets createdAt", () => {
    const { service } = setup();
    const at = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(unwrap(service.create(S1, input(), at)).createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(errorOf(service.create(S2, input(), Number.NaN)).code).toBe("INVALID_INPUT");
  });

  test("display name defaults to Anonymous shopper when missing, empty or whitespace", () => {
    const { service } = setup(["p1", "p2", "p3"]);
    expect(unwrap(service.create(S1, input({ productId: "p1" }))).displayName).toBe(DEFAULT_DISPLAY_NAME);
    expect(unwrap(service.create(S1, input({ productId: "p2", displayName: "" }))).displayName).toBe(DEFAULT_DISPLAY_NAME);
    expect(unwrap(service.create(S1, input({ productId: "p3", displayName: "  ​\t " }))).displayName).toBe(
      DEFAULT_DISPLAY_NAME,
    );
  });

  test("rating accepts integers 1..5 and single-digit strings", () => {
    const { service } = setup(["a", "b", "c", "d", "e", "f"]);
    const ids = ["a", "b", "c", "d", "e"];
    ids.forEach((id, i) => expect(unwrap(service.create(S1, input({ productId: id, rating: i + 1 }))).rating as number).toBe(i + 1));
    expect(unwrap(service.create(S1, input({ productId: "f", rating: " 4 " }))).rating).toBe(4);
  });

  test.each([0, 6, -1, 4.5, Number.NaN, Infinity, "4.0", "45", "four", true, {}, [5], "", null, undefined].map((v) => [v]))(
    "rating %p -> VALIDATION_FAILED with a rating field error",
    (rating: unknown) => {
      const { db, service } = setup();
      const e = errorOf(service.create(S1, input({ rating })));
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(Object.keys(fields(e))).toEqual(["rating"]);
      expect(reviewCount(db)).toBe(0);
    },
  );

  test("missing / blank / non-string title and body -> VALIDATION_FAILED per field", () => {
    const { db, service } = setup();
    for (const [title, body] of [
      [undefined, undefined],
      ["", "   "],
      [null, "​​"],
      [42, { text: "x" }],
    ] as const) {
      const e = errorOf(service.create(S1, input({ title, body })));
      expect(e.code).toBe("VALIDATION_FAILED");
      expect(Object.keys(fields(e)).sort()).toEqual(["body", "title"]);
    }
    expect(reviewCount(db)).toBe(0);
  });

  test("all problems are reported together", () => {
    const { service } = setup();
    const e = errorOf(service.create(S1, { productId: "p1", rating: 9, title: "", body: "", displayName: 7 }));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fields(e)).toMatchObject({
      rating: { code: "INVALID" },
      title: { code: "REQUIRED" },
      body: { code: "REQUIRED" },
      displayName: { code: "INVALID" },
    });
  });

  test("limits: title 100, body 2000, name 50 accepted at the limit", () => {
    const { service } = setup();
    const r = unwrap(service.create(S1, input({ title: "t".repeat(100), body: "b".repeat(2000), displayName: "n".repeat(50) })));
    expect([r.title.length, r.body.length, r.displayName.length]).toEqual([100, 2000, 50]);
  });

  test.each([
    ["title", { title: "t".repeat(101) }],
    ["body", { body: "b".repeat(2001) }],
    ["displayName", { displayName: "n".repeat(51) }],
    ["title", { title: "t".repeat(100_000) }],
  ] as const)("%s over the limit -> TOO_LONG", (field, overrides) => {
    const { db, service } = setup();
    const e = errorOf(service.create(S1, input(overrides)));
    expect(e.code).toBe("TOO_LONG");
    expect(fields(e)[field]?.code).toBe("TOO_LONG");
    expect(reviewCount(db)).toBe(0);
  });

  test("too long mixed with another invalid field -> VALIDATION_FAILED listing both", () => {
    const { service } = setup();
    const e = errorOf(service.create(S1, input({ title: "t".repeat(101), rating: 0 })));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fields(e)).toMatchObject({ title: { code: "TOO_LONG" }, rating: { code: "INVALID" } });
  });

  test("body with more than 2 URLs -> VALIDATION_FAILED; 2 URLs is fine", () => {
    const { db, service } = setup();
    const e = errorOf(service.create(S1, input({ body: "see http://a.example https://b.example www.c.example" })));
    expect(e.code).toBe("VALIDATION_FAILED");
    expect(fields(e).body?.code).toBe("TOO_MANY_URLS");
    expect(reviewCount(db)).toBe(0);
    expect(unwrap(service.create(S1, input({ body: "see http://a.example and www.b.example" }))).body).toContain("www.b");
  });

  test("invalid owner key -> INVALID_INPUT before validation and without SQL", () => {
    const { db, service } = setup();
    db.close(); // any SQL would now throw
    for (const s of ["", "nope", S3.toUpperCase(), `${S1} `, "x".repeat(10_000)]) {
      expect(errorOf(service.create(s, input({ rating: 99 }))).code).toBe("INVALID_INPUT");
    }
  });
});

describe("create: duplicates and products (criteria 2, 3)", () => {
  test("second review by the same owner on the same product -> DUPLICATE, nothing changes", () => {
    const { db, service } = setup();
    const first = unwrap(service.create(S1, input({ rating: 5, title: "First" })));
    const before = stored(db, "p1");
    const e = errorOf(service.create(S1, input({ rating: 1, title: "Second" })));
    expect(e.code).toBe("DUPLICATE");
    expect(stored(db, "p1")).toEqual(before);
    expect(service.listMine(S1)).toEqual([first]);
  });

  test("same owner on a different product, and another owner on the same product succeed", () => {
    const { service } = setup();
    unwrap(service.create(S1, input({ productId: "p1" })));
    unwrap(service.create(S1, input({ productId: "p2" })));
    unwrap(service.create(S2, input({ productId: "p1" })));
    expect(service.listMine(S1)).toHaveLength(2);
  });

  test("unknown product -> PRODUCT_NOT_FOUND, nothing written", () => {
    const { db, service } = setup();
    for (const productId of ["missing", "", "x".repeat(500)]) {
      expect(errorOf(service.create(S1, input({ productId }))).code).toBe("PRODUCT_NOT_FOUND");
    }
    expect(errorOf(service.create(S1, input({ productId: 42 as unknown as string }))).code).toBe("PRODUCT_NOT_FOUND");
    expect(reviewCount(db)).toBe(0);
  });

  test("a failure inside the transaction rolls back the insert and the aggregates", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    db.query("INSERT INTO products (id, slug, name, price_cents, currency, image_url, stock) VALUES ('p1','s','n',1,'USD','/x',1)").run();
    let calls = 0;
    const service = createReviewService({
      db,
      idGenerator: () => {
        calls++;
        return "fixed-id";
      },
    });
    unwrap(service.create(S1, input()));
    // Same id for a different owner: PK violation thrown from inside the transaction.
    expect(() => service.create(S2, input())).toThrow();
    expect(calls).toBe(2);
    expect(reviewCount(db)).toBe(1);
    expect(stored(db, "p1")).toEqual({ c: 1, s: 5 });
  });
});

describe("create: verified purchase (criterion 4)", () => {
  test("true only with a paid, non-cancelled order containing the product", () => {
    const { db, service } = setup(["p1", "p2", "p3", "p4", "p5"]);
    insertOrder(db, S1, "p1", "paid", "processing");
    insertOrder(db, S1, "p2", "payment_failed");
    insertOrder(db, S1, "p3", "paid", "cancelled");
    insertOrder(db, S2, "p4", "paid", "delivered"); // someone else's order
    insertOrder(db, S1, "p5", "paid", "delivered");
    const verified = (productId: string) => unwrap(service.create(S1, input({ productId }))).verifiedPurchase;
    expect(verified("p1")).toBe(true);
    expect(verified("p2")).toBe(false);
    expect(verified("p3")).toBe(false);
    expect(verified("p4")).toBe(false);
    expect(verified("p5")).toBe(true);
  });

  test("cannot be set from input", () => {
    const { service } = setup();
    const sneaky = { ...input(), verifiedPurchase: true, verified_purchase: 1, helpfulCount: 99, status: "hidden" };
    const r = unwrap(service.create(S1, sneaky));
    expect(r.verifiedPurchase).toBe(false);
    expect(r.helpfulCount).toBe(0);
    expect(r.status).toBe("published");
  });
});

describe("aggregates (criterion 5)", () => {
  test("property: after each of 20 random inserts, stored aggregates equal a fresh aggregate and histogram sums to count", () => {
    const { db, service } = setup(["p1", "p2", "p3"]);
    let seed = 1234567;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 20; i++) {
      const productId = ["p1", "p2", "p3"][Math.floor(rand() * 3)] as string;
      const rating = 1 + Math.floor(rand() * 5);
      unwrap(service.create(uuid(i + 1), input({ productId, rating })));
      for (const p of ["p1", "p2", "p3"]) {
        expect(stored(db, p)).toEqual(fresh(db, p));
        const s = service.summary(p);
        const histSum = Object.values(s.histogram).reduce((a, b) => a + b, 0);
        expect(histSum).toBe(s.count);
        expect(s.count).toBe(fresh(db, p).c);
      }
    }
  });

  test("drifted aggregates are repaired on the next create (safety net)", () => {
    const { db, service } = setup();
    unwrap(service.create(S1, input({ rating: 4 })));
    db.query("UPDATE products SET rating_count = 40, rating_sum = 7 WHERE id = 'p1'").run();
    unwrap(service.create(S2, input({ rating: 2 })));
    expect(stored(db, "p1")).toEqual({ c: 2, s: 6 });
  });

  test("seeded catalogue: aggregates match, hidden reviews excluded from summary", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db);
    const service = createReviewService({ db });
    const products = db.query("SELECT id FROM products").all() as { id: string }[];
    for (const { id } of products) {
      const s = service.summary(id);
      const f = fresh(db, id);
      expect(s.count).toBe(f.c);
      expect(stored(db, id)).toEqual(f);
      expect(Object.values(s.histogram).reduce((a, b) => a + b, 0)).toBe(s.count);
    }
  });

  test("summary: avg rounded to one decimal; zeros for unknown product or no reviews", () => {
    const { service } = setup();
    const zeros = { count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
    expect(service.summary("p1")).toEqual(zeros);
    expect(service.summary("nope")).toEqual(zeros);
    expect(service.summary("")).toEqual(zeros);
    unwrap(service.create(S1, input({ rating: 5 })));
    unwrap(service.create(S2, input({ rating: 4 })));
    unwrap(service.create(S3, input({ rating: 4 })));
    expect(service.summary("p1")).toEqual({ count: 3, avg: 4.3, histogram: { 1: 0, 2: 0, 3: 0, 4: 2, 5: 1 } });
  });
});

describe("voteHelpful (criterion 6)", () => {
  test("votes once; second vote -> DUPLICATE with count unchanged", () => {
    const { db, service } = setup();
    const r = unwrap(service.create(S1, input()));
    expect(unwrap(service.voteHelpful(S2, r.id))).toEqual({ helpfulCount: 1 });
    expect(errorOf(service.voteHelpful(S2, r.id)).code).toBe("DUPLICATE");
    expect(unwrap(service.voteHelpful(S3, r.id))).toEqual({ helpfulCount: 2 });
    expect((db.query("SELECT COUNT(*) AS n FROM review_votes").get() as { n: number }).n).toBe(2);
  });

  test("own review -> FORBIDDEN", () => {
    const { db, service } = setup();
    const r = unwrap(service.create(S1, input()));
    expect(errorOf(service.voteHelpful(S1, r.id)).code).toBe("FORBIDDEN");
    expect((db.query("SELECT helpful_count AS h FROM reviews").get() as { h: number }).h).toBe(0);
  });

  test("unknown or hidden review -> NOT_FOUND; invalid owner key -> INVALID_INPUT", () => {
    const { db, service } = setup();
    const r = unwrap(service.create(S1, input()));
    expect(errorOf(service.voteHelpful(S2, "nope")).code).toBe("NOT_FOUND");
    expect(errorOf(service.voteHelpful(S2, "")).code).toBe("NOT_FOUND");
    expect(errorOf(service.voteHelpful(S2, "x".repeat(1000))).code).toBe("NOT_FOUND");
    expect(errorOf(service.voteHelpful("bad", r.id)).code).toBe("INVALID_INPUT");
    db.query("UPDATE reviews SET status = 'hidden' WHERE id = ?").run(r.id);
    expect(errorOf(service.voteHelpful(S2, r.id)).code).toBe("NOT_FOUND");
  });

  test("concurrent Promise.all double vote counts once", async () => {
    const { db, service } = setup();
    const r = unwrap(service.create(S1, input()));
    const results = await Promise.all([
      Promise.resolve().then(() => service.voteHelpful(S2, r.id)),
      Promise.resolve().then(() => service.voteHelpful(S2, r.id)),
    ]);
    expect(results.filter((x) => x.ok)).toHaveLength(1);
    expect(results.filter((x) => !x.ok).map((x) => errorOf(x).code)).toEqual(["DUPLICATE"]);
    expect((db.query("SELECT helpful_count AS h FROM reviews WHERE id = ?").get(r.id) as { h: number }).h).toBe(1);
  });

  test("a second service on the same connection sees the existing vote", () => {
    const { db, service } = setup();
    const r = unwrap(service.create(S1, input()));
    const other = createReviewService({ db });
    unwrap(service.voteHelpful(S2, r.id));
    expect(errorOf(other.voteHelpful(S2, r.id)).code).toBe("DUPLICATE");
  });
});

function listOk(service: ReviewService, ...args: Parameters<ReviewService["list"]>): ReviewListResult {
  return unwrap(service.list(...args));
}

describe("list (criterion 7)", () => {
  function populated() {
    const ctx = setup();
    const { service, db } = ctx;
    // r1 oldest ... r5 newest; ratings 5,4,4,2,1; S-keys uuid(1..5)
    const reviews: Review[] = [5, 4, 4, 2, 1].map((rating, i) => unwrap(service.create(uuid(i + 1), input({ rating, title: `R${i + 1}` }))));
    // helpful: R2 gets 2 votes, R4 gets 2 votes, R1 gets 1
    const votes: [number, number][] = [[1, 10], [1, 11], [3, 10], [3, 11], [0, 10]];
    for (const [idx, voter] of votes) unwrap(service.voteHelpful(uuid(voter), (reviews[idx] as Review).id));
    return { ...ctx, reviews, db };
  }

  test("default sort helpful: helpful_count desc then most recent first", () => {
    const { service } = populated();
    const titles = listOk(service, "p1").items.map((r) => r.title);
    expect(titles).toEqual(["R4", "R2", "R1", "R5", "R3"]);
    expect(listOk(service, "p1", { sort: "garbage" }).items.map((r) => r.title)).toEqual(titles);
  });

  test("sort recent: newest first", () => {
    const { service } = populated();
    expect(listOk(service, "p1", { sort: "recent" }).items.map((r) => r.title)).toEqual(["R5", "R4", "R3", "R2", "R1"]);
  });

  test("star filter returns only that rating; total reflects the filter; summary does not", () => {
    const { service } = populated();
    const res = listOk(service, "p1", { stars: 4 });
    expect(res.items.map((r) => r.rating)).toEqual([4, 4]);
    expect(res.total).toBe(2);
    expect(res.summary.count).toBe(5);
    expect(listOk(service, "p1", { stars: 3 }).items).toEqual([]);
    // invalid star values are ignored
    expect(listOk(service, "p1", { stars: 9 as 5 }).total).toBe(5);
  });

  test("verifiedOnly filter", () => {
    const { db } = setup();
    insertOrder(db, S1, "p1");
    const service = createReviewService({ db });
    unwrap(service.create(S1, input()));
    unwrap(service.create(S2, input()));
    const res = listOk(service, "p1", { verifiedOnly: true });
    expect(res.total).toBe(1);
    expect(res.items.every((r) => r.verifiedPurchase)).toBe(true);
  });

  test("pagination: sizes, clamps, page past end empty", () => {
    const { service } = populated();
    const p1 = listOk(service, "p1", { sort: "recent", pageSize: 2, page: 1 });
    expect(p1).toMatchObject({ total: 5, page: 1, pageCount: 3 });
    expect(p1.items.map((r) => r.title)).toEqual(["R5", "R4"]);
    expect(listOk(service, "p1", { sort: "recent", pageSize: 2, page: 3 }).items.map((r) => r.title)).toEqual(["R1"]);
    const past = listOk(service, "p1", { pageSize: 2, page: 4 });
    expect(past).toMatchObject({ items: [], total: 5, page: 4, pageCount: 3 });
    expect(listOk(service, "p1", { page: Number.MAX_SAFE_INTEGER }).items).toEqual([]);
    expect(listOk(service, "p1", { page: 0 }).page).toBe(1);
    expect(listOk(service, "p1", { page: Number.NaN }).page).toBe(1);
    expect(listOk(service, "p1", { pageSize: 0 }).items).toHaveLength(1);
    expect(listOk(service, "p1", { pageSize: 500 }).pageCount).toBe(1);
    expect(listOk(service, "p1", { pageSize: 2.9 }).items).toHaveLength(2);
    expect(listOk(service, "p1").pageCount).toBe(1);
  });

  test("no reviews: empty items, pageCount 0, zero summary", () => {
    const { service } = setup();
    expect(listOk(service, "p2")).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageCount: 0,
      summary: { count: 0, avg: 0, histogram: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
    });
  });

  test("unknown product -> PRODUCT_NOT_FOUND", () => {
    const { service } = setup();
    expect(errorOf(service.list("nope")).code).toBe("PRODUCT_NOT_FOUND");
    expect(errorOf(service.list("")).code).toBe("PRODUCT_NOT_FOUND");
  });

  test("viewer flags: isOwn and votedByViewer only with a valid viewer; author key never exposed", () => {
    const { service, reviews } = populated();
    const anon = listOk(service, "p1");
    expect(anon.items.every((r) => !("isOwn" in r) && !("votedByViewer" in r))).toBe(true);
    expect(listOk(service, "p1", {}, "not-a-uuid").items.every((r) => !("isOwn" in r))).toBe(true);
    const asAuthor = listOk(service, "p1", {}, uuid(1)).items;
    expect(asAuthor.filter((r) => r.isOwn).map((r) => r.id)).toEqual([(reviews[0] as Review).id]);
    const asVoter = listOk(service, "p1", {}, uuid(10)).items;
    expect(asVoter.filter((r) => r.votedByViewer).map((r) => r.title).sort()).toEqual(["R1", "R2", "R4"]);
    expect(asVoter.every((r) => r.isOwn === false)).toBe(true);
    const json = JSON.stringify([anon, asAuthor, asVoter]);
    for (let i = 1; i <= 5; i++) expect(json).not.toContain(uuid(i));
    expect(json).not.toContain("session");
  });

  test("hidden reviews are never listed, filtered, counted or summarised (seed data)", () => {
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db);
    const service = createReviewService({ db });
    for (const hiddenId of HIDDEN_REVIEW_IDS) {
      const row = db.query("SELECT product_id AS p, rating AS r FROM reviews WHERE id = ? AND status = 'hidden'").get(hiddenId) as
        | { p: string; r: 1 | 2 | 3 | 4 | 5 }
        | null;
      expect(row).not.toBeNull();
      if (row === null) continue;
      for (const sort of ["helpful", "recent"] as const) {
        for (const q of [{ sort }, { sort, stars: row.r }, { sort, verifiedOnly: true }]) {
          const res = listOk(service, row.p, { ...q, pageSize: 20 });
          const all: string[] = [];
          for (let page = 1; page <= Math.max(1, res.pageCount); page++) {
            all.push(...listOk(service, row.p, { ...q, pageSize: 20, page }).items.map((r) => r.id));
          }
          expect(all).not.toContain(hiddenId);
          expect(all).toHaveLength(res.total);
        }
      }
      expect(service.summary(row.p).count).toBe(fresh(db, row.p).c);
      expect(errorOf(service.voteHelpful(S1, hiddenId)).code).toBe("NOT_FOUND");
    }
  });
});

describe("hostile text (criterion 8)", () => {
  test("<img src=x onerror=1> is stored and returned verbatim as text", () => {
    const { db, service } = setup();
    const hostile = "<img src=x onerror=1>";
    const r = unwrap(
      service.create(S1, input({ title: hostile, body: `${hostile} <script>alert(1)</script> &amp;`, displayName: hostile })),
    );
    expect(r.title).toBe(hostile);
    expect(r.body).toBe(`${hostile} <script>alert(1)</script> &amp;`);
    expect(r.displayName).toBe(hostile);
    expect(db.query("SELECT title FROM reviews").get()).toEqual({ title: hostile });
    const listed = listOk(service, "p1").items[0];
    expect(listed?.title).toBe(hostile);
    expect(service.listMine(S1)[0]?.body).toContain("<script>");
  });

  test("SQL metacharacters are just text", () => {
    const { db, service } = setup();
    const r = unwrap(service.create(S1, input({ title: "'); DROP TABLE reviews; --" })));
    expect(r.title).toBe("'); DROP TABLE reviews; --");
    expect(reviewCount(db)).toBe(1);
  });
});

describe("listMine / hasReviewed", () => {
  test("listMine returns the owner's reviews newest first, including hidden; others' never", () => {
    const { db, service } = setup(["p1", "p2", "p3"]);
    const a = unwrap(service.create(S1, input({ productId: "p1" })));
    unwrap(service.create(S2, input({ productId: "p1" })));
    const b = unwrap(service.create(S1, input({ productId: "p2" })));
    db.query("UPDATE reviews SET status = 'hidden' WHERE id = ?").run(a.id);
    expect(service.listMine(S1).map((r) => [r.id, r.status])).toEqual([
      [b.id, "published"],
      [a.id, "hidden"],
    ]);
    expect(service.listMine(S3)).toEqual([]);
    expect(service.listMine("bad")).toEqual([]);
  });

  test("hasReviewed", () => {
    const { service } = setup();
    unwrap(service.create(S1, input()));
    expect(service.hasReviewed(S1, "p1")).toBe(true);
    expect(service.hasReviewed(S1, "p2")).toBe(false);
    expect(service.hasReviewed(S2, "p1")).toBe(false);
    expect(service.hasReviewed("bad", "p1")).toBe(false);
    expect(service.hasReviewed(S1, "")).toBe(false);
  });
});

describe("getReviewService", () => {
  test("returns a cached singleton over getDatabase()", async () => {
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = ":memory:";
    const { closeDatabase } = await import("@/server/db/client");
    const { getReviewService } = await import("./review-service");
    try {
      closeDatabase();
      const a = getReviewService();
      expect(getReviewService()).toBe(a);
      expect(a.summary("anything").count).toBe(0);
      closeDatabase();
      expect(getReviewService()).not.toBe(a);
    } finally {
      closeDatabase();
      if (previous === undefined) delete process.env.DATABASE_PATH;
      else process.env.DATABASE_PATH = previous;
    }
  });
});
