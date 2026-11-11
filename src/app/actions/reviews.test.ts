import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// the mocks are registered before `./reviews` is imported and delegate to
// per-test state in this file (same pattern as contact.test.ts).
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
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
  headers: async (): Promise<Headers> => new Headers(),
}));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { getAuthService } = await import("@/server/auth/auth-service");
const wired = await import("./reviews");
const { submitReview, voteReviewHelpful } = wired;

const EXISTING = "33333333-3333-4333-8333-333333333333";
const FORGED = "44444444-4444-4444-8444-444444444444";
const PRODUCT = "prod_canvas-tote-bag";
const SLUG = "canvas-tote-bag";
const PUBLISHED_REVIEW = "rev_seed_001_02";
const VALID = {
  productId: PRODUCT,
  productSlug: SLUG,
  rating: "5",
  title: "Love it",
  body: "Holds a laptop and lunch with room to spare.",
  displayName: "Form Name",
} as const;

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function reviewRows(): { id: string; session_id: string; display_name: string; verified_purchase: number; status: string }[] {
  return getDatabase()
    .query("SELECT id, session_id, display_name, verified_purchase, status FROM reviews WHERE product_id = ? AND id NOT LIKE 'rev_seed_%'")
    .all(PRODUCT) as { id: string; session_id: string; display_name: string; verified_purchase: number; status: string }[];
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("'use server' module shape", () => {
  test("exports only the async submitReview and voteReviewHelpful", () => {
    const names = Object.keys(wired).sort();
    expect(names).toEqual(["submitReview", "voteReviewHelpful"]);
    for (const name of names) {
      const value: unknown = (wired as Record<string, unknown>)[name];
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });
});

describe("review server actions (wired)", () => {
  test("first submit with no cookie sets the session cookie and stores the review under it", async () => {
    const state = await submitReview(null, form({ ...VALID }));
    if (state === null || !state.ok) throw new Error(`expected success, got ${JSON.stringify(state)}`);
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(reviewRows()).toEqual([
      { id: state.reviewId, session_id: call?.value ?? "", display_name: "Form Name", verified_purchase: 0, status: "published" },
    ]);
    expect(revalidatePath.mock.calls).toEqual([[`/products/${SLUG}`]]);
  });

  test("existing cookie reused; forged sessionId/verified/status ignored", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const state = await submitReview(null, form({ ...VALID, sessionId: FORGED, verified: "true", status: "hidden", helpfulCount: "50" }));
    expect(state).toMatchObject({ ok: true });
    expect(fakeStore.setCalls).toEqual([]);
    expect(reviewRows()[0]).toMatchObject({ session_id: EXISTING, verified_purchase: 0, status: "published" });
  });

  test("invalid input sets no cookie and stores nothing", async () => {
    const state = await submitReview(null, form({ productId: PRODUCT, rating: "0" }));
    expect(state).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(reviewRows()).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("signed-in user: account display name stored, form name ignored, owner key is the user's", async () => {
    const signUp = await getAuthService().signUp(
      { email: "ada@example.com", password: "a long enough passphrase 42", displayName: "Ada Account" },
      { sessionKey: null },
    );
    if (!signUp.ok) throw new Error(`sign-up failed: ${signUp.error.code}`);
    fakeStore.jar.set(AUTH_COOKIE_NAME, signUp.value.token);
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const state = await submitReview(null, form({ ...VALID, displayName: "Pretend Person" }));
    expect(state).toMatchObject({ ok: true });
    const rows = reviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.display_name).toBe("Ada Account");
    expect(rows[0]?.session_id).not.toBe(EXISTING);
    // Duplicate rule per owner key.
    const again = await submitReview(null, form({ ...VALID }));
    expect(again).toMatchObject({ ok: false, error: { code: "DUPLICATE", message: "You already reviewed this product." } });
  });

  test("vote with no cookie creates the session and counts once", async () => {
    const first = await voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW, productSlug: SLUG }));
    expect(first).toEqual({ ok: true, helpfulCount: 3, message: "Thanks for your feedback." });
    expect(fakeStore.setCalls).toHaveLength(1);
    const second = await voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW }));
    expect(second).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });
    expect(fakeStore.setCalls).toHaveLength(1);
    const row = getDatabase().query("SELECT helpful_count FROM reviews WHERE id = ?").get(PUBLISHED_REVIEW) as { helpful_count: number };
    expect(row.helpful_count).toBe(3);
  });

  test("6th review in an hour is rate limited with retryAfterSeconds", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const products = (getDatabase().query("SELECT id FROM products ORDER BY id LIMIT 6").all() as { id: string }[]).map((r) => r.id);
    for (const productId of products.slice(0, 5)) {
      expect(await submitReview(null, form({ ...VALID, productId }))).toMatchObject({ ok: true });
    }
    const state = await submitReview(null, form({ ...VALID, productId: products[5] ?? "" }));
    expect(state).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (state === null || state.ok) throw new Error("expected error");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("a DB that cannot open still settles with a generic error (both actions)", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    closeDatabase();
    env.DATABASE_PATH = "/nonexistent-dir-for-reviews-test/db.sqlite";
    try {
      const state = await submitReview(null, form({ ...VALID }));
      expect(state).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reason: "unavailable" } } });
      if (state === null || state.ok) throw new Error("expected error");
      expect(state.values).toEqual({ rating: "5", title: VALID.title, body: VALID.body, displayName: VALID.displayName });
      const vote = await voteReviewHelpful(null, form({ reviewId: PUBLISHED_REVIEW }));
      expect(vote).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { reason: "unavailable" } } });
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("REVIEW_ACTION_FAILED");
      expect(logged).not.toContain(VALID.body);
      expect(logged).not.toContain(VALID.displayName);
    } finally {
      errorSpy.mockRestore();
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
