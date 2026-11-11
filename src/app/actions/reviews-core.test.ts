import { describe, expect, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { REVIEW_FIELD } from "@/components/molecules/_contracts/review-actions";
import type { ReviewActionState, VoteActionState } from "@/components/molecules/_contracts/review-actions";
import { appError, fail, type AppError, type Result } from "@/lib/result";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createReviewService, type ReviewService } from "@/server/reviews/review-service";
import { createRateLimiter, type RateLimiter, type RateLimitOk, type RateLimitRule } from "@/server/security/rate-limiter";
import {
  REVIEW_ACTION_FAILED,
  REVIEW_MESSAGES,
  createReviewActions,
  echoReviewForm,
  echoValues,
  fieldErrorState,
  normaliseId,
  normaliseSlug,
  parseReviewForm,
  reviewRateLimitedMessage,
  toReviewErrorState,
  toVoteErrorState,
  voteRateLimitedMessage,
  type ReviewActionDeps,
} from "./reviews-core";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-9222-222222222222";
const T0 = Date.parse("2026-11-07T10:00:00.000Z");
const HOUR_MS = 3_600_000;
const PRODUCT = "prod_canvas-tote-bag";
const SLUG = "canvas-tote-bag";
const PUBLISHED_REVIEW = "rev_seed_001_02"; // helpful_count 2
const HIDDEN_REVIEW = "rev_seed_001_01";

const VALID = {
  productId: PRODUCT,
  productSlug: SLUG,
  rating: "4",
  title: "Sturdy and roomy",
  body: "Carried groceries for a month and the seams still look new.",
  displayName: "Tote Fan",
} as const;

