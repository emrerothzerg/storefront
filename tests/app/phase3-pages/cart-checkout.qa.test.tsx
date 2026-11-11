/**
 * T173 — QA wave C2, cart + checkout pages after T170 (light-only pass, one
 * `now` to rails, spoken totals) and the order confirmation page. QA-owned.
 *
 * Criteria: BACKLOG-phase3 T170 AC1–AC3, T173 AC2/AC3, T161 AC3 (spoken full
 * amounts), FIX-card-now (rails get the page's `now`), rulings D-T108-1
 * (cookie-less /cart shows best sellers) and D-T109-1 (empty/blocked
 * /checkout is a 200 state linking /cart), CONTRACTS G rows. Uses the T111b
 * harness (AsyncLocalStorage cookie jars, multipart browser submit).
 */
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { expectNotNull, expectNull } from "@/test/dom-assertions";

import {
  browserSubmit,
  cardLeaks,
  duplicateIds,
  headingViolations,
  hrefViolations,
  installNextMocks,
  isRealPostForm,
  outcomeOf,
  parseHtml,
  qa,
  redirectOrState,
  resetCookies,
  serverLike,
  stockOf,
  totalChanges,
  TYPED_NEW_ADDRESS,
  unlabelledControls,
} from "../phase2-wave6/_t111b-harness";
import {
  brandAndThemeViolations,
  countClockReads,
  darkClassTokens,
  landmarkViolations,
  smallTargets,
  spokenText,
  themeToggles,
  withChrome,
} from "./_phase3";

installNextMocks();

const env = process.env as Record<string, string | undefined>;
const originalDatabasePath = env.DATABASE_PATH;
env.DATABASE_PATH = ":memory:";

const { closeDatabase, getDatabase } = await import("@/server/db/client");
const { seedDatabase } = await import("@/server/db/seed");
const session = await import("@/server/session/session");
const { createCartService } = await import("@/server/cart/cart-service");
const { getRecommendationService } = await import("@/server/recommendations/recommendation-service");
const { isAllowedInternalHref } = await import("@/content/routes");
const { formatMoney } = await import("@/lib/money");
const { CARD_BADGE_NEW_DAYS } = await import("@/components/molecules/ProductCard");
const cartActions = await import("@/app/actions/cart");
const listActions = await import("@/app/actions/lists");
const alertActions = await import("@/app/actions/stock-alerts");
const reviewActions = await import("@/app/actions/reviews");
const qaActions = await import("@/app/actions/questions");
const { placeOrderV2 } = await import("@/app/actions/checkout-v2");
const { SITE_NAME } = await import("@/lib/seo/site");
const { FOOTER_COLUMNS } = await import("@/content/navigation");
const { SiteFooter } = await import("@/components/organisms/SiteFooter");
const { HeaderShell } = await import("@/app/_layout/HeaderShell");
const cartPage = await import("@/app/cart/page");
const checkoutPage = await import("@/app/checkout/page");
const orderPage = await import("@/app/orders/[id]/page");
const { default: ProductPage } = await import("@/app/products/[slug]/page");
const CartPage = cartPage.default;
const CheckoutPage = checkoutPage.default;
const OrderPage = orderPage.default;

const TOTE = "prod_canvas-tote-bag";
const GUEST = "a7a7a7a7-1737-4173-8173-0000000000a7";
const GUEST2 = "b7b7b7b7-1737-4173-8173-0000000000b7";
const DAY = 86_400_000;
const usd = (cents: number): string => formatMoney(cents, "USD");
const db = () => getDatabase();

const CART_ACTIONS = [
  cartActions.addToCart,
  cartActions.updateCartQuantity,
  cartActions.removeFromCart,
  cartActions.saveForLater,
  cartActions.moveToCart,
  cartActions.applyCoupon,
  cartActions.removeCoupon,
  cartActions.selectShippingMethod,
  cartActions.buyNow,
  cartActions.addManyToCart,
  listActions.addToList,
  listActions.removeFromList,
];
const PDP_ACTIONS = [
  ...CART_ACTIONS,
  alertActions.subscribeStockAlert,
  alertActions.unsubscribeStockAlert,
  reviewActions.submitReview,
  reviewActions.voteReviewHelpful,
  qaActions.askQuestion,
  qaActions.answerQuestion,
  qaActions.voteQuestion,
  qaActions.voteAnswer,
];

