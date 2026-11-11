import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// next/headers + next/navigation + next/cache mocks. mock.module is
// process-wide in bun test, so the mocks are registered before `./page` is
// imported and delegate to per-test state. next/navigation spreads the real
// exports (keeping `unstable_rethrow`, used by CheckoutForm) and overrides
// only `redirect`.
// ---------------------------------------------------------------------------

class RedirectSentinel extends Error {
  constructor(readonly url: string) {
    super(`NEXT_REDIRECT ${url} (test sentinel)`);
  }
}

class FakeCookieStore {
  readonly jar = new Map<string, string>();

  get(name: string): { name: string; value: string } | undefined {
    const value = this.jar.get(name);
    return value === undefined ? undefined : { name, value };
  }

  set(name: string, value: string): void {
    this.jar.set(name, value);
  }
}

let fakeStore = new FakeCookieStore();
const realNavigation = { ...(await import("next/navigation")) };

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/navigation", () => ({
  ...realNavigation,
  redirect: (url: string): never => {
    throw new RedirectSentinel(url);
  },
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedProducts } = await import("@/server/db/seed");
const { createCartService } = await import("@/server/cart/cart-service");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { formatMoney } = await import("@/lib/money");
const pageModule = await import("./page");
const Page = pageModule.default;

const TOTE = "prod_canvas-tote-bag"; // 1999 cents, stock 42
const DESK = "prod_walnut-desk"; // 125000 cents, stock 3
const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const usd = (cents: number): string => formatMoney(cents, "USD");

function fillCart(): void {
  const cart = createCartService();
  expect(cart.addItem(SESSION, TOTE, 2).ok).toBe(true);
  expect(cart.addItem(SESSION, DESK, 1).ok).toBe(true);
  fakeStore.set(SESSION_COOKIE_NAME, SESSION);
}

/**
 * v2 (T109): an empty or blocked cart renders a 200 state linking to /cart
 * instead of redirecting. `Page()` would throw the RedirectSentinel if it
 * still redirected.
 */
async function expectCartState(title: string): Promise<void> {
  const { container } = render(await Page());
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getByText(title)).toBeInTheDocument();
  expect(screen.queryByRole("form", { name: "Checkout" })).toBeNull();
  expect(container.querySelector('a[href="/cart"]')).not.toBeNull();
}

function keyInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="hidden"][name="idempotencyKey"]');
  if (input === null) throw new Error("no idempotency key input");
  return input;
}