function form(fields: Record<string, string | Blob>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Builds FormData the way a browser serialises a multipart form post (JS disabled). */
async function browserMultipart(fields: readonly (readonly [string, string])[]): Promise<FormData> {
  const boundary = "----WebKitFormBoundaryr3V1ewZPf0aJ4Lm1";
  const body =
    fields
      .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
      .join("") + `--${boundary}--\r\n`;
  const request = new Request("http://localhost/products/canvas-tote-bag", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return request.formData();
}

interface CountingLimiter extends RateLimiter {
  readonly calls: string[];
}

function counting(inner: RateLimiter): CountingLimiter {
  const calls: string[] = [];
  return {
    calls,
    check(key: string, rule: RateLimitRule): Result<RateLimitOk, AppError> {
      calls.push(key);
      return inner.check(key, rule);
    },
  };
}

interface ReviewRow {
  id: string;
  session_id: string;
  display_name: string;
  rating: number;
  verified_purchase: number;
  helpful_count: number;
  status: string;
}

function setup(overrides: Partial<ReviewActionDeps> = {}, user: { displayName: string } | null = null) {
  const db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db);
  const session: { current: string | null; next: string } = { current: null, next: S1 };
  const clock = { ms: T0 };
  const getOrCreate = mock(async (): Promise<string> => {
    if (session.current === null) session.current = session.next;
    return session.current;
  });
  const currentUser = { value: user };
  const readCurrentUser = mock(async () => currentUser.value);
  const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
  const logger = { error: mock<(...args: unknown[]) => void>(() => undefined) };
  const service = createReviewService({ db, now: () => clock.ms });
  const create = mock(service.create.bind(service));
  const voteHelpful = mock(service.voteHelpful.bind(service));
  const spied: ReviewService = { ...bindAll(service), create, voteHelpful };
  const limiter = counting(createRateLimiter(db, { now: () => clock.ms }));
  const actions = createReviewActions({
    service: spied,
    limiter,
    getOrCreateSessionId: getOrCreate,
    readCurrentUser,
    revalidatePath,
    now: () => clock.ms,
    logger,
    ...overrides,
  });
  return { db, service: spied, create, voteHelpful, limiter, getOrCreate, readCurrentUser, currentUser, revalidatePath, logger, session, clock, ...actions };
}

function bindAll(service: ReviewService): ReviewService {
  return {
    create: service.create.bind(service),
    list: service.list.bind(service),
    summary: service.summary.bind(service),
    voteHelpful: service.voteHelpful.bind(service),
    listMine: service.listMine.bind(service),
    hasReviewed: service.hasReviewed.bind(service),
  };
}

function ownRows(db: Database, sessionId: string): ReviewRow[] {
  return db
    .query("SELECT id, session_id, display_name, rating, verified_purchase, helpful_count, status FROM reviews WHERE session_id = ?")
    .all(sessionId) as ReviewRow[];
}

function reviewCount(db: Database): number {
  return (db.query("SELECT count(*) AS c FROM reviews").get() as { c: number }).c;
}

function expectReviewError(state: ReviewActionState): Extract<NonNullable<ReviewActionState>, { ok: false }> {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  return state;
}

function expectVoteError(state: VoteActionState): Extract<NonNullable<VoteActionState>, { ok: false }> {
  if (state === null || state.ok) throw new Error(`expected error state, got ${JSON.stringify(state)}`);
  return state;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parsing helpers", () => {
  test("parseReviewForm reads only contract fields; Files count as missing", () => {
    const parsed = parseReviewForm(form({ ...VALID, title: new Blob(["x"]), verified: "true", sessionId: S2 }));
    expect(parsed).toEqual({
      productId: PRODUCT,
      productSlug: SLUG,
      rating: "4",
      title: undefined,
      body: VALID.body,
      displayName: "Tote Fan",
    });
  });

  test("normaliseId trims and bounds; normaliseSlug only accepts the slug pattern", () => {
    expect(normaliseId("  abc ")).toBe("abc");
    expect(normaliseId("   ")).toBeNull();
    expect(normaliseId(undefined)).toBeNull();
    expect(normaliseId("a".repeat(200))).toBe("a".repeat(200));
    expect(normaliseId("a".repeat(201))).toBeNull();
    expect(normaliseId(" ".repeat(10_000))).toBeNull();
    expect(normaliseSlug(SLUG)).toBe(SLUG);
    expect(normaliseSlug("../admin")).toBeNull();
    expect(normaliseSlug("Canvas")).toBeNull();
    expect(normaliseSlug("a".repeat(101))).toBeNull();
    expect(normaliseSlug(undefined)).toBeNull();
  });

  test("echoValues truncates to caps, filters rating, omits displayName when signed in", () => {
    const parsed = parseReviewForm(
      form({ rating: " 5 ", title: "t".repeat(150), body: "b".repeat(2500), displayName: "n".repeat(80), productId: PRODUCT }),
    );
    expect(echoValues(parsed, false)).toEqual({
      rating: "5",
      title: "t".repeat(100),
      body: "b".repeat(2000),
      displayName: "n".repeat(50),
    });
    expect(echoValues(parsed, true)).toEqual({ rating: "5", title: "t".repeat(100), body: "b".repeat(2000) });
    expect(echoValues(parseReviewForm(form({ rating: "9" })), false)).toEqual({});
    expect(echoValues(parseReviewForm(form({ rating: "4.5" })), false)).toEqual({});
  });

  test("echo truncation never leaves a dangling high surrogate", () => {
    const title = `${"a".repeat(99)}\u{1F600}`; // emoji spans units 100-101
    const echoed = echoValues(parseReviewForm(form({ title })), false);
    expect(echoed.title).toBe("a".repeat(99));
  });

  test("rate-limit messages", () => {
    expect(reviewRateLimitedMessage(undefined)).toBe(REVIEW_MESSAGES.reviewRateLimitedFallback);
    expect(reviewRateLimitedMessage(30)).toContain("1 minute.");
    expect(reviewRateLimitedMessage(3600)).toContain("60 minutes");
    expect(reviewRateLimitedMessage(86_400)).toContain("24 hours");
    expect(voteRateLimitedMessage(undefined)).toBe(REVIEW_MESSAGES.voteRateLimitedFallback);
    expect(voteRateLimitedMessage(120)).toContain("2 minutes");
  });

  test("fieldErrorState keeps only known fields/codes and string messages", () => {
    const state = expectReviewError(
      fieldErrorState(
        {
          title: { code: "TOO_LONG", message: "Title must be at most 100 characters." },
          body: { code: "WEIRD", message: "x" },
          rating: { code: "REQUIRED", message: 5 },
          sessionId: { code: "REQUIRED", message: "nope" },
        },
        {},
      ),
    );
    expect(state.fieldErrors).toEqual({ title: "Title must be at most 100 characters." });
    expect(state.error).toEqual(appError("TOO_LONG", REVIEW_MESSAGES.tooLong, { fields: { title: "TOO_LONG" } }));
  });

  test("toReviewErrorState / toVoteErrorState map codes and whitelist details", () => {
    expect(toReviewErrorState(appError("DUPLICATE", "raw", { secret: S1 }), {})).toMatchObject({
      ok: false,
      error: { code: "DUPLICATE", message: "You already reviewed this product." },
      message: "You already reviewed this product.",
    });
    const unexpected = expectReviewError(toReviewErrorState(appError("INVALID_INPUT", "Invalid session id.", { sessionId: S1 }), {}));
    expect(unexpected.error).toEqual(appError("INVALID_INPUT", REVIEW_MESSAGES.unavailable, { reason: "unavailable" }));
    const limited = expectReviewError(toReviewErrorState(appError("RATE_LIMITED", "x", { retryAfterSeconds: 3600 }), {}));
    expect(limited.retryAfterSeconds).toBe(3600);
    const noRetry = expectReviewError(toReviewErrorState(appError("RATE_LIMITED", "x"), {}));
    expect(noRetry.retryAfterSeconds).toBeUndefined();
    expect(noRetry.message).toBe(REVIEW_MESSAGES.reviewRateLimitedFallback);

    expect(toVoteErrorState(appError("FORBIDDEN", "raw"))).toMatchObject({ error: { code: "FORBIDDEN", message: REVIEW_MESSAGES.ownReview } });
    expect(toVoteErrorState(appError("NOT_FOUND", "raw"))).toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(toVoteErrorState(appError("DUPLICATE", "raw"))).toMatchObject({ error: { code: "DUPLICATE", message: REVIEW_MESSAGES.alreadyVoted } });
    expect(toVoteErrorState(appError("VALIDATION_FAILED", "raw"))).toMatchObject({ error: { code: "INVALID_INPUT", details: { reason: "unavailable" } } });
  });
});

