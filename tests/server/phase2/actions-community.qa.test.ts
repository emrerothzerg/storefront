import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// QA-W2-T46-T47 (part 1 of 2): review server actions (T46).
//
// Part A drives `createReviewActions` (reviews-core) with the REAL review
// service + REAL T31 limiter over in-memory SQLite and recording fakes for
// the session / current-user helpers, so call ORDER can be asserted.
// Part B drives the `'use server'` wrappers (`src/app/actions/reviews.ts`)
// with `next/headers` + `next/cache` mocked and a REAL signed-in user created
// through `createAuthService` (fast hasher) whose `sf_auth` token sits in the
// mocked cookie store.
// Q&A actions (T47) live in actions-community-qa.qa.test.ts.
// No test touches ./data: DATABASE_PATH=":memory:" or createDatabase(":memory:").
// ---------------------------------------------------------------------------

interface SetCall {
  readonly name: string;
  readonly value: string;
  readonly options: unknown;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string, options?: unknown): void {
    this.setCalls.push({ name, value, options });
    this.jar.set(name, value);
  }
  delete(name: string): void {
    this.jar.delete(name);
  }
}

let fakeStore = new FakeCookieStore();
const wiredRevalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath: wiredRevalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
type ReviewActionState = import("@/components/molecules/_contracts/review-actions").ReviewActionState;
type VoteActionState = import("@/components/molecules/_contracts/review-actions").VoteActionState;
const core = await import("@/app/actions/reviews-core");
const { createReviewActions, REVIEW_MESSAGES } = core;
type ReviewActionDeps = import("@/app/actions/reviews-core").ReviewActionDeps;
const { createReviewService } = await import("@/server/reviews/review-service");
type ReviewService = import("@/server/reviews/review-service").ReviewService;
const { createRateLimiter, limitAction } = await import("@/server/security/rate-limiter");
type RateLimiter = import("@/server/security/rate-limiter").RateLimiter;
const { createDatabase, closeDatabase, getDatabase } = await import("@/server/db/client");
const { runMigrations } = await import("@/server/db/schema");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME, AUTH_COOKIE_NAME } = await import("@/server/session/session");
const { createAuthService } = await import("@/server/auth/auth-service");

const ROOT = join(import.meta.dir, "..", "..", "..");
const wired = await import("@/app/actions/reviews");

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const S3 = "33333333-3333-4333-a333-333333333333";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const TOTE = "prod_canvas-tote-bag";
const TOTE_SLUG = "canvas-tote-bag";
const PUBLISHED_REVIEW = "rev_seed_001_02"; // on TOTE, by seed_session_02
const HIDDEN_REVIEW = "rev_seed_001_01";
const SECRET = "qa-secret-pii-jane@example.com";

type Entry = readonly [string, string | Blob];

function fd(entries: readonly Entry[]): FormData {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
}

function validReview(productId: string = TOTE, extra: readonly Entry[] = []): FormData {
  return fd([
    ["productId", productId],
    ["productSlug", TOTE_SLUG],
    ["rating", "4"],
    ["title", "Solid everyday bag"],
    ["body", "Holds a laptop and groceries without complaint."],
    ["displayName", "Guest Gina"],
    ...extra,
  ]);
}