function setupDb(): void {
  closeDatabase();
  seedDatabase(db());
  db().run("UPDATE products SET stock = 500 WHERE id = ?", [TOTE]);
}

function add(owner: string, productId = TOTE, qty = 1): void {
  const r = createCartService().addItem(owner, productId, qty);
  if (!r.ok) throw new Error(`addItem: ${r.error.code}`);
}

/** One paid order through the real order service (best sellers are ranked by sales). */
async function placePaid(owner: string, productId: string): Promise<void> {
  const { createOrderService } = await import("@/server/orders/order-service");
  const { createMockPaymentProvider, MOCK_CARDS } = await import("@/server/payments/mock-payment-provider");
  add(owner, productId, 1);
  const orders = createOrderService(db(), { payments: createMockPaymentProvider({ latencyMs: 0 }), inFlight: new Map() });
  const placed = await orders.placeOrderV2({
    sessionId: owner,
    address: { fullName: "Sam Seller", email: "sam.seller@example.test", line1: "1 Sale St", city: "Salem", region: "OR", postalCode: "97301", country: "US" },
    card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2031, cvc: "987", nameOnCard: "Sam Seller" },
    idempotencyKey: `qa-t173-${crypto.randomUUID()}`,
  });
  if (!placed.ok) throw new Error(`placeOrderV2: ${placed.error.code}`);
}

function view(owner: string) {
  const v = createCartService().getCartView(owner);
  if (!v.ok) throw new Error("view");
  return v.value;
}

async function renderCart() {
  const restore = serverLike(CART_ACTIONS);
  try {
    const html = renderToStaticMarkup(await CartPage());
    return { html, doc: parseHtml(html) };
  } finally {
    restore();
  }
}

async function renderCheckout() {
  const restore = serverLike([placeOrderV2]);
  try {
    const html = renderToStaticMarkup(await CheckoutPage());
    return { html, doc: parseHtml(html) };
  } finally {
    restore();
  }
}

/** `<dd>` of the summary row whose `<dt>` starts with `label`. */
function row(root: Element, label: string): Element | null {
  const dt = [...root.querySelectorAll("dt")].find((d) => (spokenText(d) ?? "").startsWith(label));
  return dt?.nextElementSibling ?? null;
}

function summary(doc: Document): Element {
  const aside = doc.querySelector('aside[data-testid="cart-summary"]');
  if (aside === null) throw new Error("no cart summary");
  return aside;
}

/** SR6 exempts links inside running text (e.g. "By placing your order, you agree to our Conditions of Use and Privacy Notice."). */
const inlineInText = (el: Element): boolean => el.tagName === "A" && el.parentElement?.tagName === "P";

function cartAllowed(href: string): boolean {
  return isAllowedInternalHref(href);
}

function slugToId(slug: string): string | undefined {
  return db().query<{ id: string }, [string]>("SELECT id FROM products WHERE slug = ?").get(slug)?.id;
}

beforeEach(() => {
  setupDb();
  resetCookies();
});

afterAll(() => {
  closeDatabase();
  if (originalDatabasePath === undefined) delete env.DATABASE_PATH;
  else env.DATABASE_PATH = originalDatabasePath;
});

// ---------------------------------------------------------------------------
// /cart states
// ---------------------------------------------------------------------------

