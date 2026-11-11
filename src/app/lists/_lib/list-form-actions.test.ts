import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// next/* mocks (process-wide in bun test): registered before the actions are imported.
class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: { name: string; value: string }[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string, value: string): void {
    this.setCalls.push({ name, value });
    this.jar.set(name, value);
  }
}

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT (test sentinel) ${url}`);
  }
}

let fakeStore = new FakeCookieStore();
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({ cookies: async (): Promise<FakeCookieStore> => fakeStore }));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const adapters = await import("./list-form-actions");

const OWNER = "33333333-3333-4333-8333-333333333333";
const TOTE = "prod_canvas-tote-bag";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    if (e instanceof RedirectSentinel) return e.url;
    throw e;
  }
  throw new Error("expected a redirect");
}

function listRows(): { id: string; name: string; session_id: string }[] {
  return getDatabase().query<{ id: string; name: string; session_id: string }, []>("SELECT id, name, session_id FROM lists").all();
}

beforeEach(() => {
  closeDatabase();
  seedDatabase(getDatabase());
  fakeStore = new FakeCookieStore();
  redirect.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("'use server' module shape", () => {
  test("exports only async functions", () => {
    expect(Object.keys(adapters).sort()).toEqual(["addToCartFromList", "createListFromIndex"]);
    for (const value of Object.values(adapters)) expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
  });
});

describe("createListFromIndex", () => {
  test("success redirects to the new list with ?created=1 (cold visit mints exactly one cookie)", async () => {
    const url = await redirectOf(() => adapters.createListFromIndex(form({ name: "Gifts", sessionId: OWNER })));
    const [row] = listRows();
    expect(url).toBe(`/lists/${row?.id}?created=1`);
    expect(fakeStore.setCalls.map((c) => c.name)).toEqual([SESSION_COOKIE_NAME]);
    expect(row?.session_id).toBe(fakeStore.setCalls[0]?.value ?? "missing");
    expect(row?.session_id).not.toBe(OWNER);
  });

  test("errors redirect to a fixed code, never echo the name, and create nothing", async () => {
    expect(await redirectOf(() => adapters.createListFromIndex(form({ name: "   " })))).toBe("/lists?createError=VALIDATION_FAILED");
    expect(await redirectOf(() => adapters.createListFromIndex(form({ name: "x".repeat(61) })))).toBe("/lists?createError=TOO_LONG");
    expect(await redirectOf(() => adapters.createListFromIndex(form({})))).toBe("/lists?createError=VALIDATION_FAILED");
    expect(listRows()).toEqual([]);
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("the 21st list redirects with LIMIT_REACHED", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, OWNER);
    for (let i = 0; i < 20; i += 1) await redirectOf(() => adapters.createListFromIndex(form({ name: `L${i}` })));
    expect(await redirectOf(() => adapters.createListFromIndex(form({ name: "one more" })))).toBe("/lists?createError=LIMIT_REACHED");
    expect(listRows()).toHaveLength(20);
  });
});

describe("addToCartFromList", () => {
  test("adds the posted product to the owner's cart and resolves", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, OWNER);
    // ListItemRow posts only productId: the adapter supplies quantity 1.
    await adapters.addToCartFromList(form({ productId: TOTE }));
    const row = getDatabase()
      .query<{ quantity: number }, [string, string]>("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?")
      .get(OWNER, TOTE);
    expect(row?.quantity).toBe(1);
    await adapters.addToCartFromList(form({ productId: TOTE, quantity: "2", priceCents: "1" }));
    const after = getDatabase()
      .query<{ quantity: number }, [string, string]>("SELECT quantity FROM cart_items WHERE cart_session_id = ? AND product_id = ?")
      .get(OWNER, TOTE);
    expect(after?.quantity).toBe(3);
    expect(redirect).not.toHaveBeenCalled();
  });

  test("invalid input still settles and adds nothing", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, OWNER);
    await adapters.addToCartFromList(form({}));
    await adapters.addToCartFromList(form({ productId: "prod_does-not-exist" }));
    await adapters.addToCartFromList(form({ productId: TOTE, quantity: "abc" }));
    const n = getDatabase().query<{ n: number }, []>("SELECT count(*) AS n FROM cart_items").get()?.n;
    expect(n).toBe(0);
  });
});
