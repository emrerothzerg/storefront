import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// next/* mocks: registered before `./page` is imported; delegate to per-test state.
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
  delete(name: string): void {
    this.setCalls.push(`delete:${name}`);
  }
}

let fakeStore = new FakeCookieStore();
const realNavigation = { ...(await import("next/navigation")) };
mock.module("next/headers", () => ({ cookies: async (): Promise<FakeCookieStore> => fakeStore }));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));
mock.module("next/navigation", () => ({
  ...realNavigation,
  notFound: (): never => {
    throw new Error("unexpected notFound");
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
const PIN = "prod_enamel-pin-set";
const HOSTILE = '<img src=x onerror="alert(1)">';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const readSessionIdSpy = spyOn(session, "readSessionId");
const getOrCreateSpy = spyOn(session, "getOrCreateSessionId");

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Analytical Way",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "GB",
};

let orderA = "";
let orderB = "";

async function place(owner: string, productId: string, qty: number, key: string): Promise<string> {
  const added = createCartService().addItem(owner, productId, qty);
  if (!added.ok) throw new Error(added.error.code);
  const r = await getOrderService().placeOrderV2({
    sessionId: owner,
    address: ADDRESS,
    card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada" },
    idempotencyKey: key,
  });
  if (!r.ok) throw new Error(r.error.code);
  return r.value.id;
}

function setCookie(id: string | null): void {
  fakeStore = new FakeCookieStore();
  if (id !== null) fakeStore.jar.set(session.SESSION_COOKIE_NAME, id);
}

async function renderPage(params: Record<string, string | string[]> = {}) {
  return render(await Page({ searchParams: Promise.resolve(params) }));
}

function expectSafeMarkup(container: HTMLElement, allowedIds: readonly string[]): void {
  const anchors = [...container.querySelectorAll("a[href]")];
  for (const a of anchors) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  const html = container.innerHTML;
  expect(html).not.toContain(A);
  expect(html).not.toContain(B);
  expect(html).not.toContain("ada@example.com");
  expect(html).not.toContain("t110-page");
  for (const match of html.match(UUID_RE) ?? []) expect(allowedIds).toContain(match);
}

beforeAll(async () => {
  closeDatabase();
  seedDatabase(getDatabase());
  orderA = await place(A, TOTE, 2, "t110-page-a");
  orderB = await place(B, PIN, 1, "t110-page-b");
  getDatabase().run("UPDATE orders SET full_name = ? WHERE id = ?", [HOSTILE, orderA]);
});

afterEach(() => {
  setCookie(null);
  readSessionIdSpy.mockClear();
  getOrCreateSpy.mockClear();
});

afterAll(() => {
  readSessionIdSpy.mockRestore();
  getOrCreateSpy.mockRestore();
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/orders page", () => {
  test("metadata: Your Orders, noindex", async () => {
    const m = await generateMetadata();
    expect(m.title).toBe("Your Orders");
    expect(m.robots).toEqual({ index: false, follow: false });
  });

  test("no cookie: 200 empty state, one h1, breadcrumb, only readSessionId, no cookie write", async () => {
    const before = getDatabase().query<{ n: number }, []>("SELECT count(*) AS n FROM orders").get()?.n;
    const { container } = await renderPage();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your orders");
    expect(screen.getByText("No orders yet")).toBeInTheDocument();
    const crumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(crumb).getByText("Your Orders")).toBeInTheDocument();
    expect(readSessionIdSpy).toHaveBeenCalled();
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
    expect(getDatabase().query<{ n: number }, []>("SELECT count(*) AS n FROM orders").get()?.n).toBe(before);
    expectSafeMarkup(container, []);
  });

  test("garbage cookie / unknown owner: empty state, never 404, no cookie write", async () => {
    setCookie("not-a-session");
    await renderPage({ tab: "buy-again" });
    expect(screen.getByText("Nothing to buy again yet")).toBeInTheDocument();
    setCookie("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    await renderPage({ tab: "<x>", range: "zzz", page: "-3" });
    expect(screen.getAllByText("No orders yet").length).toBeGreaterThan(0);
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("owner A: only A's orders; hostile ship-to name rendered as text; safe markup", async () => {
    setCookie(A);
    const { container } = await renderPage({ tab: "orders", range: "garbage", page: "abc" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const html = container.innerHTML;
    expect(html).toContain(orderA);
    expect(html).not.toContain(orderB);
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
    expect(screen.getByRole("link", { name: /Orders/, current: "page" })).toBeInTheDocument();
    expectSafeMarkup(container, [orderA]);
    expect(fakeStore.setCalls).toEqual([]);
  });

  test("search with no match shows the filtered empty state", async () => {
    setCookie(A);
    await renderPage({ q: "definitely-not-a-product" });
    expect(screen.getByText("No orders found")).toBeInTheDocument();
  });

  test("buy again tab: grid with one add-to-cart form per in-stock product", async () => {
    setCookie(A);
    const { container } = await renderPage({ tab: "buy-again" });
    const grid = screen.getByRole("list", { name: "Products to buy again" });
    expect(within(grid).getAllByRole("listitem")).toHaveLength(1);
    expect(within(grid).getByRole("button", { name: /Add to cart/ })).toBeInTheDocument();
    const hidden = container.querySelector('input[name="productId"]');
    expect(hidden).toHaveAttribute("value", TOTE);
    expectSafeMarkup(container, []);
  });
});