describe("/cart states (T170 AC1, D-T108-1)", () => {
  test("no cookie: 200, one h1 'Shopping Cart', empty state + best-sellers rail (D-T108-1), no checkout link, no writes", async () => {
    await placePaid("c9c9c9c9-1737-4173-8173-0000000000c9", TOTE);
    const before = totalChanges(db());
    const { doc } = await renderCart();
    expect(totalChanges(db())).toBe(before);
    expect(qa.store.writes).toEqual([]);
    expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Shopping Cart"]);
    expect(doc.body.textContent).toContain("Your cart is empty");
    const rail = doc.querySelector("section#cart-best-sellers");
    expectNotNull(rail ?? null);
    expect(rail?.querySelectorAll("li a[href^='/products/']").length ?? 0).toBeGreaterThan(0);
    expectNull(doc.querySelector('a[href^="/checkout"]'));
    expectNull(doc.querySelector('aside[data-testid="cart-summary"]'));
  });

  test.each([[""], ["not-a-uuid"], ["x".repeat(4000)], ["A7A7A7A7-1737-4173-8173-0000000000A7"]])(
    "garbage cookie %# reads as no cookie (empty state, nothing written)",
    async (value) => {
      add(GUEST);
      resetCookies({ [session.SESSION_COOKIE_NAME]: value });
      const { doc } = await renderCart();
      expect(doc.body.textContent).toContain("Your cart is empty");
      expect(qa.store.writes).toEqual([]);
    },
  );

  test("lines: summary aside with checkout link; empty cart with saved items shows the 44px 'View your saved items (N)' pill", async () => {
    add(GUEST);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const withLines = await renderCart();
    expectNotNull(withLines.doc.querySelector('aside[data-testid="cart-summary"]') ?? null);
    expectNotNull(withLines.doc.querySelector('a[href="/checkout"]') ?? null);
    // Save the line for later -> cart empty, saved list has 1 item.
    const fd = new FormData();
    fd.set("productId", TOTE);
    expect((await cartActions.saveForLater(null, fd))?.ok).toBe(true);
    const { doc } = await renderCart();
    const pill = [...doc.querySelectorAll("a")].find((a) => /^View your saved items \(1\)$/.test((a.textContent ?? "").trim()));
    expect(pill !== undefined).toBe(true);
    expect(isAllowedInternalHref(pill?.getAttribute("href") ?? "")).toBe(true);
    expect(pill?.getAttribute("class") ?? "").toContain("min-h-touch");
    expect(pill?.getAttribute("class") ?? "").toContain("rounded-full");
  });

  test("an all-unavailable cart shows zero totals as spoken text and no checkout link (D-T45-1 regression)", async () => {
    add(GUEST);
    db().run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const { doc } = await renderCart();
    const aside = summary(doc);
    expect(spokenText(aside.querySelector('[data-testid="cart-summary-total"]'))).toBe(usd(0));
    expectNull(doc.querySelector('a[href="/checkout"]'));
  });
});

// ---------------------------------------------------------------------------
// Spoken totals (T161 AC3, T170)
// ---------------------------------------------------------------------------

describe("/cart spoken totals: every summary amount is read as one full amount", () => {
  test("subtotal, discount, shipping and total: spoken text = formatted service totals; the total is plain (no superscript split)", async () => {
    add(GUEST, TOTE, 3);
    expect(createCartService().applyCoupon(GUEST, "WELCOME10").ok).toBe(true);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const v = view(GUEST);
    expect(v.totals.discountCents).toBeGreaterThan(0);
    const { doc } = await renderCart();
    const aside = summary(doc);
    expect(aside.getAttribute("data-total-check")).toBe("match");
    expect(spokenText(row(aside, "Subtotal"))).toContain(usd(v.totals.subtotalCents));
    expect(spokenText(aside.querySelector('[data-testid="cart-summary-discount"]'))).toContain(usd(v.totals.discountCents));
    const shipping = spokenText(row(aside, "Shipping")) ?? "";
    expect(shipping.endsWith(v.totals.shippingCents === 0 ? "Free" : usd(v.totals.shippingCents))).toBe(true);
    const total = aside.querySelector('[data-testid="cart-summary-total"]');
    expect(spokenText(total)).toBe(usd(v.totals.totalCents));
    // T180/U18: the summary total is plain "$0.00" like every other row (no superscript visual);
    // visible text equals spoken text. No raw cents digits are spoken.
    expectNull(total?.querySelector('[data-slot="price-superscript"]') ?? null);
    expect(total?.textContent).toBe(usd(v.totals.totalCents));
    expect(spokenText(aside)).not.toMatch(/\$\d+\.\d{2}\d/);
    expect(spokenText(aside)).not.toMatch(/\$\d{3,}(?![\d,.])/);
  });

  test("line prices on the cart lines are spoken as full amounts", async () => {
    add(GUEST, TOTE, 2);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const { doc } = await renderCart();
    const name = db().query<{ name: string; price_cents: number }, [string]>("SELECT name, price_cents FROM products WHERE id = ?").get(TOTE);
    const li = [...doc.querySelectorAll("li")].find((l) => (l.querySelector("a")?.textContent ?? "") === name?.name);
    expect(li !== undefined).toBe(true);
    const spoken = spokenText(li) ?? "";
    expect(spoken).toContain(usd(name?.price_cents ?? 0));
    expect(spoken).not.toMatch(/\$\d+\.\d{2}\d/);
  });
});