beforeEach(() => {
  closeDatabase();
  seedProducts(getDatabase());
  fakeStore = new FakeCookieStore();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/checkout page", () => {
  test("exports the page title metadata and is noindex", () => {
    expect(pageModule.metadata.title).toBe("Checkout");
    expect(pageModule.metadata.robots).toEqual({ index: false, follow: false });
  });

  test("renders one h1, the checkout form with a UUID key and the order summary", async () => {
    fillCart();
    const { container } = render(await Page());

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Checkout");
    expect(container.querySelector("main")).toBeNull();

    const form = screen.getByRole("form", { name: "Checkout" });
    expect(keyInput(form).value).toMatch(UUID_RE);
    expect(within(form).getByLabelText(/^Card number/)).toBeInTheDocument();

    const summary = screen.getByRole("region", { name: "Order summary" });
    expect(within(summary).getByRole("heading", { level: 3, name: "Order summary" })).toBeInTheDocument();
    const lines = within(summary).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    const tote = lines.find((li) => li.textContent?.includes("Canvas Tote Bag × 2"));
    const desk = lines.find((li) => li.textContent?.includes("Walnut Standing Desk × 1"));
    if (tote === undefined || desk === undefined) throw new Error("missing summary line");
    expect(within(tote).getByTestId("order-line-total")).toHaveTextContent(usd(3998));
    expect(within(desk).getByTestId("order-line-total")).toHaveTextContent(usd(125000));
    expect(within(summary).getAllByText(usd(128998)).length).toBeGreaterThan(0);
    expect(within(summary).getByText("Free")).toBeInTheDocument();
  });

  test("no session cookie renders the empty-cart state linking to /cart", async () => {
    await expectCartState("Your cart is empty");
  });

  test("an empty cart renders the empty-cart state linking to /cart", async () => {
    fakeStore.set(SESSION_COOKIE_NAME, SESSION);
    await expectCartState("Your cart is empty");
  });

  test("an unavailable line renders the blocked state linking to /cart", async () => {
    fillCart();
    getDatabase().run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    await expectCartState("Some items are unavailable");
  });

  test("a reduced line renders the blocked state linking to /cart", async () => {
    fillCart(); // desk quantity 1
    createCartService().setQuantity(SESSION, DESK, 3);
    getDatabase().run("UPDATE products SET stock = 2 WHERE id = ?", [DESK]);
    await expectCartState("Some items are unavailable");
  });

  test("two renders produce different idempotency keys", async () => {
    fillCart();
    const first = keyInput(render(await Page()).container).value;
    cleanup();
    const second = keyInput(render(await Page()).container).value;
    expect(first).toMatch(UUID_RE);
    expect(second).toMatch(UUID_RE);
    expect(second).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// v2 (T109): CheckoutForm v2 config built from the server cart view.
// ---------------------------------------------------------------------------

const { seedCoupons, seedShippingMethods } = await import("@/server/db/seed");
const { createAddressService } = await import("@/server/addresses/address-service");
const { isAllowedInternalHref } = await import("@/content/routes");

const OTHER_OWNER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANY_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HOSTILE = `<img src=x onerror="alert(1)">`;
const V2_FIELDS = [
  "idempotencyKey",
  "addressMode",
  "shippingMethodId",
  "deliveryNote",
  "saveAddress",
  "addressLabel",
  "phone",
  "email",
  "fullName",
  "line1",
  "line2",
  "city",
  "region",
  "postalCode",
  "country",
  "nameOnCard",
  "number",
  "expMonth",
  "expYear",
  "cvc",
] as const;

function saveAddress(owner: string, overrides: Record<string, string> = {}): string {
  const r = createAddressService({ db: getDatabase() }).create(owner, {
    fullName: "Grace Hopper",
    line1: "7 Compiler Road",
    line2: "",
    city: "Arlington",
    region: "VA",
    postalCode: "22201",
    country: "US",
    email: undefined,
    label: "Work",
    ...overrides,
  });
  if (!r.ok) throw new Error(`address create failed: ${JSON.stringify(r.error)}`);
  return r.value.id;
}

function v2Form(): HTMLFormElement {
  const form = screen.getByRole("form", { name: "Checkout" });
  if (!(form instanceof HTMLFormElement)) throw new Error("not a form");
  return form;
}

function expectSafeHrefs(container: HTMLElement): void {
  const anchors = [...container.querySelectorAll("a[href]")];
  expect(anchors.length).toBeGreaterThan(0);
  for (const a of anchors) {
    const href = a.getAttribute("href") ?? "";
    expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
  }
}

describe("/checkout page v2", () => {
  beforeEach(() => {
    seedShippingMethods(getDatabase());
    seedCoupons(getDatabase());
  });

  test("breadcrumb Home > Cart > Checkout, one h1, no nested forms, contract field names, total check match", async () => {
    const cart = createCartService();
    expect(cart.addItem(SESSION, TOTE, 1).ok).toBe(true); // 1999 + 499 standard shipping
    expect(cart.applyCoupon(SESSION, "WELCOME10").ok).toBe(true);
    fakeStore.set(SESSION_COOKIE_NAME, SESSION);
    const { container } = render(await Page());

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(crumbs).getByRole("link", { name: "Cart" })).toHaveAttribute("href", "/cart");
    expect(within(crumbs).getByText("Checkout")).toBeInTheDocument();

    const form = v2Form();
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelectorAll("form form")).toHaveLength(0);
    for (const name of V2_FIELDS) {
      expect({ name, present: form.querySelector(`[name="${name}"]`) !== null }).toEqual({ name, present: true });
    }
    expect(form.querySelector('input[name="addressMode"]')).toHaveAttribute("value", "new");
    expect(form.querySelectorAll('input[type="radio"][name="shippingMethodId"]')).toHaveLength(3);
    expect(form.querySelector('input[name="shippingMethodId"]:checked')).toHaveAttribute("value", "standard");

    const checks = [...container.querySelectorAll("[data-total-check]")];
    expect(checks.length).toBeGreaterThan(0);
    for (const el of checks) expect(el.getAttribute("data-total-check")).toBe("match");
    const view = cart.getCartView(SESSION);
    if (!view.ok) throw new Error("view");
    expect(view.value.totals.totalCents).toBe(1999 - 199 + 499);
    const summary = screen.getByRole("region", { name: "Order summary" });
    expect(within(summary).getAllByText(usd(view.value.totals.totalCents)).length).toBeGreaterThan(0);

    // No owner key in markup; the only UUID is the idempotency key.
    const html = container.innerHTML;
    expect(html).not.toContain(SESSION);
    expect(html.match(ANY_UUID_RE) ?? []).toEqual([keyInput(form).value]);
    expectSafeHrefs(container);
  });

  test("saved addresses: only the owner's book, hostile text rendered as text, no foreign data", async () => {
    fillCart();
    const own = saveAddress(SESSION, { fullName: HOSTILE, label: "Home" });
    const foreign = saveAddress(OTHER_OWNER, { fullName: "Mallory Foreign", line1: "1 Foreign Way" });
    const { container } = render(await Page());

    const form = v2Form();
    const radios = [...form.querySelectorAll<HTMLInputElement>('input[type="radio"][name="addressId"]')];
    expect(radios.map((r) => r.value)).toEqual([own]);
    expect(container.querySelector("img[src=x]")).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
    expect(container.innerHTML).not.toContain("Mallory");
    expect(container.innerHTML).not.toContain(foreign);
    expect(container.innerHTML).not.toContain(SESSION);
    expect(container.innerHTML).not.toContain(OTHER_OWNER);
    const uuids = new Set(container.innerHTML.match(ANY_UUID_RE) ?? []);
    expect([...uuids].sort()).toEqual([keyInput(form).value, own].sort());
    expectSafeHrefs(container);
  });

  test("a guest without a cookie sees no address data and no form", async () => {
    saveAddress(SESSION, { fullName: "Hidden Person" });
    const { container } = render(await Page());
    expect(screen.queryByRole("form", { name: "Checkout" })).toBeNull();
    expect(container.innerHTML).not.toContain("Hidden Person");
    expect(container.innerHTML.match(ANY_UUID_RE)).toBeNull();
    expectSafeHrefs(container);
  });

  test("blocked cart: 200 state, no form, safe links only", async () => {
    fillCart();
    getDatabase().run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    const { container } = render(await Page());
    expect(screen.getByText("Some items are unavailable")).toBeInTheDocument();
    expect(screen.getByText(/out of stock/)).toBeInTheDocument();
    expect(container.querySelector("form")).toBeNull();
    expectSafeHrefs(container);
  });

  test("a coupon dropped on this read shows its notice above the form", async () => {
    const cart = createCartService();
    expect(cart.addItem(SESSION, TOTE, 2).ok).toBe(true); // 3998 >= SAVE5 minimum 2500
    expect(cart.applyCoupon(SESSION, "SAVE5").ok).toBe(true);
    cart.setQuantity(SESSION, TOTE, 1); // 1999 < 2500
    fakeStore.set(SESSION_COOKIE_NAME, SESSION);
    render(await Page());
    expect(screen.getAllByRole("alert").some((el) => el.textContent?.includes("SAVE5"))).toBe(true);
    expect(v2Form()).toBeInTheDocument();
  });

  test("the page never sets a cookie", async () => {
    fillCart();
    const before = new Map(fakeStore.jar);
    render(await Page());
    cleanup();
    fakeStore = new FakeCookieStore();
    render(await Page());
    expect(fakeStore.jar.size).toBe(0);
    expect(before.get(SESSION_COOKIE_NAME)).toBe(SESSION);
  });
});

describe("/checkout page light-only pass (T170)", () => {
  function stateCard(noticeRole: "status" | "alert", title: string): HTMLElement {
    const notice = screen.getAllByRole(noticeRole).find((el) => el.textContent?.includes(title));
    if (notice === undefined) throw new Error(`no ${noticeRole} notice "${title}"`);
    const card = notice.parentElement;
    if (card === null) throw new Error("notice has no card");
    return card;
  }

  test("empty cart: info notice + primary pill to /cart on a sunken card", async () => {
    render(await Page());
    const card = stateCard("status", "Your cart is empty");
    expect(card.className).toContain("bg-surface-sunken");
    const link = within(card).getByRole("link", { name: "Go to your cart" });
    expect(link).toHaveAttribute("href", "/cart");
    for (const cls of ["rounded-full", "min-h-touch", "bg-accent"]) expect(link.className).toContain(cls);
  });

  test("blocked cart: warning notice keeps the message; pill 'Review your cart' on a sunken card", async () => {
    fillCart();
    getDatabase().run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    render(await Page());
    const card = stateCard("alert", "Some items are unavailable");
    expect(card.className).toContain("bg-surface-sunken");
    expect(within(card).getByRole("alert")).toHaveTextContent(/out of stock/);
    const link = within(card).getByRole("link", { name: "Review your cart" });
    expect(link).toHaveAttribute("href", "/cart");
    expect(link.className).toContain("rounded-full");
  });

  test("ready cart: no state card, the form renders", async () => {
    fillCart();
    const { container } = render(await Page());
    expect(screen.getByRole("form", { name: "Checkout" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Go to your cart" })).toBeNull();
    expect(container.querySelector("div.bg-surface-sunken > [role]")).toBeNull();
  });
});
