import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// every mock lives in this one file, is registered before `./cart` is
// imported, and delegates to per-test state.
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
const { seedProducts } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { addToCart, removeFromCart, updateCartQuantity } = await import("./cart");

const TOTE = "prod_canvas-tote-bag";
const EXISTING = "33333333-3333-4333-8333-333333333333";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function rows() {
  return getDatabase()
    .query("SELECT cart_session_id AS s, product_id AS p, quantity AS q FROM cart_items ORDER BY s, p")
    .all();
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
  seedProducts(getDatabase());
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("cart server actions (wired)", () => {
  test("first addToCart creates the session cookie and writes the cart under it", async () => {
    const state = await addToCart(null, form({ productId: TOTE, quantity: "1" }));
    expect(state).toEqual({ ok: true, value: { itemCount: 1, subtotalCents: 1999, message: "Added 1 to your cart." } });

    expect(fakeStore.setCalls).toHaveLength(1);
    const call = fakeStore.setCalls[0];
    expect(call?.name).toBe(SESSION_COOKIE_NAME);
    expect(call?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(rows()).toEqual([{ s: call?.value, p: TOTE, q: 1 }]);

    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
  });

  test("an existing session is reused and no cookie is set", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    await addToCart(null, form({ productId: TOTE, quantity: "2" }));
    await updateCartQuantity(null, form({ productId: TOTE, quantity: "3" }));
    expect(fakeStore.setCalls).toEqual([]);
    expect(rows()).toEqual([{ s: EXISTING, p: TOTE, q: 3 }]);
    const removed = await removeFromCart(null, form({ productId: TOTE }));
    expect(removed).toEqual({ ok: true, value: { itemCount: 0, subtotalCents: 0, message: "Item removed." } });
    expect(rows()).toEqual([]);
  });

  test("a client-supplied sessionId field is ignored", async () => {
    fakeStore.jar.set(SESSION_COOKIE_NAME, EXISTING);
    await addToCart(null, form({ productId: TOTE, quantity: "1", sessionId: "44444444-4444-4444-8444-444444444444" }));
    expect(rows()).toEqual([{ s: EXISTING, p: TOTE, q: 1 }]);
  });

  test("invalid input returns INVALID_INPUT, sets no cookie and does not revalidate", async () => {
    const state = await addToCart(null, form({ productId: TOTE, quantity: "lots" }));
    expect(state).toEqual({
      ok: false,
      error: { code: "INVALID_INPUT", message: "Please enter a whole number quantity.", details: { field: "quantity" } },
    });
    expect(fakeStore.setCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
  });

  test("service errors come back typed with user-safe messages", async () => {
    const state = await addToCart(null, form({ productId: "prod_ceramic-pour-over", quantity: "1" }));
    expect(state?.ok).toBe(false);
    if (state !== null && !state.ok) {
      expect(state.error.code).toBe("OUT_OF_STOCK");
      expect(state.error.message).toBe("This item is out of stock.");
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