// ---------------------------------------------------------------------------
// One clock (FIX-card-now, T170)
// ---------------------------------------------------------------------------

describe("/cart one clock: rails get the page's `now`", () => {
  function recentlyViewedSetup(): string[] {
    add(GUEST);
    const others = db()
      .query<{ id: string }, []>(
        "SELECT id FROM products WHERE stock > 0 AND id <> 'prod_canvas-tote-bag' AND published_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY slug LIMIT 3",
      )
      .all()
      .map((r) => r.id);
    const reco = getRecommendationService();
    for (const id of others) reco.recordView(GUEST, id, Date.now());
    return others;
  }

  test("rendering the returned tree reads the clock 0 times; the page function reads it once", async () => {
    recentlyViewedSetup();
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const restore = serverLike(CART_ACTIONS);
    try {
      const page = await countClockReads(() => CartPage());
      const markup = await countClockReads(async () => renderToStaticMarkup(page.value));
      if (page.reads !== 1 || markup.reads !== 0) {
        console.info(`[T173] /cart clock reads page=${page.reads} render=${markup.reads}\n  ${[...page.stacks, ...markup.stacks].join("\n  ")}`);
      }
      expectNotNull(parseHtml(markup.value).querySelector("section#cart-recently-viewed") ?? null);
      expect(markup.reads).toBe(0);
      expect(page.reads).toBe(1);
    } finally {
      restore();
    }
  });

  // PIN: D-T170-1 — recommendation rails (cart also-bought / recently viewed / best sellers, PDP related / also bought /
  // also viewed / recently viewed) can never show "New": they hydrate products through `getManyByIds`, whose
  // SUMMARY_COLUMNS (src/server/catalog/product-repository.ts:164) do not select `published_at`, so cards get no
  // `publishedAt` and `cardBadges` drops "New" even though the page now forwards `now` (FIX-card-now). Same root
  // cause as (bx) for listing summaries.
  test("D-T170-1: a recently-viewed product published 1 day ago shows 'New' on its rail card (the rail received `now`)", async () => {
    const others = recentlyViewedSetup();
    const fresh = others[0] as string;
    db().run("UPDATE products SET published_at = ?, list_price_cents = NULL WHERE id = ?", [new Date(Date.now() - DAY).toISOString(), fresh]);
    const old = others[1] as string;
    db().run("UPDATE products SET published_at = ?, list_price_cents = NULL, rating_count = 0, rating_sum = 0 WHERE id = ?", [
      new Date(Date.now() - (CARD_BADGE_NEW_DAYS + 30) * DAY).toISOString(),
      old,
    ]);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const { doc } = await renderCart();
    const rail = doc.querySelector("section#cart-recently-viewed") as Element;
    const card = (id: string) =>
      [...rail.querySelectorAll("li")].find((li) => slugToId(decodeURIComponent((li.querySelector("a")?.getAttribute("href") ?? "").slice(10))) === id);
    expect(card(fresh)?.textContent ?? "").toContain("New");
    expect(card(old)?.textContent ?? "").not.toContain("New");
  });
});

// ---------------------------------------------------------------------------
// Notices and no-JS forms
// ---------------------------------------------------------------------------

