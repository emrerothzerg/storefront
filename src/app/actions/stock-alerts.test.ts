import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// the mocks are registered before `./stock-alerts` is imported and delegate to
// per-test state in this file (same pattern as cart.test.ts).
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
const wired = await import("./stock-alerts");
const { subscribeStockAlert, unsubscribeStockAlert, acknowledgeStockAlert } = wired;

const POUR_OVER = "prod_ceramic-pour-over"; // stock 0
const EXISTING = "33333333-3333-4333-8333-333333333333";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function rows(): { id: string; session_id: string; product_id: string }[] {
  return getDatabase().query("SELECT id, session_id, product_id FROM stock_alerts").all() as {
    id: string;
    session_id: string;
    product_id: string;
  }[];
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
  test("exports only the three async functions", () => {
    const names = Object.keys(wired).sort();
    expect(names).toEqual(["acknowledgeStockAlert", "subscribeStockAlert", "unsubscribeStockAlert"]);
    for (const name of names) {
      const value: unknown = wired[name as keyof typeof wired];
      expect(typeof value).toBe("function");
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });
});

describe("stock alert server actions (wired)", () => {
  test("first subscribe sets the session cookie and writes the alert under it", async () => {
    const state = await subscribeStockAlert(null, form({ productId: POUR_OVER, productSlug: "ceramic-pour-over" }));
    expect(state).toMatchObject({ ok: true, kind: "subscribed" });
    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(rows()).toEqual([expect.objectContaining({ session_id: call?.value, product_id: POUR_OVER })]);
    expect(revalidatePath.mock.calls).toEqual([["/products/ceramic-pour-over"], ["/account/alerts"], ["/account"]]);
  });

  test("invalid input sets no cookie", async () => {
    const state = await subscribeStockAlert(null, form({ email: "a@example.com" }));
    expect(state).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: { field: "productId" } } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  test("unsubscribe/acknowledge without a cookie return NOT_FOUND and set no cookie", async () => {
    for (const action of [unsubscribeStockAlert, acknowledgeStockAlert]) {
      const state = await action(null, form({ alertId: "00000000-0000-4000-8000-000000000001" }));
      expect(state).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    }
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("existing session: forged sessionId ignored, acknowledge then unsubscribe", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    await subscribeStockAlert(null, form({ productId: POUR_OVER, sessionId: "44444444-4444-4444-8444-444444444444" }));
    expect(fakeStore.setCalls).toEqual([]);
    const [row] = rows();
    expect(row?.session_id).toBe(EXISTING);
    const id = row?.id ?? "";
    expect(await acknowledgeStockAlert(null, form({ alertId: id }))).toMatchObject({ ok: true, kind: "acknowledged" });
    expect(await unsubscribeStockAlert(null, form({ alertId: id }))).toMatchObject({ ok: true, kind: "unsubscribed" });
    expect(rows()).toEqual([]);
  });
});
