import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// next/headers + next/cache mocks, registered before `./orders` is imported
// (mock.module is process-wide; same pattern as views.test.ts / cart.test.ts).

interface SetCall {
  readonly name: string;
  readonly value: string;
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: SetCall[] = [];

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string): void {
    this.setCalls.push({ name, value });
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
const { getCartService } = await import("@/server/cart/cart-service");
const { getOrderService } = await import("@/server/orders/order-service");
const { MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
const wired = await import("./orders");
const { cancelOrder, buyAgain, buyAgainFromForm } = wired;

const A = "33333333-3333-4333-8333-333333333333";
const B = "44444444-4444-4444-8444-444444444444";
const TOTE = "prod_canvas-tote-bag";
const MISSING_ORDER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function placeOrder(session: string, qty: number): Promise<string> {
  const added = getCartService().addItem(session, TOTE, qty);
  if (!added.ok) throw new Error("addItem failed");
  const placed = await getOrderService().placeOrderV2({
    sessionId: session,
    address: {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      line1: "1 Analytical Way",
      city: "London",
      region: "LDN",
      postalCode: "N1 9GU",
      country: "GB",
    },
    card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" },
    idempotencyKey: "key-" + crypto.randomUUID(),
  });
  if (!placed.ok) throw new Error("placeOrderV2 failed: " + placed.error.code);
  return placed.value.id;
}

function cartQty(session: string): number {
  return getCartService().getCart(session).items.find((i) => i.productId === TOTE)?.quantity ?? 0;
}

beforeEach(() => {
  closeDatabase();
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
  test("exports only async functions", () => {
    const names = Object.keys(wired).sort();
    expect(names).toEqual(["buyAgain", "buyAgainFromForm", "cancelOrder"]);
    for (const name of names) {
      const value: unknown = wired[name as keyof typeof wired];
      expect((value as () => unknown).constructor.name).toBe("AsyncFunction");
    }
  });
});

describe("order actions (wired)", () => {
  test("no cookie: ORDER_NOT_FOUND and no session cookie is created (both actions)", async () => {
    const c = await cancelOrder(null, form({ orderId: MISSING_ORDER, confirm: "yes" }));
    const b = await buyAgain(null, form({ orderId: MISSING_ORDER }));
    expect(c).toMatchObject({ ok: false, error: { code: "ORDER_NOT_FOUND" } });
    expect(b).toMatchObject({ ok: false, error: { code: "ORDER_NOT_FOUND" } });
    expect(fakeStore.setCalls).toEqual([]);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  test("cancel with the owner's cookie; second submit not cancellable; stock restored once", async () => {
    const orderId = await placeOrder(A, 2);
    const stockOf = () =>
      (getDatabase().query("SELECT stock FROM products WHERE id = ?").get(TOTE) as { stock: number }).stock;
    const before = stockOf();
    fakeStore.jar.set(SESSION_COOKIE_NAME, A);
    const first = await cancelOrder(null, form({ orderId, confirm: "yes" }));
    expect(first).toMatchObject({ ok: true, kind: "cancelled" });
    const second = await cancelOrder(first, form({ orderId, confirm: "yes" }));
    expect(second).toMatchObject({ ok: false, error: { code: "ORDER_NOT_CANCELLABLE" } });
    expect(stockOf()).toBe(before + 2);
    expect(revalidatePath.mock.calls).toEqual([["/orders"], [`/orders/${orderId}`], ["/", "layout"]]);
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("foreign cookie cannot cancel or buy again", async () => {
    const orderId = await placeOrder(A, 1);
    fakeStore.jar.set(SESSION_COOKIE_NAME, B);
    expect(await cancelOrder(null, form({ orderId, confirm: "yes", sessionId: A }))).toMatchObject({
      error: { code: "ORDER_NOT_FOUND" },
    });
    expect(await buyAgain(null, form({ orderId, sessionId: A }))).toMatchObject({ error: { code: "ORDER_NOT_FOUND" } });
    expect(cartQty(B)).toBe(0);
  });

  test("buyAgain and buyAgainFromForm add the snapshot quantity to the owner's cart", async () => {
    const orderId = await placeOrder(A, 2);
    fakeStore.jar.set(SESSION_COOKIE_NAME, A);
    const state = await buyAgain(null, form({ orderId, quantity: "40" }));
    expect(state).toMatchObject({ ok: true, kind: "buy_again", message: "Added 1 of 1 item to your cart." });
    expect(cartQty(A)).toBe(2);
    expect(await buyAgainFromForm(form({ orderId }))).toMatchObject({ ok: true, kind: "buy_again" });
    expect(cartQty(A)).toBe(4);
    expect(revalidatePath).toHaveBeenCalledWith("/cart");
    expect(fakeStore.setCalls).toEqual([]);
  });
});