describe("/cart notices and no-JS forms", () => {
  test("dropped coupon: one-time warning notice above the cart, gone on the next render", async () => {
    add(GUEST, TOTE, 3);
    expect(createCartService().applyCoupon(GUEST, "WELCOME10").ok).toBe(true);
    db().run("UPDATE coupons SET is_active = 0 WHERE code = 'WELCOME10'");
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const first = await renderCart();
    const notices = (d: Document) => [...d.querySelectorAll('[role="alert"], [role="status"]')].map((n) => spokenText(n) ?? "");
    expect(notices(first.doc).some((t) => /coupon|code/i.test(t))).toBe(true);
    const second = await renderCart();
    expect(notices(second.doc).some((t) => /coupon|code/i.test(t) && /removed|no longer|expired/i.test(t))).toBe(false);
  });

  test("every mutation form is a real POST form; posted fields never carry a price or total (SR9)", async () => {
    add(GUEST, TOTE, 2);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const { doc, html } = await renderCart();
    const posts = [...doc.querySelectorAll("form")].filter((f) => (f.getAttribute("method") ?? "").toLowerCase() !== "get");
    expect(posts.length).toBeGreaterThan(3);
    expect(posts.filter((f) => !isRealPostForm(f)).length).toBe(0);
    expect(html.toLowerCase()).not.toContain("javascript:");
    for (const f of posts) {
      const names = [...f.querySelectorAll("[name]")].map((i) => i.getAttribute("name") ?? "").filter((n) => !n.startsWith("$ACTION"));
      expect(names.filter((n) => /price|total|amount|cents/i.test(n))).toEqual([]);
    }
    expect(unlabelledControls(doc)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T173 AC2 flows: quick add (card) -> cart, quantity > stock, remove, promo
// ---------------------------------------------------------------------------

describe("cart flows (T173 AC2)", () => {
  test("quick add from a PDP rail card posts productId + quantity=1 and the cart page shows the line", async () => {
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const restore = serverLike(PDP_ACTIONS);
    let form: Element | undefined;
    try {
      const out = await outcomeOf(() => ProductPage({ params: Promise.resolve({ slug: "canvas-tote-bag" }), searchParams: Promise.resolve({}) }));
      if (out.kind !== "ok") throw new Error(out.kind);
      const doc = parseHtml(renderToStaticMarkup(out.value));
      form = [...doc.querySelectorAll('section[id^="rail-"] form')][0];
    } finally {
      restore();
    }
    expect(form !== undefined).toBe(true);
    const body = await browserSubmit(form as Element);
    expect(body.get("quantity")).toBe("1");
    const productId = String(body.get("productId"));
    const state = await cartActions.addToCart(null, body);
    expect(state?.ok).toBe(true);
    const { doc } = await renderCart();
    const v = view(GUEST);
    expect(v.items.map((i) => [i.productId, i.quantity])).toEqual([[productId, 1]]);
    expect(spokenText(summary(doc).querySelector('[data-testid="cart-summary-total"]'))).toBe(usd(v.totals.totalCents));
  });

  test("quantity above stock is refused with an 'Only N left in stock.' message; the stored quantity is unchanged", async () => {
    db().run("UPDATE products SET stock = 4 WHERE id = ?", [TOTE]);
    add(GUEST, TOTE, 2);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const fd = new FormData();
    fd.set("productId", TOTE);
    fd.set("quantity", "9");
    const state = await cartActions.updateCartQuantity(null, fd);
    expect(state?.ok).toBe(false);
    const message = state !== null && !state.ok ? state.error.message : "";
    expect(message).toMatch(/^(Only 4 left in stock\.|Please choose a quantity between 1 and \d+\.)$/);
    expect(view(GUEST).items[0]?.quantity).toBe(2);
    // At the stock limit the stepper's "Increase quantity" button is disabled (no-JS: the server refuses anyway).
    const atMax = new FormData();
    atMax.set("productId", TOTE);
    atMax.set("quantity", "4");
    expect((await cartActions.updateCartQuantity(null, atMax))?.ok).toBe(true);
    const { doc } = await renderCart();
    expect(doc.querySelector('button[aria-label="Increase quantity"]')?.hasAttribute("disabled")).toBe(true);
  });

  test("stock dropping below the line quantity: reduced line text, billed at available stock, checkout blocked", async () => {
    add(GUEST, TOTE, 3);
    db().run("UPDATE products SET stock = 2 WHERE id = ?", [TOTE]);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const { doc } = await renderCart();
    expect(doc.body.textContent).toContain("Only 2 left. Lower the quantity to continue.");
    const price = db().query<{ p: number }, [string]>("SELECT price_cents AS p FROM products WHERE id = ?").get(TOTE)?.p ?? 0;
    expect(spokenText(row(summary(doc), "Subtotal"))).toContain(usd(price * 2));
    expectNull(doc.querySelector('a[href="/checkout"]'));
  });

  test("remove: the line disappears and the empty state returns", async () => {
    add(GUEST);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const fd = new FormData();
    fd.set("productId", TOTE);
    expect((await cartActions.removeFromCart(null, fd))?.ok).toBe(true);
    const { doc } = await renderCart();
    expect(doc.body.textContent).toContain("Your cart is empty");
    expect(view(GUEST).items).toEqual([]);
  });

  test("promo: invalid code -> one generic error and totals unchanged; valid code -> discount row and spoken total update", async () => {
    add(GUEST, TOTE, 3);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const before = view(GUEST).totals.totalCents;
    const bad = new FormData();
    bad.set("couponCode", "<script>NOPE</script>");
    const badState = await cartActions.applyCoupon(null, bad);
    expect(badState?.ok).toBe(false);
    expect(badState !== null && !badState.ok ? badState.error.message : "").not.toContain("<script>");
    expect(view(GUEST).totals.totalCents).toBe(before);
    const good = new FormData();
    good.set("couponCode", "WELCOME10");
    expect((await cartActions.applyCoupon(null, good))?.ok).toBe(true);
    const v = view(GUEST);
    expect(v.totals.totalCents).toBeLessThan(before);
    const { doc } = await renderCart();
    expect(spokenText(summary(doc).querySelector('[data-testid="cart-summary-total"]'))).toBe(usd(v.totals.totalCents));
  });
});

// ---------------------------------------------------------------------------
// /checkout states and flows
// ---------------------------------------------------------------------------

describe("/checkout states (D-T109-1, T170)", () => {
  test("no cookie -> 200 empty state on a sunken Card: status notice + 44px pill 'Go to your cart' -> /cart, no form, no writes", async () => {
    const before = totalChanges(db());
    const { doc } = await renderCheckout();
    expect(totalChanges(db())).toBe(before);
    expect(qa.store.writes).toEqual([]);
    expect([...doc.querySelectorAll("h1")].map((h) => h.textContent)).toEqual(["Checkout"]);
    expect(doc.querySelectorAll("form").length).toBe(0);
    const status = doc.querySelector('[role="status"]');
    expect(spokenText(status)).toMatch(/cart is empty/i);
    const link = [...doc.querySelectorAll('a[href="/cart"]')].find((a) => (a.textContent ?? "").trim() === "Go to your cart");
    expect(link !== undefined).toBe(true);
    expect(link?.getAttribute("class") ?? "").toContain("min-h-touch");
    expect(link?.getAttribute("class") ?? "").toContain("rounded-full");
    expectNotNull(link?.closest('[class*="bg-surface-sunken"]') ?? null);
  });

  test("blocked (out-of-stock line) -> alert notice + 'Review your cart' pill -> /cart, no form", async () => {
    add(GUEST);
    db().run("UPDATE products SET stock = 0 WHERE id = ?", [TOTE]);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const { doc } = await renderCheckout();
    expect(doc.querySelectorAll("form").length).toBe(0);
    expectNotNull(doc.querySelector('[role="alert"]') ?? null);
    const link = [...doc.querySelectorAll('a[href="/cart"]')].find((a) => (a.textContent ?? "").trim() === "Review your cart");
    expect(link?.getAttribute("class") ?? "").toContain("min-h-touch");
  });

  test("ready -> one real POST form; order summary total spoken = service total; render reads no clock; nothing minted", async () => {
    add(GUEST, TOTE, 2);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const restore = serverLike([placeOrderV2]);
    try {
      const page = await countClockReads(() => CheckoutPage());
      const markup = await countClockReads(async () => renderToStaticMarkup(page.value));
      if (markup.reads !== 0) console.info(`[T173] /checkout render clock reads: ${markup.reads}\n  ${markup.stacks.join("\n  ")}`);
      expect(markup.reads).toBe(0);
      const doc = parseHtml(markup.value);
      const forms = doc.querySelectorAll("form");
      expect(forms.length).toBe(1);
      expect(isRealPostForm(forms[0] as Element)).toBe(true);
      const totalDd = [...doc.querySelectorAll("dt")].filter((d) => (spokenText(d) ?? "").trim() === "Total").map((d) => d.nextElementSibling);
      expect(totalDd.length).toBeGreaterThan(0);
      for (const dd of totalDd) expect(spokenText(dd)).toBe(usd(view(GUEST).totals.totalCents));
      expect(qa.store.writes).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("/checkout flows through the rendered form (T173 AC3) and the confirmation page (T170 AC2)", () => {
  async function readyForm(owner: string): Promise<Element> {
    resetCookies({ [session.SESSION_COOKIE_NAME]: owner });
    const { doc } = await renderCheckout();
    const f = doc.querySelector("form");
    if (f === null) throw new Error("no form");
    return f;
  }

  test("validation errors: VALIDATION_FAILED with field errors, no order, no card data echoed", async () => {
    add(GUEST);
    const f = await readyForm(GUEST);
    const out = await redirectOrState(() => browserSubmit(f, { ...TYPED_NEW_ADDRESS, fullName: "", city: "" }).then((b) => placeOrderV2(null, b)));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toBe("VALIDATION_FAILED");
    expect(Object.keys(out.state?.fieldErrors ?? {})).toEqual(expect.arrayContaining(["fullName", "city"]));
    expect(cardLeaks(JSON.stringify(out.state))).toEqual([]);
  });

  test("payment decline: PAYMENT_FAILED, stock untouched, no redirect", async () => {
    add(GUEST);
    const stock = stockOf(db(), TOTE);
    const f = await readyForm(GUEST);
    const body = await browserSubmit(f, { ...TYPED_NEW_ADDRESS, number: "4000000000000002" });
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toBe("PAYMENT_FAILED");
    expect(stockOf(db(), TOTE)).toBe(stock);
  });

  test("stock changed between cart and pay: STOCK_CHANGED, no order; /checkout then renders the blocked state", async () => {
    add(GUEST, TOTE, 3);
    const f = await readyForm(GUEST);
    db().run("UPDATE products SET stock = 1 WHERE id = ?", [TOTE]);
    const body = await browserSubmit(f, TYPED_NEW_ADDRESS);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("state" in out)) throw new Error(`unexpected redirect ${out.url}`);
    expect(out.state?.error.code).toBe("STOCK_CHANGED");
    const { doc } = await renderCheckout();
    expect(doc.querySelectorAll("form").length).toBe(0);
    expectNotNull(doc.querySelector('[role="alert"]') ?? null);
  });

  test("success -> /orders/<id>?placed=1; the confirmation renders the spoken total and the typed address; noindex", async () => {
    add(GUEST2, TOTE, 2);
    const expectedTotal = view(GUEST2).totals.totalCents;
    const f = await readyForm(GUEST2);
    const body = await browserSubmit(f, TYPED_NEW_ADDRESS);
    const out = await redirectOrState(() => placeOrderV2(null, body));
    if (!("url" in out)) throw new Error(`no redirect: ${JSON.stringify(out.state?.error)}`);
    const m = /^\/orders\/([0-9a-f-]{36})\?placed=1/.exec(out.url);
    expect(m).not.toBeNull();
    const id = m?.[1] as string;
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST2 });
    const res = await outcomeOf(() => OrderPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ placed: "1" }) }));
    if (res.kind !== "ok") throw new Error(res.kind);
    const doc = parseHtml(renderToStaticMarkup(res.value));
    const totals = [...doc.querySelectorAll("dt")].filter((d) => (spokenText(d) ?? "").trim() === "Total").map((d) => spokenText(d.nextElementSibling));
    expect(totals.length).toBeGreaterThan(0);
    for (const t of totals) expect(t).toBe(usd(expectedTotal));
    const text = doc.body.textContent ?? "";
    for (const k of ["fullName", "line1", "city", "postalCode"] as const) expect(text).toContain(TYPED_NEW_ADDRESS[k] as string);
    expect(headingViolations(doc)).toEqual([]);
    const meta = await orderPage.generateMetadata({ params: Promise.resolve({ id }) });
    expect(JSON.stringify(meta.robots)).toContain('"index":false');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting
// ---------------------------------------------------------------------------

describe("cart/checkout cross-cutting (G rows, R-5, T170 AC3)", () => {
  async function chrome(page: () => Promise<React.ReactElement>, actions: Parameters<typeof serverLike>[0]) {
    const restore = serverLike(actions);
    try {
      const html = await withChrome(await page(), { HeaderShell, SiteFooter, storeName: SITE_NAME, columns: FOOTER_COLUMNS });
      return { html, doc: parseHtml(html) };
    } finally {
      restore();
    }
  }

  const scenarios: [string, () => void][] = [
    ["no cookie", () => resetCookies()],
    [
      "lines + coupon",
      () => {
        add(GUEST, TOTE, 3);
        createCartService().applyCoupon(GUEST, "WELCOME10");
        resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
      },
    ],
  ];

  test.each(scenarios)("%s: landmarks, one h1, unique ids, allow-listed hrefs, 44px targets, brand-free, light-only", async (_n, setup) => {
    setup();
    for (const [name, page, actions] of [
      ["cart", CartPage, CART_ACTIONS],
      ["checkout", CheckoutPage, [placeOrderV2]],
    ] as const) {
      const { html, doc } = await chrome(page, actions as unknown as Parameters<typeof serverLike>[0]);
      expect([name, landmarkViolations(doc, { chrome: true })]).toEqual([name, []]);
      expect([name, doc.querySelectorAll("h1").length]).toEqual([name, 1]);
      expect([name, duplicateIds(doc)]).toEqual([name, []]);
      expect([name, hrefViolations(doc, cartAllowed)]).toEqual([name, []]);
      const main = doc.querySelector("main") as Element;
      expect([name, smallTargets(main, inlineInText).filter((t) => t !== "a:Change in cart")]).toEqual([name, []]);
      expect([name, brandAndThemeViolations(html)]).toEqual([name, []]);
      expect([name, darkClassTokens(doc)]).toEqual([name, []]);
      expect([name, themeToggles(doc)]).toEqual([name, []]);
    }
  });

  // PIN: D-T161-2 — CheckoutForm v2 promo step: the "Change in cart" link next to the applied-coupon chip
  // (CheckoutFormV2.tsx:766, plain `<Link>`) is a standalone link without `min-h-touch` (not running text), so SR6 /
  // R3 44px targets apply.
  test("D-T161-2: the checkout 'Change in cart' link beside the coupon chip is a 44px target", async () => {
    add(GUEST, TOTE, 3);
    expect(createCartService().applyCoupon(GUEST, "WELCOME10").ok).toBe(true);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    const { doc } = await renderCheckout();
    expectNotNull(doc.querySelector('[data-testid="checkout-coupon"]') ?? null);
    expect(smallTargets(doc, inlineInText).filter((t) => t === "a:Change in cart")).toEqual([]);
  });

  test("metadata: /cart and /checkout noindex with their canonical paths (T170 AC3)", () => {
    for (const m of [cartPage.metadata, checkoutPage.metadata]) {
      expect(JSON.stringify(m.robots)).toContain('"index":false');
    }
  });

  test("the page alone never renders its own banner/main/contentinfo", async () => {
    add(GUEST);
    resetCookies({ [session.SESSION_COOKIE_NAME]: GUEST });
    expect(landmarkViolations((await renderCart()).doc, { chrome: false })).toEqual([]);
    expect(landmarkViolations((await renderCheckout()).doc, { chrome: false })).toEqual([]);
  });

  test("no session minted by any page render", async () => {
    const mint = spyOn(session, "getOrCreateSessionId");
    try {
      add(GUEST);
      for (const cookies of [{}, { [session.SESSION_COOKIE_NAME]: GUEST }] as Record<string, string>[]) {
        resetCookies(cookies);
        await renderCart();
        await renderCheckout();
        expect(qa.store.writes).toEqual([]);
      }
      expect(mint).not.toHaveBeenCalled();
    } finally {
      mint.mockRestore();
    }
  });
});