// ---------------------------------------------------------------------------
// submitReview
// ---------------------------------------------------------------------------

describe("submitReview", () => {
  test("happy path: creates the review, revalidates the PDP, returns the review id", async () => {
    const h = setup();
    const state = await h.submitReview(null, form({ ...VALID }));
    if (state === null || !state.ok) throw new Error(JSON.stringify(state));
    expect(state).toEqual({ ok: true, kind: "created", message: REVIEW_MESSAGES.created, reviewId: state.reviewId });
    const rows = ownRows(h.db, S1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: state.reviewId, display_name: "Tote Fan", rating: 4, status: "published", helpful_count: 0 });
    expect(h.revalidatePath.mock.calls).toEqual([[`/products/${SLUG}`]]);
    expect(h.limiter.calls).toEqual([`review.submit:${S1}`, "review.submit:*"]);
  });

  test("criterion 7: works with browser multipart FormData (JS disabled)", async () => {
    const h = setup();
    const fd = await browserMultipart([
      ["$ACTION_ID_abc123", ""],
      [REVIEW_FIELD.productId, PRODUCT],
      [REVIEW_FIELD.productSlug, SLUG],
      [REVIEW_FIELD.rating, "5"],
      [REVIEW_FIELD.title, "Great"],
      [REVIEW_FIELD.body, "Line one\r\nLine two"],
      [REVIEW_FIELD.displayName, ""],
    ]);
    const state = await h.submitReview(null, fd);
    expect(state).toMatchObject({ ok: true, kind: "created" });
    expect(ownRows(h.db, S1)[0]).toMatchObject({ rating: 5, display_name: "Anonymous shopper" });
  });

  test("criterion 1: missing productId -> field error, no session, no limiter, no service", async () => {
    const h = setup();
    const before = reviewCount(h.db);
    const { productId: _omit, ...rest } = VALID;
    void _omit;
    const state = expectReviewError(await h.submitReview(null, form(rest)));
    expect(state.error.code).toBe("VALIDATION_FAILED");
    expect(state.error.details).toEqual({ fields: { productId: "REQUIRED" } });
    expect(state.message).toBe(REVIEW_MESSAGES.invalidRequest);
    expect(state.fieldErrors).toEqual({});
    expect(state.values).toMatchObject({ rating: "4", title: VALID.title });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(h.create).not.toHaveBeenCalled();
    expect(reviewCount(h.db)).toBe(before);
  });

  test("criterion 1: blank/oversized productId and File productId are rejected the same way", async () => {
    const h = setup();
    for (const productId of ["   ", "p".repeat(201), new Blob(["prod"])]) {
      const state = expectReviewError(await h.submitReview(null, form({ ...VALID, productId })));
      expect(state.error.details).toEqual({ fields: { productId: "REQUIRED" } });
    }
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("criterion 1: missing productId plus bad fields reports all of them", async () => {
    const h = setup();
    const state = expectReviewError(await h.submitReview(null, form({ title: "", body: "" })));
    expect(state.message).toBe(REVIEW_MESSAGES.invalid);
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["body", "rating", "title"]);
    expect(state.error.details).toEqual({ fields: { rating: "REQUIRED", title: "REQUIRED", body: "REQUIRED", productId: "REQUIRED" } });
  });

  test("criterion 1: invalid rating/title/body -> per-field errors, no session, no state change", async () => {
    const h = setup();
    const before = reviewCount(h.db);
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID, rating: "7", title: "  ", body: "" })));
    expect(state.error.code).toBe("VALIDATION_FAILED");
    expect(state.fieldErrors.rating).toBe("Rating must be a whole number from 1 to 5.");
    expect(state.fieldErrors.title).toBe("Title is required.");
    expect(state.fieldErrors.body).toBe("Review is required.");
    expect(state.error.details).toEqual({ fields: { rating: "INVALID", title: "REQUIRED", body: "REQUIRED" } });
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
    expect(h.create).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(reviewCount(h.db)).toBe(before);
  });

  test("criterion 6: values echoed on validation errors, truncated to caps", async () => {
    const h = setup();
    const state = expectReviewError(
      await h.submitReview(null, form({ ...VALID, title: "T".repeat(150), body: "B".repeat(2600), displayName: "N".repeat(70) })),
    );
    expect(state.error.code).toBe("TOO_LONG");
    expect(state.message).toBe(REVIEW_MESSAGES.tooLong);
    expect(state.values).toEqual({ rating: "4", title: "T".repeat(100), body: "B".repeat(2000), displayName: "N".repeat(50) });
    expect(Object.keys(state.fieldErrors).sort()).toEqual(["body", "displayName", "title"]);
    expect(JSON.stringify(state)).not.toContain(PRODUCT);
  });

  test("too many links is a body field error", async () => {
    const h = setup();
    const state = expectReviewError(
      await h.submitReview(null, form({ ...VALID, body: "see https://a.example https://b.example https://c.example" })),
    );
    expect(state.error.details).toEqual({ fields: { body: "TOO_MANY_URLS" } });
    expect(h.getOrCreate).not.toHaveBeenCalled();
  });

  test("criterion 3: forged verified/helpfulCount/status/sessionId/isOwn are ignored", async () => {
    const h = setup();
    const state = await h.submitReview(
      null,
      form({ ...VALID, verified: "true", verifiedPurchase: "1", helpfulCount: "999", status: "hidden", sessionId: S2, isOwn: "true" }),
    );
    expect(state).toMatchObject({ ok: true });
    expect(ownRows(h.db, S2)).toEqual([]);
    expect(ownRows(h.db, S1)[0]).toMatchObject({ verified_purchase: 0, helpful_count: 0, status: "published" });
    expect(h.create.mock.calls[0]?.[0]).toBe(S1);
    expect(Object.keys(h.create.mock.calls[0]?.[1] ?? {}).sort()).toEqual(["body", "displayName", "productId", "rating", "title"]);
  });

  test("criterion 4: first submit with no session creates it exactly once, after validation", async () => {
    const h = setup();
    expect(h.session.current).toBeNull();
    await h.submitReview(null, form({ ...VALID }));
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.session.current).toBe(S1);
  });

  test("criterion 2: 6th review in an hour is RATE_LIMITED with retryAfterSeconds; service not called", async () => {
    const h = setup();
    const products = (h.db.query("SELECT id FROM products ORDER BY id LIMIT 6").all() as { id: string }[]).map((r) => r.id);
    for (const productId of products.slice(0, 5)) {
      expect(await h.submitReview(null, form({ ...VALID, productId }))).toMatchObject({ ok: true });
    }
    h.create.mockClear();
    h.revalidatePath.mockClear();
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID, productId: products[5] ?? "" })));
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.error.details).toEqual({ retryAfterSeconds: state.retryAfterSeconds });
    expect(state.message).toMatch(/^You have posted several reviews recently\. Please try again in \d+ minutes?\.$/);
    expect(state.values).toMatchObject({ title: VALID.title });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.revalidatePath).not.toHaveBeenCalled();
    expect(ownRows(h.db, S1)).toHaveLength(5);

    // Next window: allowed again.
    h.clock.ms += HOUR_MS;
    expect(await h.submitReview(null, form({ ...VALID, productId: products[5] ?? "" }))).toMatchObject({ ok: true });
  });

  test("criterion 2: global backstop applies across sessions", async () => {
    const limiter: RateLimiter = {
      check: (key) => (key.endsWith(":*") ? fail("RATE_LIMITED", "x", { retryAfterSeconds: 1200 }) : { ok: true, value: { remaining: 4 } }),
    };
    const h = setup({ limiter });
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID })));
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBe(1200);
    expect(h.create).not.toHaveBeenCalled();
  });

  test("criterion 5: duplicate review -> DUPLICATE with the agreed message; nothing changes", async () => {
    const h = setup();
    expect(await h.submitReview(null, form({ ...VALID }))).toMatchObject({ ok: true });
    h.revalidatePath.mockClear();
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID, title: "Second try" })));
    expect(state.error).toEqual({ code: "DUPLICATE", message: "You already reviewed this product." });
    expect(state.message).toBe("You already reviewed this product.");
    expect(state.values.title).toBe("Second try");
    expect(ownRows(h.db, S1)).toHaveLength(1);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("criterion 5: concurrent double submit stores one review", async () => {
    const h = setup();
    h.session.current = S1;
    const [a, b] = await Promise.all([h.submitReview(null, form({ ...VALID })), h.submitReview(null, form({ ...VALID }))]);
    const oks = [a, b].filter((s) => s !== null && s.ok);
    expect(oks).toHaveLength(1);
    expect([a, b].some((s) => s !== null && !s.ok && s.error.code === "DUPLICATE")).toBe(true);
    expect(ownRows(h.db, S1)).toHaveLength(1);
  });

  test("criterion 8: signed-in review stores the ACCOUNT display name; form name ignored", async () => {
    const h = setup({}, { displayName: "Ada L." });
    const state = await h.submitReview(null, form({ ...VALID, displayName: "Impersonated Name" }));
    expect(state).toMatchObject({ ok: true });
    expect(ownRows(h.db, S1)[0]?.display_name).toBe("Ada L.");
    expect(h.create.mock.calls[0]?.[1].displayName).toBe("Ada L.");
  });

  test("criterion 8: signed-in name is used even when the form name is invalid/too long", async () => {
    const h = setup({}, { displayName: "Ada L." });
    const state = await h.submitReview(null, form({ ...VALID, displayName: "x".repeat(500) }));
    expect(state).toMatchObject({ ok: true });
    expect(ownRows(h.db, S1)[0]?.display_name).toBe("Ada L.");
  });

  test("criterion 8: signed-in validation errors do not echo the form name", async () => {
    const h = setup({}, { displayName: "Ada L." });
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID, title: "", displayName: "Someone" })));
    expect(state.values.displayName).toBeUndefined();
  });

  test("criterion 8: guests keep their chosen name; empty becomes the default", async () => {
    const h = setup();
    await h.submitReview(null, form({ ...VALID, displayName: "  Guest   Writer " }));
    expect(ownRows(h.db, S1)[0]?.display_name).toBe("Guest Writer");
    const h2 = setup();
    const { displayName: _d, ...rest } = VALID;
    void _d;
    await h2.submitReview(null, form(rest));
    expect(ownRows(h2.db, S1)[0]?.display_name).toBe("Anonymous shopper");
  });

  test("criterion 8: duplicate rule applies per owner key (user key differs from guest key)", async () => {
    const h = setup();
    expect(await h.submitReview(null, form({ ...VALID }))).toMatchObject({ ok: true });
    h.session.current = S2; // signed in: the resolver now returns the user's owner key
    h.currentUser.value = { displayName: "Ada L." };
    expect(await h.submitReview(null, form({ ...VALID }))).toMatchObject({ ok: true });
    expect(expectReviewError(await h.submitReview(null, form({ ...VALID }))).error.code).toBe("DUPLICATE");
  });

  test("unknown product -> PRODUCT_NOT_FOUND, no revalidate", async () => {
    const h = setup();
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID, productId: "prod_nope" })));
    expect(state.error).toEqual({ code: "PRODUCT_NOT_FOUND", message: REVIEW_MESSAGES.productNotFound });
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("bad productSlug: review saved but no revalidate of an arbitrary path", async () => {
    const h = setup();
    const products = ["prod_canvas-tote-bag", "prod_enamel-pin-set", "prod_walnut-desk"];
    const slugs = ["../../admin", "Canvas Tote", "x/y"];
    for (const [i, productSlug] of slugs.entries()) {
      expect(await h.submitReview(null, form({ ...VALID, productId: products[i] ?? "", productSlug }))).toMatchObject({ ok: true });
    }
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });

  test("always settles: thrown session/user/service errors -> generic state, code-only log", async () => {
    const throwing = [
      { getOrCreateSessionId: async (): Promise<string> => Promise.reject(new Error(`cookies down ${S1}`)) },
      { readCurrentUser: async (): Promise<{ displayName: string } | null> => Promise.reject(new Error("db")) },
    ] satisfies Partial<ReviewActionDeps>[];
    for (const override of throwing) {
      const h = setup(override);
      const state = expectReviewError(await h.submitReview(null, form({ ...VALID })));
      expect(state.error).toEqual(appError("INVALID_INPUT", REVIEW_MESSAGES.unavailable, { reason: "unavailable" }));
      expect(h.logger.error.mock.calls).toEqual([[`[reviews] ${REVIEW_ACTION_FAILED} action=submit`]]);
    }
    const h = setup();
    h.create.mockImplementation(() => {
      throw new Error(`SQLITE_BUSY ${VALID.body}`);
    });
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID })));
    expect(state.values.body).toBe(VALID.body);
    const logged = JSON.stringify(h.logger.error.mock.calls);
    expect(logged).not.toContain(VALID.body);
    expect(logged).not.toContain(S1);
    expect(logged).not.toContain(VALID.displayName);
  });

  test("readCurrentUser throws -> generic state still echoes the typed values (D-T46-T47-2)", async () => {
    const h = setup({ readCurrentUser: async (): Promise<{ displayName: string } | null> => Promise.reject(new Error("db")) });
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID, title: "T".repeat(150) })));
    expect(state.error.details).toEqual({ reason: "unavailable" });
    expect(state.values).toEqual({ rating: "4", title: "T".repeat(100), body: VALID.body, displayName: VALID.displayName });
    expect(JSON.stringify(state.values)).not.toContain(PRODUCT);
  });

  test("echoReviewForm: guest echo straight from the form, truncated, never ids", () => {
    expect(echoReviewForm(form({ ...VALID, body: "b".repeat(2100), reviewId: "rev_x" }))).toEqual({
      rating: "4",
      title: VALID.title,
      body: "b".repeat(2000),
      displayName: VALID.displayName,
    });
    expect(echoReviewForm(form({}))).toEqual({});
  });

  test("invalid owner key from the resolver -> generic error, not a raw service message", async () => {
    const h = setup({ getOrCreateSessionId: async () => "not-a-uuid" });
    const state = expectReviewError(await h.submitReview(null, form({ ...VALID })));
    expect(state.error.details).toEqual({ reason: "unavailable" });
  });
});

