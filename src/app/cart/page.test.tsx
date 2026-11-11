import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";

// ---------------------------------------------------------------------------
// next/headers + next/cache mocks. mock.module is process-wide in bun test, so
// the mocks live in this one file, are registered before `./page` is
// imported, and delegate to per-test state.
// ---------------------------------------------------------------------------

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

mock.module("next/headers", () => ({
  cookies: async (): Promise<FakeCookieStore> => fakeStore,
}));
mock.module("next/cache", () => ({ revalidatePath: () => undefined }));

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedProducts } = await import("@/server/db/seed");
const { createCartService } = await import("@/server/cart/cart-service");
const { SESSION_COOKIE_NAME } = await import("@/server/session/session");
const { removeFromCart, updateCartQuantity } = await import("@/app/actions/cart");
const { CHECKOUT_BLOCKED_TEXT } = await import("@/components/organisms/CartSummary");
const { formatMoney } = await import("@/lib/money");
const pageModule = await import("./page");
const Page = pageModule.default;

const TOTE = "prod_canvas-tote-bag"; // 1999 cents, stock 42
const DESK = "prod_walnut-desk"; // 125000 cents, stock 3
const SESSION = "44444444-4444-4444-8444-444444444444";
const OTHER_SESSION = "55555555-5555-4555-8555-555555555555";

const usd = (cents: number): string => formatMoney(cents, "USD");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

function useSession(id: string): void {
  fakeStore.set(SESSION_COOKIE_NAME, id);
}

async function renderPage() {
  return render(await Page());
}

function summary(): HTMLElement {
  // T108: the page shows CartSummary (aside "Order summary") instead of CartTable's own summary box.
  return screen.getByRole("complementary", { name: "Order summary" });
}

function lineFor(name: string): HTMLElement {
  const item = screen.getByText(name).closest("li");
  if (item === null) throw new Error(`No line item for ${name}`);
  return item;
}

/** Text a screen reader announces: `textContent` minus `aria-hidden` subtrees (superscript Price visuals). */
function spokenText(el: Element | null): string | null {
  if (el === null) return null;
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent;
}

function checkoutLink(): HTMLElement | null {
  return screen.queryByRole("link", { name: "Proceed to checkout" });
}

