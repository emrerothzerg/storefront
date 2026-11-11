import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";

// T110 v2 behaviour of /orders/[id]; the MVP (T25) suite stays in page.test.tsx.
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
const TOTE = "prod_canvas-tote-bag";
const HOSTILE = '<img src=x onerror="alert(1)">';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");

let orderA = "";
let orderB = "";

function setCookie(id: string | null): void {
  fakeStore = new FakeCookieStore();
  if (id !== null) fakeStore.jar.set(session.SESSION_COOKIE_NAME, id);
}

async function renderPage(id: string, searchParams: Record<string, string | string[]> = {}) {
  return render(await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve(searchParams) }));
}

async function notFoundError(id: string): Promise<unknown> {
  try {
    await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ placed: "1" }) });
  } catch (e) {
    return e;
  }
  return null;
}

beforeAll(async () => {
  closeDatabase();
  seedDatabase(getDatabase());
  const carts = createCartService();
  const svc = getOrderService();
  const card = { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada" };
  const address = { fullName: "Ada Lovelace", email: "ada@example.com", line1: "1 Analytical Way", city: "London", region: "LDN", postalCode: "N1 9GU", country: "GB" };
  if (!carts.addItem(A, TOTE, 1).ok) throw new Error("add");
  const a = await svc.placeOrderV2({ sessionId: A, address, card, idempotencyKey: "t110-detail-a", deliveryNote: "Leave by the door" });
  if (!a.ok) throw new Error(a.error.code);
  orderA = a.value.id;
  if (!carts.addItem(B, TOTE, 1).ok) throw new Error("add");
  const b = await svc.placeOrderV2({ sessionId: B, address, card, idempotencyKey: "t110-detail-b" });
  if (!b.ok) throw new Error(b.error.code);
  orderB = b.value.id;
  getDatabase().run("UPDATE orders SET full_name = ? WHERE id = ?", [HOSTILE, orderA]);
});

afterEach(() => {
  setCookie(null);
  getOrCreateSpy.mockClear();
});

afterAll(() => {
  getOrCreateSpy.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/orders/[id] v2 (T110)", () => {
  test("metadata: Order #short, noindex, no canonical; malformed ids never echoed", async () => {
    const m = await generateMetadata({ params: Promise.resolve({ id: orderA }) });
    expect(m.title).toBe(`Order #${orderA.slice(0, 8).toUpperCase()}`);
    expect(m.robots).toEqual({ index: false, follow: false });
    expect(m.alternates).toBeUndefined();
    expect((await generateMetadata({ params: Promise.resolve({ id: "<script>" }) })).title).toBe("Order");
    expect((await generateMetadata()).title).toBe("Order");
  });

  test("detail variant: one h1 with the order id, breadcrumb, timeline says simulated, invoice link, cancel form", async () => {
    setCookie(A);
    const { container } = await renderPage(orderA);
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent(`Order # ${orderA}`);
    expect(screen.queryByText("Order placed", { selector: "h1" })).toBeNull();

    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumb).toHaveTextContent("Home");
    expect(crumb.querySelector('a[href="/orders"]')).toHaveTextContent("Your Orders");
    expect(crumb).toHaveTextContent(`Order #${orderA.slice(0, 8).toUpperCase()}`);

    expect(screen.getByText("Tracking is simulated in this demo store.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Print invoice" })).toHaveAttribute("href", `/orders/${orderA}/invoice`);
    expect(screen.getByText(/You can cancel for \d+ more minutes?\./)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Order summary" })).toHaveAttribute("data-total-check", "match");
    expect(container.textContent).toContain("Leave by the door");

    // Hostile name renders as text.
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.textContent).toContain(HOSTILE);

    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    const html = container.innerHTML;
    expect(html).not.toContain(A);
    expect(html).not.toContain("ada@example.com");
    expect(html).not.toContain("t110-detail");
    for (const match of html.match(UUID_RE) ?? []) expect(match).toBe(orderA);
    expect(fakeStore.setCalls).toEqual([]);
    expect(getOrCreateSpy).not.toHaveBeenCalled();
  });

  test("?placed=1: confirmation heading only; title/metadata unchanged", async () => {
    setCookie(A);
    await renderPage(orderA, { placed: "1" });
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Order placed");
    expect(screen.getByText(/Thank you for your order/)).toBeInTheDocument();
  });

  test("garbage placed / notice values are ignored; a valid notice shows a warning", async () => {
    setCookie(A);
    const first = await renderPage(orderA, { placed: ["1", "1"], notice: "<b>x</b>" });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(`Order # ${orderA}`);
    expect(screen.queryByRole("alert")).toBeNull();
    first.unmount();
    await renderPage(orderA, { notice: "address_full" });
    expect(screen.getByRole("alert")).toHaveTextContent("Your address book is full");
  });

  test("not owner / unknown / malformed / no cookie: one identical notFound path", async () => {
    const errors: unknown[] = [];
    setCookie(B);
    errors.push(await notFoundError(orderA));
    setCookie(A);
    errors.push(await notFoundError(orderB));
    errors.push(await notFoundError("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    errors.push(await notFoundError("nope"));
    setCookie(null);
    errors.push(await notFoundError(orderA));
    for (const e of errors) {
      expect(e).toBeInstanceOf(NotFoundSentinel);
      expect((e as Error).message).toBe("NEXT_NOT_FOUND (test sentinel)");
    }
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
        expect(await notFoundError(id)).toBeInstanceOf(NotFoundSentinel);
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

  test("repeated renders persist each fulfilment event at most once", async () => {
    setCookie(A);
    for (let i = 0; i < 5; i++) (await renderPage(orderA)).unmount();
    const rows = getDatabase()
      .query<{ status: string; n: number }, [string]>("SELECT status, COUNT(*) AS n FROM order_events WHERE order_id = ? GROUP BY status")
      .all(orderA);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.n).toBe(1);
  });
});