// ---------------------------------------------------------------------------
// voteReviewHelpful
// ---------------------------------------------------------------------------

describe("voteReviewHelpful", () => {
  test("criterion 4: vote with no cookie creates the session and counts once", async () => {
    const h = setup();
    const state = await h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW, productSlug: SLUG }));
    expect(state).toEqual({ ok: true, helpfulCount: 3, message: REVIEW_MESSAGES.voted });
    expect(h.getOrCreate).toHaveBeenCalledTimes(1);
    expect(h.session.current).toBe(S1);
    expect(h.revalidatePath.mock.calls).toEqual([[`/products/${SLUG}`]]);
    expect(h.limiter.calls).toEqual([`vote:${S1}`, "vote:*"]);
  });

  test("criterion 5: duplicate vote -> DUPLICATE; count unchanged", async () => {
    const h = setup();
    await h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW }));
    const state = expectVoteError(await h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW })));
    expect(state.error).toEqual({ code: "DUPLICATE", message: REVIEW_MESSAGES.alreadyVoted });
    const row = h.db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(PUBLISHED_REVIEW) as { helpful_count: number };
    expect(row.helpful_count).toBe(3);
  });

  test("concurrent double vote counts once", async () => {
    const h = setup();
    h.session.current = S1;
    const results = await Promise.all([
      h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW })),
      h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW })),
    ]);
    expect(results.filter((s) => s !== null && s.ok)).toHaveLength(1);
    const row = h.db.query("SELECT helpful_count FROM reviews WHERE id = ?").get(PUBLISHED_REVIEW) as { helpful_count: number };
    expect(row.helpful_count).toBe(3);
  });

  test("criterion 3: forged helpfulCount/sessionId ignored", async () => {
    const h = setup();
    const state = await h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW, helpfulCount: "1000", sessionId: S2 }));
    expect(state).toMatchObject({ ok: true, helpfulCount: 3 });
    expect(h.voteHelpful.mock.calls).toEqual([[S1, PUBLISHED_REVIEW]]);
  });

  test("own review -> FORBIDDEN; hidden/unknown -> NOT_FOUND", async () => {
    const h = setup();
    const created = await h.submitReview(null, form({ ...VALID }));
    if (created === null || !created.ok) throw new Error("setup failed");
    expect(expectVoteError(await h.voteReviewHelpful(null, form({ reviewId: created.reviewId }))).error.code).toBe("FORBIDDEN");
    expect(expectVoteError(await h.voteReviewHelpful(null, form({ reviewId: HIDDEN_REVIEW }))).error).toEqual({
      code: "NOT_FOUND",
      message: REVIEW_MESSAGES.reviewNotFound,
    });
    expect(expectVoteError(await h.voteReviewHelpful(null, form({ reviewId: "rev_missing" }))).error.code).toBe("NOT_FOUND");
  });

  test("missing/blank/File reviewId -> INVALID_INPUT, no session, no limiter", async () => {
    const h = setup();
    for (const fd of [form({}), form({ reviewId: "  " }), form({ reviewId: new Blob(["r"]) }), form({ reviewId: "r".repeat(201) })]) {
      const state = expectVoteError(await h.voteReviewHelpful(null, fd));
      expect(state.error).toEqual({ code: "INVALID_INPUT", message: REVIEW_MESSAGES.invalidRequest, details: { field: "reviewId" } });
    }
    expect(h.getOrCreate).not.toHaveBeenCalled();
    expect(h.limiter.calls).toEqual([]);
  });

  test("61st vote in an hour is RATE_LIMITED; service not called", async () => {
    const h = setup();
    h.session.current = S1;
    for (let i = 0; i < 60; i++) {
      await h.voteReviewHelpful(null, form({ reviewId: `rev_missing_${i}` }));
    }
    h.voteHelpful.mockClear();
    const state = expectVoteError(await h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW })));
    expect(state.error.code).toBe("RATE_LIMITED");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
    expect(state.message).toMatch(/^You have voted many times recently\. Please try again in \d+ minutes?\.$/);
    expect(h.voteHelpful).not.toHaveBeenCalled();
  });

  test("works with browser multipart FormData", async () => {
    const h = setup();
    const fd = await browserMultipart([
      ["$ACTION_ID_def456", ""],
      [REVIEW_FIELD.reviewId, PUBLISHED_REVIEW],
      [REVIEW_FIELD.productSlug, SLUG],
    ]);
    expect(await h.voteReviewHelpful(null, fd)).toMatchObject({ ok: true, helpfulCount: 3 });
  });

  test("always settles: thrown errors -> generic state, code-only log", async () => {
    const h = setup({ getOrCreateSessionId: async (): Promise<string> => Promise.reject(new Error("boom")) });
    const state = expectVoteError(await h.voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW })));
    expect(state.error).toEqual(appError("INVALID_INPUT", REVIEW_MESSAGES.voteUnavailable, { reason: "unavailable" }));
    expect(h.logger.error.mock.calls).toEqual([[`[reviews] ${REVIEW_ACTION_FAILED} action=vote`]]);
  });
});