/** FormData Proxy that records every key passed to get/getAll/has and any iteration. */
function spyFormData(entries: readonly Entry[]): { form: FormData; reads: string[] } {
  const target = fd(entries);
  const reads: string[] = [];
  const form = new Proxy(target, {
    get(t, prop) {
      const value: unknown = Reflect.get(t, prop, t);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        reads.push(`${String(prop)}:${args.map(String).join(",")}`);
        return (value as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return { form, reads };
}

async function browserMultipart(fields: readonly (readonly [string, string])[], boundary: string): Promise<FormData> {
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  const request = new Request(`http://localhost:3000/products/${TOTE_SLUG}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}`, origin: "http://localhost:3000" },
    body,
  });
  return request.formData();
}

interface ReviewRow {
  id: string;
  product_id: string;
  session_id: string;
  display_name: string;
  rating: number;
  title: string;
  body: string;
  verified_purchase: number;
  helpful_count: number;
  status: string;
}

function reviewRows(db: Database, where = "1 = 1"): ReviewRow[] {
  return db
    .query(`SELECT id, product_id, session_id, display_name, rating, title, body, verified_purchase, helpful_count, status FROM reviews WHERE ${where} ORDER BY rowid`)
    .all() as ReviewRow[];
}

function newRows(db: Database): ReviewRow[] {
  return reviewRows(db, "id NOT LIKE 'rev_seed_%'");
}

function productIds(db: Database, n: number): string[] {
  return (db.query("SELECT id FROM products ORDER BY id LIMIT ?").all(n) as { id: string }[]).map((r) => r.id);
}

type ReviewErr = Extract<NonNullable<ReviewActionState>, { ok: false }>;
type VoteErr = Extract<NonNullable<VoteActionState>, { ok: false }>;

function errOf(state: ReviewActionState): ReviewErr {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  expect(state.message).toBe(state.error.message);
  return state;
}

function voteErrOf(state: VoteActionState): VoteErr {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  expect(state.message).toBe(state.error.message);
  return state;
}

interface Harness {
  db: Database;
  calls: string[];
  session: { current: string | null; next: string; minted: number };
  user: { current: { displayName: string } | null };
  clock: { ms: number };
  revalidate: ReturnType<typeof mock<(path: string, type?: "page" | "layout") => void>>;
  logger: { error: ReturnType<typeof mock<(...args: unknown[]) => void>> };
  limiter: RateLimiter;
  actions: ReturnType<typeof createReviewActions>;
}

function setup(overrides: Partial<ReviewActionDeps> = {}, db?: Database): Harness {
  const database = db ?? createDatabase(":memory:");
  if (db === undefined) {
    runMigrations(database);
    seedDatabase(database);
  }
  const calls: string[] = [];
  const session = { current: null as string | null, next: S1, minted: 0 };
  const user = { current: null as { displayName: string } | null };
  const clock = { ms: T0 };
  const real = createReviewService({ db: database, now: () => clock.ms });
  const service: ReviewService = {
    ...real,
    create: (s, input, now) => {
      calls.push("service.create");
      return real.create(s, input, now);
    },
    voteHelpful: (s, id) => {
      calls.push("service.voteHelpful");
      return real.voteHelpful(s, id);
    },
  };
  const realLimiter = createRateLimiter(database, { now: () => clock.ms });
  const limiter: RateLimiter = {
    check: (key, rule) => {
      calls.push(`limiter:${key.replace(/:[0-9a-f-]{36}$/, ":<sid>")}`);
      return realLimiter.check(key, rule);
    },
  };
  const revalidate = mock<(path: string, type?: "page" | "layout") => void>((path) => {
    calls.push(`revalidate:${path}`);
  });
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const deps: ReviewActionDeps = {
    service,
    limiter,
    getOrCreateSessionId: async () => {
      calls.push("getOrCreateSessionId");
      if (session.current === null) {
        session.current = session.next;
        session.minted += 1;
      }
      return session.current;
    },
    readCurrentUser: async () => {
      calls.push("readCurrentUser");
      return user.current;
    },
    revalidatePath: revalidate,
    now: () => clock.ms,
    logger,
    ...overrides,
  };
  return { db: database, calls, session, user, clock, revalidate, logger, limiter: realLimiter, actions: createReviewActions(deps) };
}

function sessionAndLimiterUntouched(h: Harness): void {
  expect(h.calls.filter((c) => c === "getOrCreateSessionId" || c.startsWith("limiter:") || c.startsWith("service."))).toEqual([]);
  expect(h.session.minted).toBe(0);
  expect(h.revalidate).not.toHaveBeenCalled();
}

// ---------------------------------------------------------------------------
// Part A: core
// ---------------------------------------------------------------------------

describe("QA T46 order of steps", () => {
  test("submit: parse -> readCurrentUser -> session -> per-session limiter -> global limiter -> service -> revalidate", async () => {
    const h = setup();
    const state = await h.actions.submitReview(null, validReview());
    expect(state).toMatchObject({ ok: true, kind: "created", message: REVIEW_MESSAGES.created });
    expect(h.calls).toEqual([
      "readCurrentUser",
      "getOrCreateSessionId",
      "limiter:review.submit:<sid>",
      "limiter:review.submit:*",
      "service.create",
      `revalidate:/products/${TOTE_SLUG}`,
    ]);
  });

  test("vote: session -> limiter (vote) -> service -> revalidate; never reads the current user", async () => {
    const h = setup();
    const state = await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW], ["productSlug", TOTE_SLUG]]));
    expect(state).toMatchObject({ ok: true, helpfulCount: expect.any(Number) });
    expect(h.calls).toEqual([
      "getOrCreateSessionId",
      "limiter:vote:<sid>",
      "limiter:vote:*",
      "service.voteHelpful",
      `revalidate:/products/${TOTE_SLUG}`,
    ]);
  });
});

