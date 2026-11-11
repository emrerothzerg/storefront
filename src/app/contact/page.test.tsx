import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// next/headers mock (process-wide in bun test): a fake cookie jar whose `set`
// and `delete` are spies, so the test proves render never mints a session.
// Registered before the page (and the session module) is imported.
// ---------------------------------------------------------------------------

class FakeCookieStore {
  readonly jar = new Map<string, string>();
  readonly set = mock((name: string, value?: string) => void [name, value]);
  readonly delete = mock((name: string) => void name);

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }
}

let fakeStore = new FakeCookieStore();

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedProducts } = await import("@/server/db/seed");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { createCartService } = await import("@/server/cart/cart-service");
const { createOrderService } = await import("@/server/orders/order-service");
const { MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
const { isAllowedInternalHref } = await import("@/content/routes");
const { default: Page, metadata } = await import("./page");

const SESSION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-bbbb-4bbb-9bbb-bbbbbbbbbbbb";
const SESSION_EMPTY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOTE = "prod_canvas-tote-bag";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const ADDRESS = {
  fullName: "Ada Lovelace",
  email: "ada-contact-test@example.com",
  line1: "1 Analytical Way",
  line2: "",
  city: "London",
  region: "LDN",
  postalCode: "N1 9GU",
  country: "gb",
};

let ordersA: string[] = [];
let orderB = "";

async function placeFor(sessionId: string, key: string): Promise<string> {
  const added = createCartService().addItem(sessionId, TOTE, 1);
  if (!added.ok) throw new Error(`addItem failed: ${added.error.code}`);
  const placed = await createOrderService().placeOrder({
    sessionId,
    address: ADDRESS,
    card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" },
    idempotencyKey: key,
  });
  if (!placed.ok) throw new Error(`placeOrder failed: ${placed.error.code}`);
  return placed.value.id;
}

beforeAll(async () => {
  closeDatabase();
  seedProducts(getDatabase());
  ordersA = [await placeFor(SESSION_A, "t101-a1"), await placeFor(SESSION_A, "t101-a2")];
  orderB = await placeFor(SESSION_B, "t101-b1");
});

afterEach(() => {
  cleanup();
  fakeStore = new FakeCookieStore();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

function withCookie(sessionId: string | null): void {
  fakeStore = new FakeCookieStore();
  if (sessionId !== null) fakeStore.jar.set(SESSION_COOKIE_NAME, sessionId);
}

async function renderContact(search: Record<string, string | string[] | undefined> = {}) {
  return render(await Page({ searchParams: Promise.resolve(search) }));
}

function orderSelect(): HTMLSelectElement | null {
  return document.querySelector('select[name="orderId"]');
}

function expectNoCookieWrites(): void {
  expect(fakeStore.set).not.toHaveBeenCalled();
  expect(fakeStore.delete).not.toHaveBeenCalled();
}

describe("/contact metadata (criterion 4)", () => {
  test("noindex with canonical /contact", () => {
    expect(metadata.title).toBe("Contact us");
    expect(metadata.robots).toMatchObject({ index: false });
    expect(String(metadata.alternates?.canonical)).toMatch(/\/contact$/);
  });
});

describe("/contact page", () => {
  test("one h1, breadcrumb, BreadcrumbList JSON-LD, safe links", async () => {
    withCookie(null);
    const { container } = await renderContact();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Contact us");
    const crumbs = screen.getByRole("navigation", { name: /breadcrumb/i });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    const ld = JSON.parse(container.querySelector('script[type="application/ld+json"]')?.textContent ?? "null");
    expect(ld).toMatchObject({ "@type": "BreadcrumbList", itemListElement: [{ name: "Home" }, { name: "Contact us" }] });
    for (const a of Array.from(container.querySelectorAll("a[href]"))) {
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) expect(container.querySelector(`[id="${href.slice(1)}"]`)).not.toBeNull();
      else expect(isAllowedInternalHref(href)).toBe(true);
    }
  });

  test("criterion 2: no cookie -> form without order select, no session minted", async () => {
    withCookie(null);
    const { container } = await renderContact({ topic: "order", order: ordersA[0] });
    expect(container.querySelector("form")).not.toBeNull();
    expect(orderSelect()).toBeNull();
    expectNoCookieWrites();
    expect(container.innerHTML.match(UUID_RE)).toBeNull();
  });

  test("garbage cookie behaves like no cookie and is not replaced during render", async () => {
    withCookie("not-a-uuid");
    await renderContact();
    expect(orderSelect()).toBeNull();
    expectNoCookieWrites();
  });

  test("criterion 2: with a cookie, the select lists only own orders", async () => {
    withCookie(SESSION_A);
    const { container } = await renderContact();
    const select = orderSelect();
    expect(select).not.toBeNull();
    const values = Array.from(select?.options ?? []).map((o) => o.value).filter((v) => v !== "");
    expect(new Set(values)).toEqual(new Set(ordersA));
    expect(values).not.toContain(orderB);
    for (const option of Array.from(select?.options ?? []).filter((o) => o.value !== "")) {
      expect(option.textContent).toMatch(/^Order #[0-9A-F]{8} · [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    }
    expectNoCookieWrites();

    // No owner key, foreign order id or checkout email anywhere in the markup.
    const html = container.innerHTML;
    for (const uuid of html.match(UUID_RE) ?? []) expect(ordersA).toContain(uuid.toLowerCase());
    expect(html).not.toContain(SESSION_A);
    expect(html).not.toContain(ADDRESS.email);
  });

  test("own order from ?topic=order&order=<id> is preselected", async () => {
    withCookie(SESSION_A);
    await renderContact({ topic: "order", order: ordersA[1] });
    expect(orderSelect()?.value).toBe(ordersA[1]);
    const topic = document.querySelector<HTMLSelectElement>('select[name="topic"]');
    expect(topic?.value).toBe("ordering");
  });

  test("criterion 2: forged foreign order id is ignored", async () => {
    withCookie(SESSION_A);
    const { container } = await renderContact({ topic: "ordering", order: orderB });
    expect(orderSelect()?.value).toBe("");
    expect(container.innerHTML).not.toContain(orderB);
  });

  test("session without orders: no select", async () => {
    withCookie(SESSION_EMPTY);
    await renderContact({ order: ordersA[0] });
    expect(orderSelect()).toBeNull();
    expectNoCookieWrites();
  });

  test("?topic=product&ref=<slug> posts the slug as a hidden field; bad refs dropped", async () => {
    withCookie(null);
    const ok = await renderContact({ topic: "product", ref: "canvas-tote-bag" });
    expect(ok.container.querySelector('input[type="hidden"][name="productSlug"]')).toHaveAttribute("value", "canvas-tote-bag");
    expect(document.querySelector<HTMLSelectElement>('select[name="topic"]')?.value).toBe("product");
    ok.unmount();

    const bad = await renderContact({ topic: "product", ref: "\"><script>alert(1)</script>" });
    expect(bad.container.querySelector('input[name="productSlug"]')).toBeNull();
    expect(bad.container.querySelector("script:not([type])")).toBeNull();
  });

  test("hostile topic/order/ref values never throw and are dropped", async () => {
    withCookie(SESSION_A);
    const hostile: Record<string, string | string[]>[] = [
      { topic: "__proto__", order: "' OR 1=1 --", ref: "../../etc/passwd" },
      { topic: "x".repeat(50_000), order: "x".repeat(50_000), ref: "x".repeat(50_000) },
      { topic: ["product", "order"], order: [orderB, ordersA[0] ?? ""], ref: ["Bad Slug"] },
      { topic: "\u0000​", order: orderB.toUpperCase() },
    ];
    for (const search of hostile) {
      const r = await renderContact(search);
      expect(r.container.querySelectorAll("h1")).toHaveLength(1);
      expect(r.container.innerHTML).not.toContain(orderB);
      expect(r.container.querySelector('input[name="productSlug"]')).toBeNull();
      r.unmount();
    }
    expectNoCookieWrites();
  });
});
