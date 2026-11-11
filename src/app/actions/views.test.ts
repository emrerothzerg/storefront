import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// next/headers + next/cache mocks, registered before `./views` is imported
// (mock.module is process-wide; same pattern as cart.test.ts / stock-alerts.test.ts).

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
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const wired = await import("./views");
const { recordProductView, recordProductViewForm, removeFromHistory, clearHistory } = wired;

const TOTE_SLUG = "canvas-tote-bag";
const EXISTING = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function rows(): { session_id: string; product_id: string }[] {
  return getDatabase().query("SELECT session_id, product_id FROM product_views ORDER BY session_id").all() as {
    session_id: string;
    product_id: string;
  }[];
}

function toteId(): string {
  const row = getDatabase().query("SELECT id FROM products WHERE slug = ?").get(TOTE_SLUG) as { id: string } | null;
  if (row === null) throw new Error("seed changed");
  return row.id;
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
  test("exports only the four async functions", () => {
    const names = Object.keys(wired).sort();
    expect(names).toEqual(["clearHistory", "recordProductView", "recordProductViewForm", "removeFromHistory"]);
    for (const name of names) {
      const value: unknown = wired[name as keyof typeof wired];
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });
});

describe("view actions (wired)", () => {
  test("unknown slug/id: ignored, no cookie, no row", async () => {
    expect(await recordProductView({ productSlug: "no-such-product" })).toEqual({ ok: true, kind: "ignored" });
    expect(await recordProductView({ productId: "prod_no-such" })).toEqual({ ok: true, kind: "ignored" });
    const beacon = recordProductView as (input: unknown) => Promise<unknown>;
    expect(await beacon(["x"])).toEqual({ ok: true, kind: "ignored" });
    expect(await beacon("x".repeat(10_000))).toEqual({ ok: true, kind: "ignored" });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  test("first valid view sets the session cookie once and upserts one row", async () => {
    expect(await recordProductView({ productSlug: TOTE_SLUG })).toEqual({ ok: true, kind: "recorded" });
    expect(await recordProductView({ productSlug: TOTE_SLUG })).toEqual({ ok: true, kind: "recorded" });
    expect(await recordProductView({ productId: toteId() })).toEqual({ ok: true, kind: "recorded" });
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(rows()).toEqual([{ session_id: call?.value ?? "", product_id: toteId() }]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("form variant records under the existing cookie, ignoring a forged sessionId", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    expect(await recordProductViewForm(null, form({ productSlug: TOTE_SLUG, sessionId: OTHER }))).toMatchObject({
      kind: "recorded",
    });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()).toEqual([{ session_id: EXISTING, product_id: toteId() }]);
  });

  test("remove/clear without a cookie are ignored and set no cookie", async () => {
    expect(await removeFromHistory(null, form({ productId: toteId() }))).toEqual({ ok: true, kind: "ignored" });
    expect(await clearHistory(null, form({ confirm: "yes" }))).toEqual({ ok: true, kind: "ignored" });
    expect(fakeStore.setCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("remove and clear act only on this session and revalidate /account/history + /account", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    await recordProductView({ productSlug: TOTE_SLUG });
    await recordProductView({ productSlug: "ceramic-pour-over" });
    getDatabase()
      .query("INSERT INTO product_views (session_id, product_id, viewed_at) VALUES (?, ?, ?)")
      .run(OTHER, toteId(), "2026-11-01T00:00:00.000Z");

    expect(await removeFromHistory(null, form({ productId: toteId() }))).toMatchObject({ ok: true, kind: "removed" });
    expect(rows().filter((r) => r.session_id === EXISTING)).toHaveLength(1);

    expect(await clearHistory(null, form({}))).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
    expect(await clearHistory(null, form({ confirm: "yes", sessionId: OTHER }))).toMatchObject({ ok: true, kind: "cleared" });
    expect(rows()).toEqual([{ session_id: OTHER, product_id: toteId() }]);
    expect(revalidatePath.mock.calls).toEqual([["/account/history"], ["/account"], ["/account/history"], ["/account"]]);
  });
});

describe("wired wrappers always settle (QA D1)", () => {
  test("cookie store failure in every wrapper settles with a state, even if console.error throws", async () => {
    const originalError = console.error;
    console.error = () => {
      throw new Error("logger down");
    };
    const brokenStore = {
      get: (): never => {
        throw new Error("cookies down");
      },
      set: (): never => {
        throw new Error("cookies down");
      },
    };
    fakeStore = brokenStore as unknown as FakeCookieStore;
    try {
      const states = [
        await recordProductView({ productSlug: TOTE_SLUG }),
        await recordProductViewForm(null, form({ productSlug: TOTE_SLUG })),
        await removeFromHistory(null, form({ productId: toteId() })),
        await clearHistory(null, form({ confirm: "yes" })),
      ];
      for (const state of states) expect(state).not.toBeNull();
    } finally {
      console.error = originalError;
    }
  });
});
