import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

class NotFoundSentinel extends Error {
  constructor() {
    super("NEXT_NOT_FOUND (test sentinel)");
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly setCalls: string[] = [];
  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }
  set(name: string): void {
    this.setCalls.push(name);
  }
}

let fakeStore = new FakeCookieStore();
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({ cookies: async (): Promise<FakeCookieStore> => fakeStore }));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
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
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { createCartService } = await import("@/server/cart/cart-service");
const { getOrderService } = await import("@/server/orders/order-service");
const { MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
const { isAllowedInternalHref } = await import("@/content/routes");
const { default: Page, generateMetadata } = await import("./page");

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const TOTE = "prod_canvas-tote-bag"; // 1999
const HOSTILE = '<script>alert("x")</script>';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

let orderA = "";
let orderB = "";

function setCookie(id: string | null): void {
  fakeStore = new FakeCookieStore();
  if (id !== null) fakeStore.jar.set(session.SESSION_COOKIE_NAME, id);
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

beforeAll(async () => {
  closeDatabase();
  seedDatabase(getDatabase());
  const carts = createCartService();
  const svc = getOrderService();
  const card = { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada" };
  const address = { fullName: "Ada Lovelace", email: "ada@example.com", line1: "1 Analytical Way", line2: "Flat 2", city: "London", region: "LDN", postalCode: "N1 9GU", country: "GB" };

  if (!carts.addItem(A, TOTE, 1).ok) throw new Error("add");
  if (!carts.applyCoupon(A, "welcome10").ok) throw new Error("coupon");
  if (!carts.selectShippingMethod(A, "express").ok) throw new Error("ship");
  const a = await svc.placeOrderV2({ sessionId: A, address, card, idempotencyKey: "t110-inv-a" });
  if (!a.ok) throw new Error(a.error.code);
  orderA = a.value.id;

  if (!carts.addItem(B, TOTE, 1).ok) throw new Error("add");
  const b = await svc.placeOrderV2({ sessionId: B, address, card, idempotencyKey: "t110-inv-b" });
  if (!b.ok) throw new Error(b.error.code);
  orderB = b.value.id;

  getDatabase().run("UPDATE orders SET line1 = ? WHERE id = ?", [HOSTILE, orderA]);
});

afterEach(() => setCookie(null));

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/orders/[id]/invoice", () => {
  test("metadata: Invoice · Order #…, noindex, no canonical, no full id", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: orderA }) });
    expect(m.title).toBe(`Invoice · Order #${orderA.slice(0, 8).toUpperCase()}`);
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.alternates).toBeUndefined();
    expect(JSON.stringify(m)).not.toContain(orderA);
    const bad = await generateMetadata({ params: Promise.resolve({ id: "<b>x</b>" }) });
    expect(bad.title).toBe("Invoice · Order");
  });

  test("owner: one h1, full invoice header, snapshot totals, back link, no forms/buttons", async () => {
    setCookie(A);
    getDatabase().run("UPDATE products SET price_cents = 1 WHERE id = ?", [TOTE]);
    const { container } = await renderPage(orderA);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(`Invoice for order #${orderA.slice(0, 8).toUpperCase()}`);

    const summary = screen.getByRole("region", { name: "Invoice" });
    expect(summary).toHaveAttribute("data-variant", "invoice");
    expect(summary).toHaveAttribute("data-total-check", "match");
    const header = within(summary).getByTestId("order-summary-invoice");
    expect(ddValue(header, "Order number")).toHaveTextContent(orderA);
    expect(ddValue(header, "Order placed").textContent).not.toBe("");
    expect(ddValue(header, "Status")).toHaveTextContent("Paid");
    expect(ddValue(header, "Payment")).toHaveTextContent("Paid with card ending in 4242");
    expect(ddValue(header, "Bill to")).toHaveTextContent("Ada Lovelace");
    expect(ddValue(header, "Ship to")).toHaveTextContent("Flat 2");
    expect(ddValue(header, "Ship to")).toHaveTextContent(HOSTILE);
    expect(container.querySelector("script")).toBeNull();

    expect(summary).toHaveTextContent("Canvas Tote Bag × 1");
    expect(ddValue(summary, "Subtotal")).toHaveTextContent("$19.99");
    expect(within(summary).getByTestId("order-discount")).toHaveTextContent("$1.99");
    expect(summary).toHaveTextContent("Discount (WELCOME10)");
    expect(ddValue(summary, "Shipping")).toHaveTextContent("$9.99");
    expect(ddValue(summary, "Total")).toHaveTextContent("$27.99");

    expect(screen.getByRole("link", { name: "Back to order" })).toHaveAttribute("href", `/orders/${orderA}`);
    // D-T171-1: standalone link -> 44px target.
    expect(screen.getByRole("link", { name: "Back to order" }).className.split(/\s+/)).toEqual(
      expect.arrayContaining(["inline-flex", "min-h-touch", "items-center"]),
    );
    expect(container.querySelectorAll("form, button, input")).toHaveLength(0);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);

    const html = container.innerHTML;
    expect(html).not.toContain(A);
    expect(html).not.toContain("ada@example.com");
    expect(html).not.toContain("t110-inv");
    for (const match of html.match(UUID_RE) ?? []) expect(match).toBe(orderA);
    expect(fakeStore.setCalls).toEqual([]);
    getDatabase().run("UPDATE products SET price_cents = 1999 WHERE id = ?", [TOTE]);
  });

  test("404 via the same path: other owner, no cookie, garbage cookie, unknown, malformed", async () => {
    setCookie(B);
    await expectNotFound(orderA);
    setCookie(A);
    await expectNotFound(orderB);
    await expectNotFound("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await expectNotFound(orderA.toUpperCase());
    await expectNotFound("' OR 1=1 --");
    setCookie(null);
    await expectNotFound(orderA);
    setCookie("garbage");
    await expectNotFound(orderA);
    expect(fakeStore.setCalls).toEqual([]);
  });
  test("D-T110-1: malformed ids 404 before any session read or DB query (cookie present)", async () => {
    setCookie(A);
    const readSpy = spyOn(session, "readSessionId");
    const database = getDatabase();
    const q = spyOn(database, "query");
    const p = spyOn(database, "prepare");
    try {
      for (const id of ["nope", "' OR 1=1 --", "", "%s".repeat(50), "cccccccc-cccc-4ccc-8ccc-cccccccccccc".toUpperCase()]) {
        await expectNotFound(id);
      }
      expect(readSpy).toHaveBeenCalledTimes(0);
      expect(q.mock.calls.length + p.mock.calls.length).toBe(0);
      // Control: a well-formed id does read the session.
      (await renderPage(orderA)).unmount();
      expect(readSpy).toHaveBeenCalledTimes(1);
    } finally {
      readSpy.mockRestore();
      q.mockRestore();
      p.mockRestore();
    }
    expect(fakeStore.setCalls).toEqual([]);
  });
});