beforeEach(() => {
  closeDatabase(); // fresh in-memory DB per test
  seedProducts(getDatabase());
  fakeStore = new FakeCookieStore();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

describe("/cart page", () => {
  test("exports the page title metadata and is noindex", () => {
    expect(pageModule.metadata.title).toBe("Your cart");
    expect(pageModule.metadata.robots).toEqual({ index: false, follow: false });
  });

  test("renders no structured data (private page)", async () => {
    useSession(SESSION);
    const { container } = await renderPage();
    expect(container.querySelector('script[type="application/ld+json"]')).toBeNull();
  });

  test("renders one h1, line items, subtotal and a checkout link for a filled cart", async () => {
    const cart = createCartService();
    expect(cart.addItem(SESSION, TOTE, 2).ok).toBe(true);
    expect(cart.addItem(SESSION, DESK, 1).ok).toBe(true);
    useSession(SESSION);

    const { container } = await renderPage();

    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Shopping Cart"); // T108: Amazon-style h1 (was "Your cart")
    expect(container.querySelector("main")).toBeNull();

    const tote = lineFor("Canvas Tote Bag");
    expect(within(tote).getByText(usd(1999))).toBeInTheDocument();
    expect(within(tote).getByTestId("line-total")).toHaveTextContent(usd(3998));
    const desk = lineFor("Walnut Standing Desk");
    expect(within(desk).getByTestId("line-total")).toHaveTextContent(usd(125000));

    expect(within(summary()).getAllByText(usd(128998)).length).toBeGreaterThan(0);
    expect(checkoutLink()).toHaveAttribute("href", "/checkout");
  });

  test("no session cookie shows the empty state and no checkout link", async () => {
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Shopping Cart" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(checkoutLink()).toBeNull();
  });

  test("an unavailable line shows the warning and hides checkout", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    getDatabase().run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    useSession(SESSION);

    await renderPage();

    expect(within(lineFor("Canvas Tote Bag")).getByText("No longer available")).toBeInTheDocument();
    expect(within(summary()).getByText(CHECKOUT_BLOCKED_TEXT.allUnavailable)).toBeInTheDocument(); // T108 (was UNAVAILABLE_WARNING)
    expect(checkoutLink()).toBeNull();
  });

  test("stepper max is the available stock and both line forms post productId", async () => {
    createCartService().addItem(SESSION, DESK, 3); // stock is 3
    useSession(SESSION);

    await renderPage();

    const desk = lineFor("Walnut Standing Desk");
    expect(within(desk).getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    expect(within(desk).getByRole("button", { name: "Decrease quantity" })).toBeEnabled();

    const forms = Array.from(desk.querySelectorAll("form"));
    expect(forms).toHaveLength(3); // T108: update, save for later, remove (was 2)
    for (const f of forms) {
      expect(new FormData(f).get("productId")).toBe(DESK);
    }
  });

  test("quantity update changes line total and subtotal; above stock errors and keeps quantity", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    useSession(SESSION);

    const ok = await updateCartQuantity(null, form({ productId: TOTE, quantity: "3" }));
    expect(ok?.ok).toBe(true);
    const { rerender } = await renderPage();
    expect(within(lineFor("Canvas Tote Bag")).getByTestId("line-total")).toHaveTextContent(usd(5997));
    expect(within(summary()).getAllByText(usd(5997)).length).toBeGreaterThan(0);

    const tooMany = await updateCartQuantity(null, form({ productId: TOTE, quantity: "43" }));
    expect(tooMany?.ok).toBe(false);
    rerender(await Page());
    expect(within(lineFor("Canvas Tote Bag")).getByRole("textbox")).toHaveValue("3");
    expect(within(lineFor("Canvas Tote Bag")).getByTestId("line-total")).toHaveTextContent(usd(5997));
  });

  test("removing the last item transitions to the empty state", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    useSession(SESSION);

    const { rerender } = await renderPage();
    expect(checkoutLink()).not.toBeNull();

    const removed = await removeFromCart(null, form({ productId: TOTE }));
    expect(removed?.ok).toBe(true);
    rerender(await Page());

    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(screen.queryByText("Canvas Tote Bag")).toBeNull();
    expect(checkoutLink()).toBeNull();
  });

  test("the cart is per session: another cookie sees its own (empty) cart", async () => {
    createCartService().addItem(SESSION, TOTE, 2);
    useSession(OTHER_SESSION);

    await renderPage();
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// T108: cart page v2 (CartTable hideSummary + CartSummary + saved + rails).
// Lives in this file because the next/* mocks are process-wide.
// ---------------------------------------------------------------------------

const { seedCoupons, seedShippingMethods } = await import("@/server/db/seed");
const { createRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { isAllowedInternalHref } = await import("@/content/routes");

const PINS = "prod_enamel-pin-set"; // 50 cents, stock 100

function seedCommerce(): void {
  seedCoupons(getDatabase());
  seedShippingMethods(getDatabase());
}

function cartSummaryAside(container: HTMLElement): HTMLElement {
  const aside = container.querySelector<HTMLElement>('[data-testid="cart-summary"]');
  if (aside === null) throw new Error("no CartSummary");
  return aside;
}

describe("/cart page v2 (T108)", () => {
  test("breadcrumb Home > Cart, one h1 'Shopping Cart'", async () => {
    await renderPage();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(within(crumbs).getByText("Cart")).toHaveAttribute("aria-current", "page");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  test("no cookie: empty state, no cookie minted, no cart written, no summary or forms; only a best-sellers rail (D-T108-1)", async () => {
    const { container } = await renderPage();
    expect(fakeStore.jar.size).toBe(0);
    expect(getDatabase().query("SELECT COUNT(*) AS n FROM carts").get()).toEqual({ n: 0 });
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
    expect(container.querySelector('[data-testid="cart-summary"]')).toBeNull();
    const sections = [...container.querySelectorAll("section")];
    expect(sections.every((el) => el.id === "cart-best-sellers")).toBe(true);
    expect(container.querySelectorAll("form")).toHaveLength(0);
  });

  test("no cookie: best sellers are shown when the catalogue has them, from one listing read", async () => {
    const listing = await import("@/server/catalog/listing-service");
    const service = listing.getListingService();
    const products = new (await import("@/server/catalog/product-repository")).SqliteProductRepository(getDatabase()).getManyByIds([TOTE, DESK]);
    const reads: unknown[] = [];
    const original = service.bestSellers.bind(service);
    const spy = spyOn(service, "bestSellers").mockImplementation((limit, opts) => {
      reads.push(limit);
      original(limit, opts);
      return products;
    });
    try {
      const { container } = await renderPage();
      expect(reads).toHaveLength(1);
      const rail = container.querySelector("section#cart-best-sellers");
      expect(rail).not.toBeNull();
      expect(rail?.textContent ?? "").toContain("Canvas Tote Bag");
      expect(fakeStore.jar.size).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("filled cart: summary total check matches with coupon + chosen shipping; selected method in total", async () => {
    seedCommerce();
    const cart = createCartService();
    expect(cart.addItem(SESSION, TOTE, 2).ok).toBe(true); // 3998
    expect(cart.applyCoupon(SESSION, "SAVE5").ok).toBe(true);
    expect(cart.selectShippingMethod(SESSION, "express").ok).toBe(true);
    useSession(SESSION);

    const { container } = await renderPage();
    const aside = cartSummaryAside(container);
    expect(aside).toHaveAttribute("data-total-check", "match");
    expect(aside).toHaveAttribute("data-can-checkout", "true");
    expect(within(aside).getByTestId("cart-summary-total")).toHaveTextContent(usd(3998 - 500 + 999));
    expect(within(aside).getByText("Discount (SAVE5)")).toBeInTheDocument();
    // CartTable's own summary box is hidden: exactly one checkout link, inside CartSummary.
    expect(screen.queryByRole("region", { name: "Cart summary" })).toBeNull();
    const checkout = screen.getAllByRole("link", { name: "Proceed to checkout" });
    expect(checkout).toHaveLength(1);
    expect(aside.contains(checkout[0] ?? null)).toBe(true);
    expect(aside.className).toContain("lg:w-80");
  });

  test("free-shipping progress: standard is free at/over the threshold", async () => {
    seedCommerce();
    createCartService().addItem(SESSION, TOTE, 2); // 3998 >= 3500
    useSession(SESSION);
    const { container } = await renderPage();
    const aside = cartSummaryAside(container);
    expect(aside).toHaveAttribute("data-total-check", "match");
    expect(within(aside).getByTestId("cart-summary-total")).toHaveTextContent(usd(3998));
  });

  test("exact form count, none nested: 3 per line, 3 per saved row, coupon + shipping", async () => {
    seedCommerce();
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 1);
    cart.addItem(SESSION, DESK, 1);
    cart.addItem(SESSION, PINS, 2);
    expect(cart.saveForLater(SESSION, PINS).ok).toBe(true);
    useSession(SESSION);

    const { container } = await renderPage();
    const forms = Array.from(container.querySelectorAll("form"));
    expect(forms).toHaveLength(2 * 3 + 1 * 3 + 2);
    for (const f of forms) expect(f.parentElement?.closest("form")).toBeNull();
  });

  test("landmarks and headings are unique with both organisms, saved section and rails", async () => {
    seedCommerce();
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 1);
    cart.addItem(SESSION, PINS, 1);
    cart.saveForLater(SESSION, PINS);
    createRecommendationService({ db: getDatabase() }).recordView(SESSION, DESK);
    useSession(SESSION);

    const { container } = await renderPage();
    expect(screen.getByRole("heading", { name: "Customers who bought items in your cart also bought" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Your recently viewed items" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Saved for later (1 item)" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Order summary" })).toBeInTheDocument();

    const headings = screen.getAllByRole("heading").map((h) => `${h.tagName}:${h.textContent ?? ""}`);
    expect(new Set(headings).size).toBe(headings.length);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    const landmarks = [
      ...screen.getAllByRole("navigation"),
      ...screen.getAllByRole("complementary"),
      ...screen.getAllByRole("region"),
    ].map((el) => `${el.tagName}:${el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby") ?? ""}`);
    expect(new Set(landmarks).size).toBe(landmarks.length);
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("also-bought rail excludes items already in the cart", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    useSession(SESSION);
    await renderPage();
    const rail = screen.getByRole("region", {
      name: "Customers who bought items in your cart also bought, product list",
    });
    expect(within(rail).queryByText("Canvas Tote Bag")).toBeNull();
    expect(within(rail).getAllByRole("link").length).toBeGreaterThan(0);
  });

  test("recently viewed rail is omitted when the session has no views", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    useSession(SESSION);
    await renderPage();
    expect(screen.queryByRole("heading", { name: "Your recently viewed items" })).toBeNull();
  });

  test("hostile product names render as text, never as markup", async () => {
    const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    getDatabase().run("UPDATE products SET name = ? WHERE id IN (?, ?)", [hostile, TOTE, PINS]);
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 1);
    cart.addItem(SESSION, PINS, 1);
    cart.saveForLater(SESSION, PINS);
    useSession(SESSION);

    const { container } = await renderPage();
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getAllByText(hostile).length).toBeGreaterThanOrEqual(2);
  });

  test("every href passes isAllowedInternalHref", async () => {
    seedCommerce();
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 1);
    cart.addItem(SESSION, PINS, 1);
    cart.saveForLater(SESSION, PINS);
    createRecommendationService({ db: getDatabase() }).recordView(SESSION, DESK);
    useSession(SESSION);

    const { container } = await renderPage();
    const hrefs = Array.from(container.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
  });

  test("dropped coupon and inactive shipping method show as one-time page notices", async () => {
    seedCommerce();
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 2);
    expect(cart.applyCoupon(SESSION, "SAVE5").ok).toBe(true);
    expect(cart.selectShippingMethod(SESSION, "express").ok).toBe(true);
    cart.setQuantity(SESSION, TOTE, 1); // below SAVE5's minimum
    getDatabase().run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    useSession(SESSION);

    const { rerender } = await renderPage();
    const alerts = screen.getAllByRole("alert").filter((el) => el.textContent?.includes("SAVE5"));
    expect(alerts).toHaveLength(1); // page Notice only; CartSummary gets couponNotice null
    const shippingNotice = screen.getByText(/selected shipping method is no longer available/).closest('[role="status"]');
    expect(shippingNotice).toHaveAttribute("data-tone", "info");
    // Rendered once, inside CartSummary (consistency z), not duplicated at page level.
    expect(screen.getAllByText(/selected shipping method is no longer available/)).toHaveLength(1);
    expect(shippingNotice?.closest('[data-testid="cart-summary"]')).not.toBeNull();

    rerender(await Page());
    expect(screen.queryByText(/SAVE5 was removed/)).toBeNull();
    expect(screen.queryByText(/selected shipping method is no longer available/)).toBeNull();
  });

  test("inactive shipping method on a cart with no lines: notice falls back to the page (no summary)", async () => {
    seedCommerce();
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 1);
    expect(cart.selectShippingMethod(SESSION, "express").ok).toBe(true);
    cart.removeItem(SESSION, TOTE);
    getDatabase().run("UPDATE shipping_methods SET is_active = 0 WHERE id = 'express'");
    useSession(SESSION);

    const { container } = await renderPage();
    expect(container.querySelector('[data-testid="cart-summary"]')).toBeNull();
    const notices = screen.getAllByText(/selected shipping method is no longer available/);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.closest('[role="status"]')).toHaveAttribute("data-tone", "info");
  });

  test("empty cart with saved items: saved section + link to the saved list; no summary", async () => {
    const cart = createCartService();
    cart.addItem(SESSION, PINS, 1);
    cart.saveForLater(SESSION, PINS);
    useSession(SESSION);

    const { container } = await renderPage();
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "View your saved items (1)" });
    expect(link.getAttribute("href") ?? "").toMatch(/^\/lists\/[^/]+$/);
    expect(screen.getByRole("region", { name: "Saved for later (1 item)" })).toBeInTheDocument();
    expect(container.querySelector('[data-testid="cart-summary"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Move to cart: Enamel Pin Set" })).toBeEnabled();
  });

  test("save for later then move to cart round-trip through the page", async () => {
    createCartService().addItem(SESSION, TOTE, 2);
    useSession(SESSION);
    const { saveForLater, moveToCart } = await import("@/app/actions/cart");

    const { rerender } = await renderPage();
    expect((await saveForLater(null, form({ productId: TOTE })))?.ok).toBe(true);
    rerender(await Page());
    expect(screen.getByRole("heading", { name: "Your cart is empty" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Saved for later (1 item)" })).toBeInTheDocument();

    expect((await moveToCart(null, form({ productId: TOTE })))?.ok).toBe(true);
    rerender(await Page());
    expect(within(lineFor("Canvas Tote Bag")).getByRole("textbox")).toHaveValue("2");
    expect(screen.queryByRole("region", { name: /Saved for later/ })).toBeNull();
  });

  test("an unpublished line shows as plain text, unavailable, and blocks checkout", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    getDatabase().run("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    useSession(SESSION);
    const { container } = await renderPage();
    expect(container.querySelector('a[href="/products/canvas-tote-bag"]')).toBeNull();
    expect(checkoutLink()).toBeNull();
    expect(cartSummaryAside(container)).toHaveAttribute("data-can-checkout", "false");
  });

  test("lines carry list prices: 'You save' shows for a discounted line", async () => {
    getDatabase().run("UPDATE products SET list_price_cents = 2999 WHERE id = ?", [TOTE]);
    createCartService().addItem(SESSION, TOTE, 1);
    useSession(SESSION);
    await renderPage();
    expect(within(lineFor("Canvas Tote Bag")).getByText(/You save/)).toBeInTheDocument();
  });

  test("layout: stacked by default, two columns from lg", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    useSession(SESSION);
    const { container } = await renderPage();
    const aside = cartSummaryAside(container);
    const row = aside.parentElement;
    expect(row?.className).toContain("flex-col");
    expect(row?.className).toContain("lg:flex-row");
    expect(row?.className).toContain("min-w-0");
  });

  test("D-T108-2: the empty cart's 'View your saved items' link has a 44px touch target", async () => {
    const cart = createCartService();
    cart.addItem(SESSION, PINS, 1);
    cart.saveForLater(SESSION, PINS);
    useSession(SESSION);
    await renderPage();
    const link = screen.getByRole("link", { name: "View your saved items (1)" });
    for (const cls of ["inline-flex", "min-h-touch", "items-center"]) expect(link.className).toContain(cls);
  });

  test("D-T45-1: a cart whose only line was unpublished shows zero totals (no shipping charged)", async () => {
    createCartService().addItem(SESSION, TOTE, 1);
    getDatabase().run("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    useSession(SESSION);
    const { container } = await renderPage();
    const aside = cartSummaryAside(container);
    // T170: the total is a superscript Price (T161); compare the spoken text, not the aria-hidden visual digits.
    expect(spokenText(aside.querySelector('[data-testid="cart-summary-total"]'))).toBe(usd(0));
    expect(aside.textContent ?? "").not.toContain(usd(499));
    expect(checkoutLink()).toBeNull();
  });

  test("D-T82-4: a saved item unpublished after saving shows 'No longer available', no link, Delete only", async () => {
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 1);
    cart.saveForLater(SESSION, TOTE);
    getDatabase().run("UPDATE products SET published_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [TOTE]);
    useSession(SESSION);
    const { container } = await renderPage();
    const region = screen.getByRole("region", { name: "Saved for later (1 item)" });
    expect(container.querySelector('a[href="/products/canvas-tote-bag"]')).toBeNull();
    expect(within(region).queryByRole("link")).toBeNull();
    expect(within(region).getByTestId("saved-availability")).toHaveTextContent("No longer available");
    expect(within(region).queryByRole("button", { name: /Move to cart|Unavailable|Wish List/ })).toBeNull();
    expect(within(region).getByRole("button", { name: "Delete: Canvas Tote Bag" })).toBeEnabled();
    expect(region.querySelectorAll("form")).toHaveLength(1);
  });
});

describe("/cart page light-only pass (T170)", () => {
  const DAY_MS = 86_400_000;
  const clockSpies: { mockRestore: () => void }[] = [];

  afterEach(() => {
    for (const spy of clockSpies.splice(0)) spy.mockRestore();
  });

  test("the empty cart's 'View your saved items' link is an outline pill", async () => {
    const cart = createCartService();
    cart.addItem(SESSION, TOTE, 1);
    cart.saveForLater(SESSION, TOTE);
    useSession(SESSION);
    await renderPage();
    const link = screen.getByRole("link", { name: "View your saved items (1)" });
    for (const cls of ["rounded-full", "min-h-touch", "self-start"]) expect(link.className).toContain(cls);
  });

  /**
   * The seed has no orders (so no best sellers) and listing readers do not
   * map `publishedAt` onto rail products yet (T167), so the best-sellers
   * reader returns the tote stamped with a publish date relative to the
   * page's one clock, and records the `now` the loader passed it.
   */
  async function renderEmptyCartWithClock(now: number, publishedDaysAgo: number) {
    const { getListingService } = await import("@/server/catalog/listing-service");
    const { SqliteProductRepository } = await import("@/server/catalog/product-repository");
    const listing = getListingService();
    const [tote] = new SqliteProductRepository(getDatabase()).getManyByIds([TOTE]);
    if (tote === undefined) throw new Error("seed has no tote");
    const seenNow: unknown[] = [];
    const stamp = new Date(now - publishedDaysAgo * DAY_MS).toISOString();
    clockSpies.push(spyOn(Date, "now").mockReturnValue(now));
    clockSpies.push(
      spyOn(listing, "bestSellers").mockImplementation((_limit, opts) => {
        seenNow.push(opts?.now);
        return [{ ...tote, publishedAt: stamp }];
      }),
    );
    const { container } = await renderPage(); // no cookie: empty cart + best sellers (D-T108-1)
    const rail = container.querySelector<HTMLElement>("section#cart-best-sellers");
    if (rail === null) throw new Error("no best-sellers rail");
    const card = rail.querySelector("article");
    if (card === null) throw new Error("no rail card");
    return { card, seenNow };
  }

  test("rails get the loader's one clock: a best seller published a day before `now` shows 'New'", async () => {
    const now = Date.parse("2026-11-08T12:00:00.000Z");
    const { card, seenNow } = await renderEmptyCartWithClock(now, 1);
    expect(seenNow).toEqual([now]);
    expect(within(card).getByText("New")).toBeInTheDocument();
  });

  test("the same best seller is not 'New' when it was published long before the page's clock", async () => {
    const now = Date.parse("2026-11-08T12:00:00.000Z");
    const { card } = await renderEmptyCartWithClock(now, 400);
    expect(within(card).queryByText("New")).toBeNull();
  });

  test("D-T170-1: a recently-viewed product (hydrated by getManyByIds) published a day before `now` shows 'New'", async () => {
    const now = Date.parse("2026-11-08T12:00:00.000Z");
    createCartService().addItem(SESSION, TOTE, 1);
    createRecommendationService({ db: getDatabase() }).recordView(SESSION, DESK);
    getDatabase().run("UPDATE products SET published_at = ?, list_price_cents = NULL WHERE id = ?", [
      new Date(now - DAY_MS).toISOString(),
      DESK,
    ]);
    clockSpies.push(spyOn(Date, "now").mockReturnValue(now));
    useSession(SESSION);
    const { container } = await renderPage();
    const rail = container.querySelector<HTMLElement>("section#cart-recently-viewed");
    if (rail === null) throw new Error("no recently viewed rail");
    const card = rail.querySelector("article");
    if (card === null) throw new Error("no rail card");
    expect(within(card).getByText("New")).toBeInTheDocument();
  });
});
