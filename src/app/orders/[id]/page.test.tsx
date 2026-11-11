import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// next/headers + next/navigation mocks. mock.module is process-wide in bun
// test, so the mocks live in this one file, are registered before `./page` is
// imported, and delegate to per-test state.
// ---------------------------------------------------------------------------

class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (test sentinel)");
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
}

let fakeStore = new FakeCookieStore();

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
// Keep every real export (e.g. `unstable_rethrow`, used by other modules in
// the same test process) and only replace `notFound`.
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new NotFoundSentinel();
  },
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedProducts } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { createCartService } = await import("@/server/cart/cart-service");
const { OrderService, createOrderService } = await import("@/server/orders/order-service");
const { MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
const { default: Page, generateMetadata } = await import("./page");

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const TOTE = "prod_canvas-tote-bag"; // 1999
const PIN = "prod_enamel-pin-set"; // 50

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  line2: "",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "gb",
};

function card(number: string) {
  return { number, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" };
}

function count(table: "orders" | "order_items" | "cart_items" | "products"): number {
  return getDatabase().query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

function snapshotCounts() {
  return {
    orders: count("orders"),
    orderItems: count("order_items"),
    cartItems: count("cart_items"),
    products: count("products"),
  };
}

function setCookie(sessionId: string | null): void {
  fakeStore = new FakeCookieStore();
  if (sessionId !== null) fakeStore.jar.set(SESSION_COOKIE_NAME, sessionId);
}

async function renderPage(id: string) {
  return render(await Page({ params: Promise.resolve({ id }) }));
}

async function expectNotFound(id: string): Promise<void> {
  let thrown: unknown = null;
  try {
    await Page({ params: Promise.resolve({ id }) });
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(NotFoundSentinel);
}

function ddValue(section: HTMLElement, label: string): HTMLElement {
  const dt = within(section).getByText(label, { selector: "dt" });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no dd for ${label}`);
  return dd;
}

let paidId = "";
let failedId = "";

beforeAll(async () => {
  closeDatabase();
  seedProducts(getDatabase());
  const carts = createCartService();
  const orders = createOrderService();

  for (const [productId, qty] of [[TOTE, 2], [PIN, 3]] as const) {
    const added = carts.addItem(SESSION_A, productId, qty);
    if (!added.ok) throw new Error(`addItem failed: ${added.error.code}`);
  }
  const paid = await orders.placeOrder({
    sessionId: SESSION_A,
    address: ADDRESS,
    card: card(MOCK_CARDS.success),
    idempotencyKey: "t25-paid-key",
  });
  if (!paid.ok) throw new Error(`paid order failed: ${paid.error.code}`);
  paidId = paid.value.id;

  const added = carts.addItem(SESSION_A, TOTE, 1);
  if (!added.ok) throw new Error(`addItem failed: ${added.error.code}`);
  const failed = await orders.placeOrder({
    sessionId: SESSION_A,
    address: ADDRESS,
    card: card(MOCK_CARDS.declined),
    idempotencyKey: "t25-failed-key",
  });
  if (failed.ok) throw new Error("expected the declined card to fail");
  const failedOrderId = failed.error.details?.orderId;
  if (typeof failedOrderId !== "string") throw new Error("no orderId on PAYMENT_FAILED");
  failedId = failedOrderId;
});

afterEach(() => {
  setCookie(null);
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/orders/[id] page", () => {
  test("metadata title is static and never contains the order id", async () => {
    // T110: title is "Order #<first 8 chars>" (was the static "Order confirmation").
    const metadata = await generateMetadata({ params: Promise.resolve({ id: paidId }) });
    expect(metadata.title).toBe(`Order #${paidId.slice(0, 8).toUpperCase()}`);
    expect(metadata.robots).toEqual({ index: false, follow: false });
    // No path: neither the canonical nor the OG url can carry the order id.
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty("url");
    expect(JSON.stringify(metadata)).not.toContain(paidId);
  });

  test("paid order: one h1, order number, Paid badge text, items, totals, address, payment, continue link", async () => {
    setCookie(SESSION_A);
    const before = snapshotCounts();
    const { container } = await renderPage(paidId);

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    // T110: detail variant heading is "Order # <id>" (was "Thank you for your order").
    expect(h1s[0]).toHaveTextContent(`Order # ${paidId}`);
    expect(container.querySelector("main")).toBeNull();

    // T110: the short number lives in the breadcrumb (was "Order <short>").
    expect(screen.getByText(`Order #${paidId.slice(0, 8).toUpperCase()}`)).toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();

    const summary = screen.getByRole("region", { name: "Order summary" });
    expect(within(summary).getByRole("heading", { level: 2, name: "Order summary" })).toBeInTheDocument();
    const lines = within(summary).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(summary).toHaveTextContent("Canvas Tote Bag × 2");
    expect(summary).toHaveTextContent("Enamel Pin Set × 3");
    expect(ddValue(summary, "Subtotal")).toHaveTextContent("$41.48");
    expect(ddValue(summary, "Shipping")).toHaveTextContent("Free");
    expect(ddValue(summary, "Total")).toHaveTextContent("$41.48");

    // T110: OrderDetail names the region "Ship to" (was "Shipping address").
    const shipping = screen.getByRole("region", { name: "Ship to" });
    for (const line of ["Ada Lovelace", "1 Analytical Way", "London, LDN N1 9GU", "GB"]) {
      expect(within(shipping).getByText(line)).toBeInTheDocument();
    }
    // Empty line2 is omitted.
    expect(shipping.querySelectorAll("address p")).toHaveLength(4);

    // T110: OrderDetail names the region "Payment method" (was "Payment").
    const payment = screen.getByRole("region", { name: "Payment method" });
    expect(within(payment).getByText("Card ending in 4242")).toBeInTheDocument();

    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
    // D-T171-1: standalone link -> 44px target.
    expect(screen.getByRole("link", { name: "Continue shopping" }).className.split(/\s+/)).toEqual(
      expect.arrayContaining(["inline-flex", "min-h-touch", "items-center"]),
    );
    expect(screen.queryByRole("link", { name: "Try again" })).toBeNull();

    // Never render secrets.
    const html = container.innerHTML;
    expect(html).not.toContain(SESSION_A);
    expect(html).not.toContain("t25-paid-key");
    expect(html).not.toContain(MOCK_CARDS.success);

    expect(snapshotCounts()).toEqual(before);
  });

  test("snapshot prices: totals unchanged after the catalogue price changes", async () => {
    setCookie(SESSION_A);
    getDatabase().run("UPDATE products SET price_cents = 1");
    const before = snapshotCounts();
    await renderPage(paidId);
    const summary = screen.getByRole("region", { name: "Order summary" });
    expect(ddValue(summary, "Subtotal")).toHaveTextContent("$41.48");
    expect(ddValue(summary, "Total")).toHaveTextContent("$41.48");
    const lineTotals = within(summary).getAllByTestId("order-line-total").map((el) => el.textContent);
    expect(lineTotals).toEqual(["$39.98", "$1.50"]);
    expect(snapshotCounts()).toEqual(before);
  });

  test("reload / back-navigation re-renders the same confirmation with no writes", async () => {
    setCookie(SESSION_A);
    const before = snapshotCounts();
    // Text, not innerHTML: OrderSummary's useId-generated ids differ per mount.
    const firstRender = await renderPage(paidId);
    const first = firstRender.container.textContent;
    firstRender.unmount();
    for (let i = 0; i < 3; i++) {
      const again = await renderPage(paidId);
      expect(again.container.textContent).toBe(first);
      again.unmount();
    }
    expect(snapshotCounts()).toEqual(before);
  });

  test("failed order: Payment failed heading and badge, not-charged text, try-again link", async () => {
    setCookie(SESSION_A);
    const before = snapshotCounts();
    await renderPage(failedId);

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Payment failed");
    expect(screen.getByText("Payment failed", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("Your card was declined, so it was not charged.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute("href", "/checkout");
    expect(screen.getByText("Card ending in 0002")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
    expect(snapshotCounts()).toEqual(before);
  });

  describe("404 without revealing existence", () => {
    test("another session's cookie", async () => {
      setCookie(SESSION_B);
      await expectNotFound(paidId);
      await expectNotFound(failedId);
    });

    test("no cookie / garbage cookie", async () => {
      setCookie(null);
      await expectNotFound(paidId);
      fakeStore.jar.set(SESSION_COOKIE_NAME, "not-a-session");
      await expectNotFound(paidId);
    });

    test("unknown, well-formed UUID", async () => {
      setCookie(SESSION_A);
      await expectNotFound("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    });

    test("malformed ids never reach getOrder", async () => {
      setCookie(SESSION_A);
      const spy = spyOn(OrderService.prototype, "getOrder");
      try {
        const malformed = [
          "not-a-uuid",
          paidId.toUpperCase(),
          "' OR 1=1 --",
          `${paidId}' OR '1'='1`,
          "",
          `${paidId} `,
        ];
        for (const id of malformed) await expectNotFound(id);
        expect(spy).not.toHaveBeenCalled();

        // Control: a well-formed id does reach the service.
        await expectNotFound("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("orders row count is unchanged after all renders (only the 2 seeded orders exist)", () => {
    expect(count("orders")).toBe(2);
  });
});