describe("QA T46 criterion 1: invalid input -> field errors, no session, no token, no row", () => {
  const cases: readonly (readonly [string, readonly Entry[], string])[] = [
    ["empty form", [], "rating"],
    ["rating 0", [["productId", TOTE], ["rating", "0"], ["title", "ok title"], ["body", "ok body"]], "rating"],
    ["rating 6", [["productId", TOTE], ["rating", "6"], ["title", "ok title"], ["body", "ok body"]], "rating"],
    ["rating 4.5", [["productId", TOTE], ["rating", "4.5"], ["title", "ok title"], ["body", "ok body"]], "rating"],
    ["rating 'four'", [["productId", TOTE], ["rating", "four"], ["title", "ok title"], ["body", "ok body"]], "rating"],
    ["blank title", [["productId", TOTE], ["rating", "3"], ["title", "  ​ \t"], ["body", "ok body"]], "title"],
    ["missing body", [["productId", TOTE], ["rating", "3"], ["title", "ok title"]], "body"],
    ["title 101", [["productId", TOTE], ["rating", "3"], ["title", "t".repeat(101)], ["body", "ok body"]], "title"],
    ["body 2001", [["productId", TOTE], ["rating", "3"], ["title", "ok"], ["body", "b".repeat(2001)]], "body"],
    ["name 51", [["productId", TOTE], ["rating", "3"], ["title", "ok"], ["body", "ok"], ["displayName", "n".repeat(51)]], "displayName"],
    ["3 links", [["productId", TOTE], ["rating", "3"], ["title", "ok"], ["body", "see https://a.example/x https://b.example/y https://c.example/z"]], "body"],
    ["File as title", [["productId", TOTE], ["rating", "3"], ["title", new Blob(["x"])], ["body", "ok"]], "title"],
  ];
  for (const [name, entries, field] of cases) {
    test(name, async () => {
      const h = setup();
      const err = errOf(await h.actions.submitReview(null, fd(entries)));
      expect(["VALIDATION_FAILED", "TOO_LONG"]).toContain(err.error.code);
      expect(typeof err.fieldErrors[field as "rating"]).toBe("string");
      sessionAndLimiterUntouched(h);
      expect(newRows(h.db)).toEqual([]);
    });
  }

  test("missing / blank / oversize / File productId -> VALIDATION_FAILED fields.productId=REQUIRED, generic message, no fieldErrors entry", async () => {
    for (const bad of [undefined, "", "   ", "p".repeat(201), "p".repeat(5000), new Blob(["prod"])]) {
      const h = setup();
      const entries: Entry[] = [["rating", "4"], ["title", "Fine"], ["body", "Fine body"]];
      if (bad !== undefined) entries.push(["productId", bad]);
      const err = errOf(await h.actions.submitReview(null, fd(entries)));
      expect(err.error.code).toBe("VALIDATION_FAILED");
      expect(err.error.details).toEqual({ fields: { productId: "REQUIRED" } });
      expect(err.message).toBe(REVIEW_MESSAGES.invalidRequest);
      expect(err.fieldErrors).toEqual({});
      sessionAndLimiterUntouched(h);
    }
  });

  test("unknown (well-formed) productId -> PRODUCT_NOT_FOUND, no row, no revalidate", async () => {
    const h = setup();
    const err = errOf(await h.actions.submitReview(null, validReview("prod_does-not-exist")));
    expect(err.error).toEqual({ code: "PRODUCT_NOT_FOUND", message: REVIEW_MESSAGES.productNotFound });
    expect(newRows(h.db)).toEqual([]);
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("all-TOO_LONG -> code TOO_LONG; mixed -> VALIDATION_FAILED; details.fields carries codes only", async () => {
    const h = setup();
    const a = errOf(await h.actions.submitReview(null, fd([["productId", TOTE], ["rating", "2"], ["title", "t".repeat(101)], ["body", "b".repeat(2001)]])));
    expect(a.error.code).toBe("TOO_LONG");
    expect(a.error.details).toEqual({ fields: { title: "TOO_LONG", body: "TOO_LONG" } });
    const b = errOf(await h.actions.submitReview(null, fd([["productId", TOTE], ["title", "t".repeat(101)], ["body", "ok"]])));
    expect(b.error.code).toBe("VALIDATION_FAILED");
    expect(b.error.details).toEqual({ fields: { rating: "REQUIRED", title: "TOO_LONG" } });
  });

  test("vote: missing/blank/oversize/File reviewId -> INVALID_INPUT, no session, no token", async () => {
    for (const bad of [undefined, "", "  ", "r".repeat(201), "r".repeat(1_000_000), new Blob(["r"])]) {
      const h = setup();
      const entries: Entry[] = bad === undefined ? [] : [["reviewId", bad]];
      const err = voteErrOf(await h.actions.voteReviewHelpful(null, fd(entries)));
      expect(err.error).toEqual({ code: "INVALID_INPUT", message: REVIEW_MESSAGES.invalidRequest, details: { field: "reviewId" } });
      sessionAndLimiterUntouched(h);
    }
  });
});

describe("QA T46 criterion 2: rate limits", () => {
  test("6th review in an hour from one owner key: RATE_LIMITED with retryAfterSeconds, service NOT called; next hour admits", async () => {
    const h = setup();
    const ids = productIds(h.db, 7);
    for (let i = 0; i < 5; i++) {
      expect((await h.actions.submitReview(null, validReview(ids[i])))?.ok).toBe(true);
    }
    h.calls.length = 0;
    h.revalidate.mockClear();
    h.clock.ms += 59 * 60_000;
    const err = errOf(await h.actions.submitReview(null, validReview(ids[5])));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(err.error.details).toEqual({ retryAfterSeconds: err.retryAfterSeconds });
    expect(err.message).toMatch(/^You have posted several reviews recently\. Please try again in \d+ minutes?\.$/);
    expect(err.fieldErrors).toEqual({});
    expect(err.values).toEqual({ rating: "4", title: "Solid everyday bag", body: "Holds a laptop and groceries without complaint.", displayName: "Guest Gina" });
    expect(h.calls).not.toContain("service.create");
    expect(h.revalidate).not.toHaveBeenCalled();
    expect(newRows(h.db)).toHaveLength(5);
    h.clock.ms = T0 + HOUR_MS;
    expect((await h.actions.submitReview(null, validReview(ids[6])))?.ok).toBe(true);
  });

  test("invalid submits do not spend budget: 20 invalid then 5 valid all succeed", async () => {
    const h = setup();
    const ids = productIds(h.db, 5);
    for (let i = 0; i < 20; i++) await h.actions.submitReview(null, fd([["productId", TOTE], ["rating", "9"]]));
    for (const id of ids) expect((await h.actions.submitReview(null, validReview(id)))?.ok).toBe(true);
  });

  test("DUPLICATE and PRODUCT_NOT_FOUND submits DO spend budget (limiter runs before service)", async () => {
    const h = setup();
    await h.actions.submitReview(null, validReview());
    for (let i = 0; i < 4; i++) await h.actions.submitReview(null, validReview());
    expect(errOf(await h.actions.submitReview(null, validReview(productIds(h.db, 1)[0]))).error.code).toBe("RATE_LIMITED");
  });

  test("global backstop: 300 real reviews across 60 owner keys, 301st from a fresh key is RATE_LIMITED and the service is not called", async () => {
    const h = setup();
    const ids = productIds(h.db, 5);
    for (let s = 0; s < 60; s++) {
      h.session.current = `${String(s).padStart(8, "0")}-0000-4000-8000-000000000000`;
      for (const id of ids) {
        const state = await h.actions.submitReview(null, validReview(id));
        if (state === null || !state.ok) throw new Error(`unexpected at session ${s}: ${JSON.stringify(state)}`);
      }
    }
    expect(newRows(h.db)).toHaveLength(300);
    h.session.current = S3;
    h.calls.length = 0;
    const err = errOf(await h.actions.submitReview(null, validReview(ids[0])));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.calls).toEqual(["readCurrentUser", "getOrCreateSessionId", "limiter:review.submit:<sid>", "limiter:review.submit:*"]);
    expect(newRows(h.db)).toHaveLength(300);
  });

  test("61st vote in an hour: RATE_LIMITED + retryAfterSeconds, service not called", async () => {
    const h = setup();
    for (let i = 0; i < 60; i++) await h.actions.voteReviewHelpful(null, fd([["reviewId", `nope-${i}`]]));
    h.calls.length = 0;
    const err = voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.message).toMatch(/^You have voted many times recently\. Please try again in \d+ minutes?\.$/);
    expect(h.calls).not.toContain("service.voteHelpful");
    expect(reviewRows(h.db, `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count).toBe(reviewRows(createSeeded(), `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count);
  });

  test("vote global backstop (3000/h) trips for a brand-new owner key; service not called", async () => {
    const h = setup();
    for (let i = 0; i < 3000; i++) limitAction(h.limiter, "vote", `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`);
    h.session.current = S3;
    h.calls.length = 0;
    const err = voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(h.calls).toEqual(["getOrCreateSessionId", "limiter:vote:<sid>", "limiter:vote:*"]);
  });

  test("limiter returning RATE_LIMITED without retryAfterSeconds: fallback message, no retryAfterSeconds key", async () => {
    const h = setup({
      limiter: { check: () => ({ ok: false, error: { code: "RATE_LIMITED", message: "raw internal" } }) },
    });
    const err = errOf(await h.actions.submitReview(null, validReview()));
    expect(err.message).toBe(REVIEW_MESSAGES.reviewRateLimitedFallback);
    expect("retryAfterSeconds" in err).toBe(false);
    const v = voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
    expect(v.message).toBe(REVIEW_MESSAGES.voteRateLimitedFallback);
    expect("retryAfterSeconds" in v).toBe(false);
  });

  test("retryAfterSeconds that is fractional is rounded up; non-positive / NaN dropped", async () => {
    for (const [raw, expected] of [[12.2, 13], [0, undefined], [-5, undefined], [Number.NaN, undefined]] as const) {
      const h = setup({
        limiter: { check: () => ({ ok: false, error: { code: "RATE_LIMITED", message: "x", details: { retryAfterSeconds: raw } } }) },
      });
      const err = errOf(await h.actions.submitReview(null, validReview()));
      expect(err.retryAfterSeconds).toBe(expected);
    }
  });
});

function createSeeded(): Database {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  return db;
}

describe("QA T46 criterion 3: forged fields ignored", () => {
  test("verified/helpfulCount/status/sessionId/isOwn/session_id never read; stored row is server-derived", async () => {
    const h = setup();
    const { form, reads } = spyFormData([
      ["productId", TOTE],
      ["productSlug", TOTE_SLUG],
      ["rating", "5"],
      ["title", "Great"],
      ["body", "Really great bag."],
      ["displayName", "Gina"],
      ["verified", "true"],
      ["verified_purchase", "1"],
      ["verifiedPurchase", "1"],
      ["helpfulCount", "999"],
      ["helpful_count", "999"],
      ["status", "hidden"],
      ["sessionId", S2],
      ["session_id", S2],
      ["isOwn", "true"],
      ["id", "rev_forged"],
    ]);
    const state = await h.actions.submitReview(null, form);
    expect(state).toMatchObject({ ok: true });
    const keys = reads.map((r) => r.split(":")[1]);
    for (const forbidden of ["verified", "verified_purchase", "verifiedPurchase", "helpfulCount", "helpful_count", "status", "sessionId", "session_id", "isOwn", "id"]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(reads.every((r) => r.startsWith("get:"))).toBe(true);
    const rows = newRows(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ session_id: S1, verified_purchase: 0, helpful_count: 0, status: "published" });
    expect(rows[0]?.id).not.toBe("rev_forged");
  });

  test("vote reads only reviewId + productSlug; forged sessionId/helpfulCount do not change who votes or the count", async () => {
    const h = setup();
    const before = reviewRows(h.db, `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count ?? -1;
    const { form, reads } = spyFormData([["reviewId", PUBLISHED_REVIEW], ["helpfulCount", "500"], ["sessionId", "seed_session_02"]]);
    const state = await h.actions.voteReviewHelpful(null, form);
    expect(state).toEqual({ ok: true, helpfulCount: before + 1, message: REVIEW_MESSAGES.voted });
    expect(reads.map((r) => r.split(":")[1]).sort()).toEqual(["productSlug", "reviewId"]);
    const voter = h.db.query("SELECT session_id FROM review_votes WHERE review_id = ? ORDER BY created_at DESC").all(PUBLISHED_REVIEW) as { session_id: string }[];
    expect(voter.map((v) => v.session_id)).toContain(S1);
  });
});

describe("QA T46 criterion 4: lazy session + vote counts once", () => {
  test("first submit with no session mints exactly one session; invalid submit mints none", async () => {
    const h = setup();
    await h.actions.submitReview(null, fd([["productId", TOTE]]));
    expect(h.session.minted).toBe(0);
    await h.actions.submitReview(null, validReview());
    expect(h.session.minted).toBe(1);
    expect(newRows(h.db)[0]?.session_id).toBe(S1);
  });

  test("first vote with no cookie creates the session and counts once; repeat -> DUPLICATE, count unchanged", async () => {
    const h = setup();
    const before = reviewRows(h.db, `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count ?? -1;
    const a = await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]]));
    expect(a).toEqual({ ok: true, helpfulCount: before + 1, message: REVIEW_MESSAGES.voted });
    expect(h.session.minted).toBe(1);
    const b = voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
    expect(b.error).toEqual({ code: "DUPLICATE", message: REVIEW_MESSAGES.alreadyVoted });
    expect(reviewRows(h.db, `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count).toBe(before + 1);
  });

  test("concurrent double vote (Promise.all x10, same owner key) counts once", async () => {
    const h = setup();
    h.session.current = S2;
    const before = reviewRows(h.db, `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count ?? -1;
    const states = await Promise.all(Array.from({ length: 10 }, () => h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]]))));
    expect(states.filter((s) => s?.ok === true)).toHaveLength(1);
    expect(states.filter((s) => s !== null && !s.ok && s.error.code === "DUPLICATE")).toHaveLength(9);
    expect(reviewRows(h.db, `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count).toBe(before + 1);
  });

  test("concurrent double submit (Promise.all x2, same owner key) stores once; other is DUPLICATE", async () => {
    const h = setup();
    h.session.current = S2;
    const states = await Promise.all([h.actions.submitReview(null, validReview()), h.actions.submitReview(null, validReview())]);
    expect(states.filter((s) => s?.ok === true)).toHaveLength(1);
    expect(states.map((s) => (s === null || s.ok ? "ok" : s.error.code)).sort()).toEqual(["DUPLICATE", "ok"]);
    expect(newRows(h.db)).toHaveLength(1);
  });
});

describe("QA T46 criterion 5: DUPLICATE / FORBIDDEN / NOT_FOUND messages", () => {
  test("duplicate review -> DUPLICATE 'You already reviewed this product.' (values echoed, no revalidate)", async () => {
    const h = setup();
    await h.actions.submitReview(null, validReview());
    h.revalidate.mockClear();
    const err = errOf(await h.actions.submitReview(null, validReview()));
    expect(err.error).toEqual({ code: "DUPLICATE", message: "You already reviewed this product." });
    expect(err.values.title).toBe("Solid everyday bag");
    expect(h.revalidate).not.toHaveBeenCalled();
  });

  test("own review vote -> FORBIDDEN; hidden / unknown review -> NOT_FOUND; none revalidate", async () => {
    const h = setup();
    const created = await h.actions.submitReview(null, validReview());
    if (created === null || !created.ok) throw new Error("setup");
    h.revalidate.mockClear();
    expect(voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", created.reviewId], ["productSlug", TOTE_SLUG]]))).error).toEqual({
      code: "FORBIDDEN",
      message: REVIEW_MESSAGES.ownReview,
    });
    expect(voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", HIDDEN_REVIEW], ["productSlug", TOTE_SLUG]]))).error).toEqual({
      code: "NOT_FOUND",
      message: REVIEW_MESSAGES.reviewNotFound,
    });
    expect(voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", "rev_nope"], ["productSlug", TOTE_SLUG]]))).error.code).toBe("NOT_FOUND");
    expect(h.revalidate).not.toHaveBeenCalled();
  });
});

describe("QA T46 criterion 6: echo values truncated, never ids", () => {
  test("oversize fields are echoed truncated to 100 / 2000 / 50 and rating only when 1-5", async () => {
    const h = setup();
    const err = errOf(
      await h.actions.submitReview(
        null,
        fd([
          ["productId", TOTE],
          ["rating", "7"],
          ["title", "T".repeat(5000)],
          ["body", "B".repeat(50_000)],
          ["displayName", "N".repeat(400)],
        ]),
      ),
    );
    expect(err.values.title).toBe("T".repeat(100));
    expect(err.values.body).toBe("B".repeat(2000));
    expect(err.values.displayName).toBe("N".repeat(50));
    expect("rating" in err.values).toBe(false);
    expect(Object.keys(err.values).sort()).toEqual(["body", "displayName", "title"]);
  });

  test("truncation does not leave a dangling high surrogate", async () => {
    const h = setup();
    const err = errOf(await h.actions.submitReview(null, fd([["productId", TOTE], ["title", `${"a".repeat(99)}\u{1F600}x`], ["body", ""]])));
    expect(err.values.title).toBe("a".repeat(99));
  });

  test("no state ever contains productId / reviewId / owner key", async () => {
    const h = setup();
    const states: unknown[] = [];
    states.push(await h.actions.submitReview(null, fd([["productId", "prod_secret-id"], ["rating", "x"]])));
    states.push(await h.actions.submitReview(null, validReview("prod_unknown-secret")));
    states.push(await h.actions.submitReview(null, validReview()));
    states.push(await h.actions.submitReview(null, validReview()));
    states.push(await h.actions.voteReviewHelpful(null, fd([["reviewId", "rev_secret-unknown"]])));
    const json = JSON.stringify(states.filter((s) => s !== null && typeof s === "object" && (s as { ok: boolean }).ok === false));
    for (const needle of ["prod_secret-id", "prod_unknown-secret", "rev_secret-unknown", TOTE, S1]) expect(json).not.toContain(needle);
  });
});

describe("QA T46 criterion 8: signed-in display name + duplicate per owner key", () => {
  test("signed in: stored display_name is the account name, form name ignored, not echoed, oversize form name is not an error", async () => {
    const h = setup();
    h.user.current = { displayName: "Account Alice" };
    h.session.current = S2;
    const state = await h.actions.submitReview(null, validReview(TOTE, [["displayName", "x".repeat(500)]]));
    expect(state).toMatchObject({ ok: true });
    expect(newRows(h.db)[0]).toMatchObject({ display_name: "Account Alice", session_id: S2 });
    const err = errOf(await h.actions.submitReview(null, fd([["productId", TOTE], ["title", "t".repeat(200)], ["displayName", "Impostor"]])));
    expect("displayName" in err.values).toBe(false);
    expect(JSON.stringify(err)).not.toContain("Account Alice");
    expect(JSON.stringify(err)).not.toContain("Impostor");
  });

  test("guest: chosen name kept; blank becomes 'Anonymous shopper'", async () => {
    const h = setup();
    const ids = productIds(h.db, 2);
    await h.actions.submitReview(null, validReview(ids[0], [["displayName", "ignored-second-entry"]]));
    const f = validReview(ids[1]);
    f.set("displayName", "   ");
    await h.actions.submitReview(null, f);
    expect(newRows(h.db).map((r) => r.display_name).sort()).toEqual(["Anonymous shopper", "Guest Gina"]);
  });

  test("duplicate rule is per owner key: guest S1 and signed-in owner S2 both review TOTE; each second attempt DUPLICATE", async () => {
    const h = setup();
    h.session.current = S1;
    expect((await h.actions.submitReview(null, validReview()))?.ok).toBe(true);
    h.session.current = S2;
    h.user.current = { displayName: "Account Bob" };
    expect((await h.actions.submitReview(null, validReview()))?.ok).toBe(true);
    expect(errOf(await h.actions.submitReview(null, validReview())).error.code).toBe("DUPLICATE");
    h.session.current = S1;
    h.user.current = null;
    expect(errOf(await h.actions.submitReview(null, validReview())).error.code).toBe("DUPLICATE");
    expect(newRows(h.db).map((r) => [r.session_id, r.display_name]).sort()).toEqual([
      [S1, "Guest Gina"],
      [S2, "Account Bob"],
    ]);
  });
});

describe("QA T46 revalidation", () => {
  test("only a valid productSlug is revalidated, only on success", async () => {
    for (const bad of ["", "Canvas-Tote", "../admin", "a/b", "tote bag", "x".repeat(101), "%2e%2e", "tote\n"]) {
      const h = setup();
      const f = validReview();
      f.set("productSlug", bad);
      expect((await h.actions.submitReview(null, f))?.ok).toBe(true);
      expect(h.revalidate).not.toHaveBeenCalled();
      const v = await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW], ["productSlug", bad]]));
      expect(v?.ok).toBe(true);
      expect(h.revalidate).not.toHaveBeenCalled();
    }
  });

  test("valid slug of 100 chars accepted; revalidated exactly once with the PDP path only", async () => {
    const h = setup();
    const slug = "a".repeat(100);
    const f = validReview();
    f.set("productSlug", slug);
    await h.actions.submitReview(null, f);
    expect(h.revalidate.mock.calls).toEqual([[`/products/${slug}`]]);
  });
});

describe("QA T46 criterion 7: browser multipart (SR2)", () => {
  test("multipart with $ACTION_* keys and forged fields submits and votes", async () => {
    const h = setup();
    const form = await browserMultipart(
      [
        ["$ACTION_REF_1", ""],
        ["$ACTION_1:0", '{"id":"7f00abc","bound":"$@1"}'],
        ["$ACTION_1:1", "[null]"],
        ["$ACTION_KEY", "k1234567890"],
        ["productId", TOTE],
        ["productSlug", TOTE_SLUG],
        ["rating", "5"],
        ["title", "Five stars"],
        ["body", "Line one\r\nLine two"],
        ["displayName", "Multipart Mo"],
        ["verified", "1"],
        ["status", "hidden"],
      ],
      "----WebKitFormBoundaryQaT46",
    );
    expect(await h.actions.submitReview(null, form)).toMatchObject({ ok: true, kind: "created" });
    expect(newRows(h.db)[0]).toMatchObject({ rating: 5, display_name: "Multipart Mo", verified_purchase: 0, status: "published" });
    const vote = await browserMultipart([["$ACTION_ID_abc", ""], ["reviewId", PUBLISHED_REVIEW], ["productSlug", TOTE_SLUG]], "----geckoformboundaryQaT46");
    expect(await h.actions.voteReviewHelpful(null, vote)).toMatchObject({ ok: true });
  });
});

describe("QA T46 unexpected failures settle with a PII-free log", () => {
  const throwing = (): never => {
    throw new Error(`boom ${SECRET} ${S1}`);
  };

  function assertClean(h: Harness): void {
    expect(h.logger.error).toHaveBeenCalled();
    for (const call of h.logger.error.mock.calls) {
      const line = call.map(String).join(" ");
      expect(line).toMatch(/^\[reviews\] REVIEW_ACTION_FAILED action=(submit|vote)$/);
    }
  }

  const deps: readonly (readonly [string, (h: Harness) => Partial<ReviewActionDeps>])[] = [
    ["readCurrentUser throws", () => ({ readCurrentUser: async () => throwing() })],
    ["getOrCreateSessionId throws", () => ({ getOrCreateSessionId: async () => throwing() })],
    ["limiter throws", () => ({ limiter: { check: throwing } })],
    ["revalidatePath throws", () => ({ revalidatePath: throwing })],
    ["now throws", () => ({ now: throwing })],
  ];
  for (const [name, make] of deps) {
    test(`${name}: submit settles with INVALID_INPUT/unavailable and echoes values`, async () => {
      const base = setup();
      const h = setup(make(base), base.db);
      const state = await h.actions.submitReview(null, validReview());
      if (name === "revalidatePath throws") {
        // Row may already be stored; the state must still settle.
        expect(state).not.toBeNull();
      } else {
        const err = errOf(state);
        expect(err.error).toEqual({ code: "INVALID_INPUT", message: REVIEW_MESSAGES.unavailable, details: { reason: "unavailable" } });
        // readCurrentUser runs before the echo is built (signed-in status unknown), so no echo there;
        // the real readCurrentUser never throws (current-user.ts catches everything).
        if (name !== "readCurrentUser throws") expect(err.values.title).toBe("Solid everyday bag");
      }
      assertClean(h);
      expect(JSON.stringify(state)).not.toContain(SECRET);
    });
  }

  test("service.create / voteHelpful throw: generic states, clean log", async () => {
    const base = setup();
    const svc = createReviewService({ db: base.db });
    const h = setup({ service: { ...svc, create: throwing, voteHelpful: throwing } }, base.db);
    expect(errOf(await h.actions.submitReview(null, validReview())).error.code).toBe("INVALID_INPUT");
    expect(voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]]))).error).toEqual({
      code: "INVALID_INPUT",
      message: REVIEW_MESSAGES.voteUnavailable,
      details: { reason: "unavailable" },
    });
    assertClean(h);
  });

  test("non-Error throw values settle", async () => {
    for (const value of [SECRET, undefined, null, { email: SECRET }]) {
      const h = setup({
        getOrCreateSessionId: async () => {
          throw value;
        },
      });
      expect(errOf(await h.actions.submitReview(null, validReview())).error.code).toBe("INVALID_INPUT");
      expect(voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", "r"]]))).error.code).toBe("INVALID_INPUT");
      assertClean(h);
    }
  });

  test("unknown service error code is mapped to the generic state (no raw message leaks)", async () => {
    const base = setup();
    const svc = createReviewService({ db: base.db });
    const h = setup(
      {
        service: {
          ...svc,
          create: () => ({ ok: false, error: { code: "MONEY_OVERFLOW", message: SECRET } }),
          voteHelpful: () => ({ ok: false, error: { code: "INVALID_INPUT", message: SECRET } }),
        },
      },
      base.db,
    );
    const a = errOf(await h.actions.submitReview(null, validReview()));
    const b = voteErrOf(await h.actions.voteReviewHelpful(null, fd([["reviewId", "r"]])));
    expect(JSON.stringify([a, b])).not.toContain(SECRET);
  });
});

describe("QA T46 JSON round trip", () => {
  test("every reachable state is plain JSON", async () => {
    const h = setup();
    const ids = productIds(h.db, 6);
    const states: unknown[] = [];
    states.push(await h.actions.submitReview(null, fd([])));
    states.push(await h.actions.submitReview(null, fd([["productId", TOTE], ["title", "t".repeat(101)], ["body", "b"], ["rating", "1"]])));
    states.push(await h.actions.submitReview(null, validReview("prod_none")));
    for (const id of ids.slice(0, 3)) states.push(await h.actions.submitReview(null, validReview(id)));
    states.push(await h.actions.submitReview(null, validReview(ids[0])));
    states.push(await h.actions.submitReview(null, validReview(ids[5])));
    states.push(await h.actions.voteReviewHelpful(null, fd([])));
    states.push(await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
    states.push(await h.actions.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
    states.push(await h.actions.voteReviewHelpful(null, fd([["reviewId", HIDDEN_REVIEW]])));
    for (const s of states) expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    const codes = states.map((s) => {
      const st = s as { ok: boolean; error?: { code: string } };
      return st.ok ? "ok" : st.error?.code;
    });
    for (const c of ["VALIDATION_FAILED", "TOO_LONG", "PRODUCT_NOT_FOUND", "ok", "DUPLICATE", "RATE_LIMITED", "INVALID_INPUT", "NOT_FOUND"]) expect(codes).toContain(c);
  });
});

// ---------------------------------------------------------------------------
// Part B: 'use server' wrapper (real session, real auth, real services)
// ---------------------------------------------------------------------------

const fastHasher = {
  hash: async (p: string): Promise<string> => `qa-fast$${p}`,
  verify: async (p: string, hash: string): Promise<boolean> => hash === `qa-fast$${p}`,
};

async function signUpUser(email: string, displayName: string): Promise<string> {
  const auth = createAuthService({ db: getDatabase(), hasher: fastHasher });
  const result = await auth.signUp({ email, password: "correct horse battery qa 9", displayName }, { sessionKey: null });
  if (!result.ok) throw new Error(`signUp failed: ${result.error.code}`);
  return result.value.token;
}

function wiredNewRows(): ReviewRow[] {
  return newRows(getDatabase());
}

function ownerKeyOf(email: string): string {
  const row = getDatabase().query("SELECT owner_key FROM users WHERE email = ?").get(email) as { owner_key: string } | null;
  if (row === null) throw new Error("no user");
  return row.owner_key;
}

describe("QA T46 'use server' module", () => {
  test("starts with 'use server' and exports exactly the two async actions", () => {
    const src = readFileSync(join(ROOT, "src/app/actions/reviews.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server";')).toBe(true);
    const exportLines = src.split("\n").filter((l) => /^export\b/.test(l));
    expect(exportLines).toHaveLength(2);
    for (const l of exportLines) expect(l).toMatch(/^export async function (submitReview|voteReviewHelpful)\(/);
    expect(Object.keys(wired).sort()).toEqual(["submitReview", "voteReviewHelpful"]);
    for (const v of Object.values(wired)) expect((v as () => unknown).constructor.name).toBe("AsyncFunction");
  });

  test("importing the module in a fresh process opens no database", async () => {
    const probeDb = join(import.meta.dir, `.qa-t46-probe-${process.pid}.sqlite`);
    const script = [
      `const before = globalThis.__storefrontDb;`,
      `await import(${JSON.stringify(join(ROOT, "src/app/actions/reviews.ts"))});`,
      `console.log(JSON.stringify({ before: before === undefined, after: globalThis.__storefrontDb === undefined }));`,
    ].join("\n");
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: ROOT, env: { ...process.env, DATABASE_PATH: probeDb }, stdout: "pipe", stderr: "pipe" });
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString().trim().split("\n").pop() ?? "")).toEqual({ before: true, after: true });
    expect(await Bun.file(probeDb).exists()).toBe(false);
  });
});

describe("QA T46 wired actions", () => {
  let errorSpy: ReturnType<typeof spyOn<Console, "error">>;
  beforeEach(() => {
    env.DATABASE_PATH = ":memory:";
    closeDatabase();
    seedDatabase(getDatabase());
    fakeStore = new FakeCookieStore();
    wiredRevalidatePath.mockClear();
    errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("invalid submit / vote: no cookie set, no limiter row, no review row", async () => {
    const a = errOf(await wired.submitReview(null, fd([["productId", TOTE], ["rating", "0"], ["title", "x"], ["body", "y"]])));
    expect(a.error.code).toBe("VALIDATION_FAILED");
    const b = voteErrOf(await wired.voteReviewHelpful(null, fd([["reviewId", ""]])));
    expect(b.error.code).toBe("INVALID_INPUT");
    expect(fakeStore.setCalls).toEqual([]);
    expect((getDatabase().query("SELECT count(*) AS c FROM rate_limits").get() as { c: number }).c).toBe(0);
    expect(wiredNewRows()).toEqual([]);
  });

  test("first guest submit sets exactly one sf_session; row uses it; forged sessionId ignored; PDP revalidated", async () => {
    const state = await wired.submitReview(null, validReview(TOTE, [["sessionId", S2], ["verified", "1"]]));
    expect(state).toMatchObject({ ok: true });
    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([SESSION_COOKIE_NAME]);
    expect(wiredNewRows()).toEqual([expect.objectContaining({ session_id: fakeStore.setCalls[0]?.value, display_name: "Guest Gina", verified_purchase: 0 })]);
    expect(wiredRevalidatePath.mock.calls).toEqual([[`/products/${TOTE_SLUG}`]]);
  });

  test("first vote with no cookie mints one session and counts once", async () => {
    const before = reviewRows(getDatabase(), `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count ?? -1;
    const a = await wired.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]]));
    expect(a).toMatchObject({ ok: true, helpfulCount: before + 1 });
    expect(fakeStore.setCalls).toHaveLength(1);
    const b = voteErrOf(await wired.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
    expect(b.error.code).toBe("DUPLICATE");
    expect(fakeStore.setCalls).toHaveLength(1);
    expect(reviewRows(getDatabase(), `id = '${PUBLISHED_REVIEW}'`)[0]?.helpful_count).toBe(before + 1);
  });

  test("signed in (real sf_auth): account display name stored, form name ignored, no sf_session minted, row keyed by owner key", async () => {
    const token = await signUpUser("alice.qa@example.com", "Alice Account");
    fakeStore.jar.set(AUTH_COOKIE_NAME, token);
    const state = await wired.submitReview(null, validReview(TOTE, [["displayName", "Mallory Forged"]]));
    expect(state).toMatchObject({ ok: true });
    expect(fakeStore.setCalls).toEqual([]);
    const rows = wiredNewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.display_name).toBe("Alice Account");
    expect(rows[0]?.session_id).toBe(ownerKeyOf("alice.qa@example.com"));
    const dup = errOf(await wired.submitReview(null, validReview(TOTE, [["displayName", "Mallory Forged"]])));
    expect(dup.error).toEqual({ code: "DUPLICATE", message: "You already reviewed this product." });
    expect("displayName" in dup.values).toBe(false);
    expect(JSON.stringify(dup)).not.toContain("Alice Account");
  });

  test("duplicate rule per owner key: guest cookie S1 and signed-in user both review the same product", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    expect((await wired.submitReview(null, validReview()))?.ok).toBe(true);
    const token = await signUpUser("bob.qa@example.com", "Bob Account");
    fakeStore.jar.set(AUTH_COOKIE_NAME, token); // guest cookie still present: sf_auth wins
    expect((await wired.submitReview(null, validReview()))?.ok).toBe(true);
    expect(errOf(await wired.submitReview(null, validReview())).error.code).toBe("DUPLICATE");
    fakeStore.jar.delete(AUTH_COOKIE_NAME);
    expect(errOf(await wired.submitReview(null, validReview())).error.code).toBe("DUPLICATE");
    expect(wiredNewRows().map((r) => [r.session_id, r.display_name]).sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
      [ownerKeyOf("bob.qa@example.com"), "Bob Account"],
      [S1, "Guest Gina"],
    ]);
  });

  test("revoked / garbage sf_auth falls back to guest name", async () => {
    fakeStore.jar.set(AUTH_COOKIE_NAME, "A".repeat(43));
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    expect((await wired.submitReview(null, validReview()))?.ok).toBe(true);
    expect(wiredNewRows()[0]).toMatchObject({ session_id: S1, display_name: "Guest Gina" });
  });

  test("6th wired submit in an hour is RATE_LIMITED with retryAfterSeconds; no 6th row", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
    const ids = productIds(getDatabase(), 6);
    for (let i = 0; i < 5; i++) expect((await wired.submitReview(null, validReview(ids[i])))?.ok).toBe(true);
    const err = errOf(await wired.submitReview(null, validReview(ids[5])));
    expect(err.error.code).toBe("RATE_LIMITED");
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(wiredNewRows()).toHaveLength(5);
  });

  test("multipart replay through the wrapper", async () => {
    const form = await browserMultipart(
      [["$ACTION_REF_1", ""], ["$ACTION_1:0", '{"id":"abc","bound":"$@1"}'], ["$ACTION_KEY", "k"], ["productId", TOTE], ["rating", "3"], ["title", "Okay"], ["body", "It is okay."], ["helpfulCount", "77"]],
      "----WebKitFormBoundaryWiredT46",
    );
    expect(await wired.submitReview(null, form)).toMatchObject({ ok: true });
    expect(wiredNewRows()[0]?.helpful_count).toBe(0);
  });

  test("database cannot open: both wrappers settle with the generic state and a clean log", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t46/cannot.sqlite";
    try {
      fakeStore.jar.set(SESSION_COOKIE_NAME, S1);
      const a = errOf(await wired.submitReview(null, validReview()));
      expect(a.error).toEqual({ code: "INVALID_INPUT", message: REVIEW_MESSAGES.unavailable, details: { reason: "unavailable" } });
      const b = voteErrOf(await wired.voteReviewHelpful(null, fd([["reviewId", PUBLISHED_REVIEW]])));
      expect(b.error.code).toBe("INVALID_INPUT");
      expect(errorSpy).toHaveBeenCalled();
      for (const call of errorSpy.mock.calls) expect(String(call[0])).toMatch(/^\[reviews\] REVIEW_ACTION_FAILED action=\w+$/);
    } finally {
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});

// ---------------------------------------------------------------------------
// Defect probes. `test.failing` passes while the defect exists; when the
// implementation is fixed it starts failing: convert it to a plain `test`.
// ---------------------------------------------------------------------------

describe("QA T46 defect probes", () => {
  test("D-T46-T47-2 (reviews): DB cannot open -> 'unavailable' state echoes the values (contract: values echoed so the user can retry)", async () => {
    closeDatabase();
    env.DATABASE_PATH = "/dev/null/qa-t46/cannot.sqlite";
    const spy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const err = errOf(await wired.submitReview(null, validReview()));
      expect(err.error.details).toEqual({ reason: "unavailable" });
      expect(err.values.title).toBe("Solid everyday bag");
      expect(err.values.body).toBe("Holds a laptop and groceries without complaint.");
    } finally {
      spy.mockRestore();
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
