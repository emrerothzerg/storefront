import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// next/headers + next/navigation + next/cache mocks. mock.module is
// process-wide in bun test, so the mocks are registered before `./checkout`
// is imported and delegate to per-test state. next/navigation spreads the
// real exports so other imports keep working.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: string[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string): void {
    this.setCalls.push(name);
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
const revalidatePath = mock<(path: string, type?: "page" | "layout") => void>(() => undefined);
const redirect = mock((url: string): never => {
  throw new RedirectSentinel(url);
});
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/navigation", () => ({ ...realNavigation, redirect }));
mock.module("next/cache", () => ({ revalidatePath }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedProducts } = await import("@/server/db/seed");
const { createCartService } = await import("@/server/cart/cart-service");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
const checkoutModule = await import("./checkout");
const { placeOrder } = checkoutModule;

const TOTE = "prod_canvas-tote-bag";
const SESSION = "88888888-8888-4888-8888-888888888888";

function checkoutForm(card: string, key: string = crypto.randomUUID()): FormData {
  const fields: Record<string, string> = {
    idempotencyKey: key,
    fullName: "Grace Hopper",
    email: "grace@example.com",
    line1: "1 Compiler Rd",
    line2: "",
    city: "Arlington",
    region: "VA",
    postalCode: "22201",
    country: "US",
    nameOnCard: "Grace Hopper",
    number: card,
    expMonth: "1",
    expYear: String(new Date().getUTCFullYear() + 3),
    cvc: "123",
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function redirectUrl(fd: FormData): Promise<string> {
  try {
    await placeOrder(null, fd);
  } catch (e) {
    if (e instanceof RedirectSentinel) return e.url;
    throw e;
  }
  throw new Error("expected redirect");
}

function orderCount(): number {
  return (getDatabase().query("SELECT COUNT(*) AS n FROM orders").get() as { n: number }).n;
}

beforeEach(() => {
  closeDatabase();
  seedProducts(getDatabase());
  fakeStore = new FakeCookieStore();
  revalidatePath.mockClear();
  redirect.mockClear();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("checkout.ts wiring", () => {
  test("exports only the async placeOrder action", () => {
    expect(Object.keys(checkoutModule)).toEqual(["placeOrder"]);
    expect(placeOrder.constructor.name).toBe("AsyncFunction");
  });

  test("success reads the cookie session, revalidates and redirects via next/navigation", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);
    const key = crypto.randomUUID();

    const url = await redirectUrl(checkoutForm(MOCK_CARDS.success, key));
    const row = getDatabase().query("SELECT id, session_id AS s FROM orders").get() as { id: string; s: string };
    expect(url).toBe(`/orders/${row.id}`);
    expect(row.s).toBe(SESSION);
    expect(revalidatePath.mock.calls).toEqual([["/cart"], ["/", "layout"]]);
    expect(url).not.toContain("4242");

    expect(await redirectUrl(checkoutForm(MOCK_CARDS.success, key))).toBe(url);
    expect(orderCount()).toBe(1);
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("declined card returns PAYMENT_FAILED and keeps the cart", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, SESSION);

    const state = await placeOrder(null, checkoutForm(MOCK_CARDS.declined));
    expect(state?.error.code).toBe("PAYMENT_FAILED");
    expect(state?.error.message).toBe("Your card was declined.");
    expect(JSON.stringify(state)).not.toContain(MOCK_CARDS.declined);
    expect(createCartService().getCart(SESSION).itemCount).toBe(1);
    expect(redirect).not.toHaveBeenCalled();
  });

  test("no session cookie returns EMPTY_CART and sets no cookie", async () => {
    const state = await placeOrder(null, checkoutForm(MOCK_CARDS.success));
    expect(state?.error.code).toBe("EMPTY_CART");
    expect(fakeStore.setCalls).toEqual([]);
    expect(orderCount()).toBe(0);
  });
});
