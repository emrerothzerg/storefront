import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// the mocks are registered before `./questions` is imported and delegate to
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
}));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { AUTH_COOKIE_NAME, SESSION_COOKIE_NAME } = await import("@/server/session/session");
const wired = await import("./questions");
const { askQuestion, answerQuestion, voteQuestion, voteAnswer } = wired;

const EXISTING = "33333333-3333-4333-8333-333333333333";
const FORGED = "44444444-4444-4444-8444-444444444444";
const QUESTION = "Is the strap adjustable for taller people?";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function seeded(): { productId: string; slug: string; questionId: string; answerId: string } {
  const db = getDatabase();
  const product = db
    .query<{ id: string; slug: string }, []>(
      "SELECT id, slug FROM products WHERE published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY id LIMIT 1",
    )
    .get();
  const answer = db
    .query<{ id: string; question_id: string }, []>(
      `SELECT a.id, a.question_id FROM answers a JOIN questions q ON q.id = a.question_id JOIN products p ON p.id = q.product_id
       WHERE a.status = 'published' AND q.status = 'published' AND p.published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
       ORDER BY a.id LIMIT 1`,
    )
    .get();
  if (product === null || answer === null) throw new Error("seed is missing Q&A data");
  return { productId: product.id, slug: product.slug, questionId: answer.question_id, answerId: answer.id };
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
  test("exports only the four async actions", () => {
    expect(Object.keys(wired).sort()).toEqual(["answerQuestion", "askQuestion", "voteAnswer", "voteQuestion"]);
    for (const value of Object.values(wired) as unknown[]) {
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });
});

describe("Q&A server actions (wired)", () => {
  test("first ask sets the session cookie once and stores the question under it; PDP revalidated", async () => {
    const data = seeded();
    const state = await askQuestion(
      null,
      form({ productId: data.productId, productSlug: data.slug, body: QUESTION, sessionId: FORGED, isStore: "1" }),
    );
    if (state === null || !state.ok) throw new Error(`expected success, got ${JSON.stringify(state)}`);
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    const row = getDatabase().query<{ session_id: string }, [string]>("SELECT session_id FROM questions WHERE id = ?").get(state.id);
    expect(row?.session_id).toBe(call?.value ?? "");
    expect(revalidatePath.mock.calls).toEqual([[`/products/${data.slug}`]]);
  });

  test("existing cookie reused for answer; vote with no cookie creates a session and counts once", async () => {
    const data = seeded();
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    const answered = await answerQuestion(null, form({ questionId: data.questionId, body: "Yes, it is." }));
    if (answered === null || !answered.ok) throw new Error(JSON.stringify(answered));
    expect(fakeStore.setCalls).toEqual([]);
    const row = getDatabase().query<{ session_id: string }, [string]>("SELECT session_id FROM answers WHERE id = ?").get(answered.id);
    expect(row?.session_id).toBe(EXISTING);

    fakeStore = new FakeCookieStore();
    const voted = await voteAnswer(null, form({ answerId: data.answerId, helpfulCount: "999" }));
    expect(voted).toMatchObject({ ok: true });
    expect(fakeStore.setCalls).toHaveLength(1);
    const sid = fakeStore.setCalls[0]?.value ?? "";
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM answer_votes WHERE session_id = ?").get(sid)).toEqual({ n: 1 });
    expect(await voteAnswer(null, form({ answerId: data.answerId }))).toMatchObject({ ok: false, error: { code: "DUPLICATE" } });
  });

  test("invalid input sets no cookie, writes nothing, revalidates nothing", async () => {
    const data = seeded();
    expect(await askQuestion(null, form({ body: QUESTION }))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await askQuestion(null, form({ productId: data.productId, body: "short" }))).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_FAILED" },
    });
    expect(await voteQuestion(null, form({}))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("6th question in an hour is rate limited", async () => {
    const data = seeded();
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    for (let i = 0; i < 5; i++) {
      expect(await askQuestion(null, form({ productId: data.productId, body: `${QUESTION} ${i}` }))).toMatchObject({ ok: true });
    }
    const state = await askQuestion(null, form({ productId: data.productId, body: `${QUESTION} 5` }));
    expect(state).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    if (state === null || state.ok) throw new Error("expected error");
    expect(state.retryAfterSeconds).toBeGreaterThan(0);
  });

  test("a DB that cannot open still settles with a generic error for every action", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    closeDatabase();
    env.DATABASE_PATH = "/nonexistent-dir-for-qa-test/db.sqlite";
    try {
      const generic = { ok: false, error: { code: "INVALID_INPUT", details: { reason: "unavailable" } } };
      expect(await askQuestion(null, form({ productId: "p", body: QUESTION }))).toMatchObject(generic);
      expect(await answerQuestion(null, form({ questionId: "q", body: "Yes." }))).toMatchObject(generic);
      expect(await voteQuestion(null, form({ questionId: "q" }))).toMatchObject(generic);
      expect(await voteAnswer(null, form({ answerId: "a" }))).toMatchObject(generic);
      // Contract: "unavailable" echoes the values (body + guest displayName, capped; never ids).
      expect(
        await askQuestion(null, form({ productId: "p", body: QUESTION, displayName: "Guest Gus" })),
      ).toMatchObject({ values: { body: QUESTION, displayName: "Guest Gus" } });
      const answerState = await answerQuestion(null, form({ questionId: "q", body: "b".repeat(1500), displayName: "n".repeat(60) }));
      if (answerState === null || answerState.ok) throw new Error("expected error");
      expect(answerState.values).toEqual({ body: "b".repeat(1000), displayName: "n".repeat(50) });
      // With an sf_auth cookie present the posted displayName is omitted.
      fakeStore.jar.set(AUTH_COOKIE_NAME, "a".repeat(43));
      const signedIn = await askQuestion(null, form({ productId: "p", body: QUESTION, displayName: "Posted" }));
      if (signedIn === null || signedIn.ok) throw new Error("expected error");
      expect(signedIn.values).toEqual({ body: QUESTION });
      const logged = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
      expect(logged).toContain("QA_ACTION_FAILED");
      expect(logged).not.toContain(QUESTION);
    } finally {
      errorSpy.mockRestore();
      closeDatabase();
      env.DATABASE_PATH = ":memory:";
    }
  });
});
