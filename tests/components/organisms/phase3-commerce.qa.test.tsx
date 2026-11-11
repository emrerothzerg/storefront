// QA (T164, Phase 3 wave B2): cart/checkout organisms (T161) and account/orders/info organisms
// (T162) after the light-only restyle. Criteria: no behaviour change, Card surfaces, pills,
// superscript prices with identical accessible text, data-total-check, failure states still render
// (T164 AC4: decline, stock change, invalid coupon), destructive actions = danger + text label,
// order status = text + colour, contact limits 80/254/2000 + `feedback` topic.
// DOM nodes never go into `expect` inside waitFor (see @/test/dom-assertions).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Database } from "bun:sqlite";
import type { CartActionFn, CartActionFnV2, CartActionStateV2 } from "@/components/molecules/_contracts/cart-actions";
import type { CheckoutActionFnV2, CheckoutActionStateV2 } from "@/components/organisms/_contracts/checkout-actions";
import type { ContactActionFn } from "@/components/molecules/_contracts/contact-actions";
import { AccountHub } from "@/components/organisms/AccountHub";
import { AddressBook } from "@/components/organisms/AddressBook";
import { EMPTY_ADDRESSES_TEXT } from "@/components/organisms/AddressBook/address-book-model";
import { CartSummary, type CartSummaryActions } from "@/components/organisms/CartSummary";
import { CartTable, SavedForLaterSection, type CartTableLine } from "@/components/organisms/CartTable";
import { CheckoutForm, type CheckoutFormV2Config } from "@/components/organisms/CheckoutForm";
import { ContactSection } from "@/components/organisms/ContactSection";
import { FaqList } from "@/components/organisms/FaqList";
import { OrderDetail } from "@/components/organisms/OrderDetail";
import { makeOrderView } from "@/components/organisms/OrderDetail/order-view.fixtures";
import { OrderSummary } from "@/components/organisms/OrderSummary";
import { OrdersList } from "@/components/organisms/OrdersList";
import { isAllowedInternalHref } from "@/content/routes";
import { appError, fail, ok } from "@/lib/result";
import type { ShippingMethod } from "@/lib/types";
import { createCartService, type CartServiceV2, type CartViewV2 } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import type { ShippingQuote } from "@/server/pricing/shipping-service";

const ORG = join(import.meta.dir, "../../../src/components/organisms");
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "q" 's' ‮evil`;
const DARK_PREFIX = ["da", "rk:"].join("");
const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const usd = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

const parse = (html: string): Document => new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
const doc = (el: ReactElement): Document => parse(renderToStaticMarkup(el));
const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const classesOf = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
function hasClasses(el: Element | null | undefined, ...cls: string[]): boolean {
  const have = classesOf(el);
  return cls.every((c) => have.includes(c));
}
function allClasses(root: ParentNode): string[] {
  const nodes = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  return nodes.flatMap((n) => classesOf(n));
}
function expectTokenOnlyClasses(root: ParentNode, where: string) {
  const bad = allClasses(root).filter(
    (c) =>
      c.includes(DARK_PREFIX) ||
      /\[/.test(c) ||
      /(^|:)(bg|text|border|ring|fill|stroke)-(red|blue|green|gray|slate|zinc|neutral|stone|orange|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-\d/.test(c),
  );
  expect({ where, bad }).toEqual({ where, bad: [] });
}
function visibleText(root: ParentNode): string {
  const base = "body" in root && (root as Document).body ? (root as Document).body : root;
  const clone = base.cloneNode(true) as Element;
  for (const s of clone.querySelectorAll("script")) s.remove();
  return clone.textContent ?? "";
}
function expectBrandFree(d: Document) {
  const lower = d.body.innerHTML.toLowerCase();
  for (const word of ["kmart", "onepass", "afterpay", "zip pay"]) expect({ word, found: lower.includes(word) }).toEqual({ word, found: false });
  expect(/\btarget\b/i.test(visibleText(d))).toBe(false);
}
function expectHrefsAllowed(root: ParentNode) {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue; // in-page error-summary anchors
    expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
  }
}
/** T180/U18: summary money is plain ("$0.00", one text run, no superscript visual). */
function plainAmount(root: Element | null | undefined): { text: string; superscript: boolean } {
  return { text: (root?.textContent ?? "").trim(), superscript: root?.querySelector('[data-slot="price-superscript"]') != null };
}

// ---------------------------------------------------------------------------
// Real cart-service fixtures (seeded :memory: DB), as the pages pass them.
// ---------------------------------------------------------------------------

let db: Database;
let carts: CartServiceV2;
let catalog: { id: string; price: number; stock: number }[] = [];

beforeAll(() => {
  db = createDatabase(":memory:");
  runMigrations(db);
  seedDatabase(db, { now: new Date(NOW) });
  carts = createCartService(db, { now: () => NOW });
  catalog = db
    .query("SELECT id, price_cents AS price, stock FROM products WHERE stock >= 12 AND published_at <> '' AND published_at <= ? ORDER BY price_cents, id")
    .all("2026-11-07T11:00:00.000Z") as { id: string; price: number; stock: number }[];
});
afterAll(() => db.close());

function cartView(lines: { index: number; qty: number; stock?: number }[]): CartViewV2 {
  const sid = crypto.randomUUID();
  const restore: { id: string; stock: number }[] = [];
  for (const line of lines) {
    const p = catalog[line.index];
    if (p === undefined) throw new Error("catalog too small");
    if (!carts.addItem(sid, p.id, line.qty).ok) throw new Error("addItem");
    if (line.stock !== undefined) {
      restore.push({ id: p.id, stock: p.stock });
      db.query("UPDATE products SET stock = ? WHERE id = ?").run(line.stock, p.id);
    }
  }
  try {
    const view = carts.getCartView(sid, NOW);
    if (!view.ok) throw new Error("view");
    return view.value;
  } finally {
    for (const r of restore) db.query("UPDATE products SET stock = ? WHERE id = ?").run(r.stock, r.id);
  }
}

const OK_V2: CartActionStateV2 = ok({ itemCount: 1, subtotalCents: 0, message: "Updated" });
const noopV2: CartActionFnV2 = async () => OK_V2;
const SUMMARY_ACTIONS: CartSummaryActions = { applyCoupon: noopV2, removeCoupon: noopV2, setShippingMethod: noopV2 };

// ---------------------------------------------------------------------------
// CartSummary (T161)
// ---------------------------------------------------------------------------

describe("T161 CartSummary: Card, plain total (T180/U18), data-total-check, primary pill", () => {
  test("aside is a raised Card; total spoken text = server total; data-total-check=match; 'Proceed to checkout' is a full-width primary pill", () => {
    const view = cartView([{ index: 0, qty: 2 }]);
    const d = doc(<CartSummary cart={view} actions={SUMMARY_ACTIONS} now={NOW} />);
    const aside = d.querySelector("aside") as HTMLElement;
    expect(hasClasses(aside, "rounded-lg", "bg-surface-raised")).toBe(true);
    expect(aside.getAttribute("data-total-check")).toBe("match");
    const total = plainAmount(d.querySelector('[data-testid="cart-summary-total"]'));
    expect(total).toEqual({ text: usd(view.totals.totalCents), superscript: false });
    const checkout = [...d.querySelectorAll("a[href]")].find((a) => squash(a.textContent) === "Proceed to checkout");
    expect(checkout?.getAttribute("href")).toBe("/checkout");
    expect(hasClasses(checkout, "rounded-full", "bg-accent", "w-full", "min-h-touch")).toBe(true);
    expectTokenOnlyClasses(d.body, "CartSummary");
    expectBrandFree(d);
  });

  test("tampered total -> mismatch, still shown as given (spoken text)", () => {
    const view = cartView([{ index: 1, qty: 1 }]);
    const tampered = { ...view, totals: { ...view.totals, totalCents: view.totals.totalCents + 1 } };
    const d = doc(<CartSummary cart={tampered} actions={SUMMARY_ACTIONS} now={NOW} />);
    expect(d.querySelector("aside")?.getAttribute("data-total-check")).toBe("mismatch");
    expect(plainAmount(d.querySelector('[data-testid="cart-summary-total"]')).text).toBe(usd(tampered.totals.totalCents));
  });

  test("T164 AC4 stock change: a reduced line blocks checkout with the reason as text (no link)", () => {
    const view = cartView([{ index: 0, qty: 5, stock: 2 }]);
    const d = doc(<CartSummary cart={view} actions={SUMMARY_ACTIONS} now={NOW} />);
    expect([...d.querySelectorAll("a")].some((a) => squash(a.textContent) === "Proceed to checkout")).toBe(false);
    expect(squash(d.querySelector('[data-testid="cart-summary-blocked"]')?.textContent)).toBe("Some quantities are more than we have in stock — update them to continue");
    expect(d.querySelector("aside")?.getAttribute("data-can-checkout")).toBe("false");
  });

  test("T164 AC4 invalid coupon: server couponNotice renders as an alert; apply failure message renders", async () => {
    const view = cartView([{ index: 0, qty: 1 }]);
    const noticed = { ...view, couponNotice: "Code SAVE99 is not valid and was removed." };
    const d = doc(<CartSummary cart={noticed} actions={SUMMARY_ACTIONS} now={NOW} />);
    const alert = [...d.querySelectorAll('[role="alert"]')].find((n) => (n.textContent ?? "").includes("SAVE99"));
    expect(squash(alert?.textContent)).toContain("Code SAVE99 is not valid and was removed.");

    const failing: CartActionFnV2 = async () => fail("COUPON_INVALID", "That code isn't valid.");
    render(<CartSummary cart={view} actions={{ ...SUMMARY_ACTIONS, applyCoupon: failing }} now={NOW} />);
    const input = document.querySelector('input[name="couponCode"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    // CouponForm maps the error code to its own copy (unchanged from Phase 2).
    await waitFor(() => expect(document.querySelector('form [role="alert"]')?.textContent ?? "").toBe("That promo code is not valid."));
  });
});

// ---------------------------------------------------------------------------
// CartTable + SavedForLater (T161)
// ---------------------------------------------------------------------------

const noopCart: CartActionFn = async () => null;
const line = (n: number, over: Partial<CartTableLine> = {}): CartTableLine => ({
  productId: `qa-p${n}`,
  name: `QA Item ${n}`,
  slug: `qa-item-${n}`,
  imageUrl: `/images/qa-${n}.jpg`,
  quantity: 2,
  unitPriceCents: 1250,
  lineTotalCents: 2500,
  availableStock: 10,
  status: "ok",
  ...over,
});
function cartTable(lines: CartTableLine[], canCheckout = true) {
  return (
    <CartTable
      cart={{ items: lines, subtotalCents: 2500 * lines.length, currency: "USD", itemCount: 2 * lines.length, canCheckout }}
      updateQuantity={noopCart}
      removeItem={noopCart}
    />
  );
}
const savedLine = {
  productId: "qa-s1",
  product: { id: "qa-s1", slug: "qa-saved-1", name: "QA Saved 1", description: "", priceCents: 900, currency: "USD", imageUrl: "/images/s-1.jpg", stock: 3 },
  quantityDesired: 1,
  available: true,
  priceCents: 900,
  priceDroppedByCents: null,
  addedAt: "2026-11-07T10:00:00.000Z",
};

describe("T161 CartTable / SavedForLater", () => {
  test("stock-change states keep their text messages (status role), unavailable/reduced lines disable the stepper", () => {
    const d = doc(cartTable([line(1), line(2, { status: "unavailable", availableStock: 0 }), line(3, { status: "reduced", availableStock: 1 })], false));
    const statuses = [...d.querySelectorAll('[role="status"]')].map((n) => squash(n.textContent));
    expect(statuses).toContain("No longer available");
    expect(statuses).toContain("Only 1 left. Lower the quantity to continue.");
    expect(statuses.some((s) => s.startsWith("Remove unavailable items"))).toBe(true);
    expect(d.querySelector('a[href="/checkout"]')).toBeNull();
  });

  test("line totals: accessible text is the full amount", () => {
    const d = doc(cartTable([line(1, { quantity: 3, unitPriceCents: 1999 })]));
    const total = d.querySelector('[data-testid="line-total"]');
    expect(squash(total?.textContent)).toContain("$59.97");
  });

  test("saved-for-later 'Delete' is a danger pill with a text label; 'Move to cart' is a pill", () => {
    const d = doc(<SavedForLaterSection items={[savedLine]} actions={{ moveToCart: noopV2, removeSaved: async () => null }} saveForLaterListId="qa-saved-list" />);
    const section = d.querySelector("section") as HTMLElement;
    expect(hasClasses(section, "rounded-lg", "bg-surface-raised")).toBe(true);
    const del = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Delete");
    expect(del?.getAttribute("aria-label")).toBe("Delete: QA Saved 1");
    expect(hasClasses(del, "bg-danger", "rounded-full", "min-h-touch")).toBe(true);
    const move = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Move to cart");
    expect(hasClasses(move, "rounded-full", "min-h-touch")).toBe(true);
  });

  // PIN: D-T161-1 — T161 AC2 "destructive actions use danger role with text labels": the cart
  // line "Remove" button (CartLineItem molecule) is a danger button (fixed in CLEANUP-P3).
  test("D-T161-1: cart line 'Remove' uses the danger role (with its text label)", () => {
    const d = doc(cartTable([line(1)]));
    const remove = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Remove");
    expect(remove?.getAttribute("aria-label")).toBe("Remove QA Item 1");
    expect(classesOf(remove).some((c) => /(^|:)(bg|text|border)-danger/.test(c))).toBe(true);
  });

  test("hostile line name stays text; hrefs allow-listed; token-only classes", () => {
    const d = doc(cartTable([line(1, { name: HOSTILE }), line(2, { slug: "javascript:alert(1)" })]));
    expect(d.querySelectorAll('img[src="x"]')).toHaveLength(0);
    for (const s of d.querySelectorAll("script")) expect(s.textContent?.includes("alert(")).toBe(false);
    expect(visibleText(d)).toContain(HOSTILE);
    expectHrefsAllowed(d);
    expectTokenOnlyClasses(d.body, "CartTable");
  });
});

// ---------------------------------------------------------------------------
// CheckoutForm v2 failure states (T164 AC4) + OrderSummary
// ---------------------------------------------------------------------------

function method(id: string, name: string, priceCents: number): ShippingMethod {
  return { id, name, description: "", priceCents, freeOverCents: null, minDays: 1, maxDays: 5, sortOrder: 1, isActive: true };
}
const STANDARD: ShippingQuote = { method: method("standard", "Standard", 599), priceCents: 599, isFree: false, amountToFreeCents: null };

function checkoutConfig(action: CheckoutActionFnV2, over: Partial<CheckoutFormV2Config> = {}): CheckoutFormV2Config {
  return {
    action,
    savedAddresses: [],
    shipping: { options: [STANDARD], selectedId: "standard", currency: "USD", now: NOW },
    summary: { items: [{ productId: "p1", name: "Mug", quantity: 2, unitPriceCents: 1500 }], subtotalCents: 3000, discountCents: 0, shippingCents: 599, totalCents: 3599 },
    coupon: null,
    isSignedIn: false,
    ...over,
  };
}
function failure(code: Parameters<typeof appError>[0], msg: string, details?: Readonly<Record<string, unknown>>): CheckoutActionStateV2 {
  return { ok: false, error: appError(code, msg, details) };
}
function renderCheckout(result: CheckoutActionStateV2) {
  const action: CheckoutActionFnV2 = async () => result;
  render(<CheckoutForm initialIdempotencyKey="qa-key-0001" v2={checkoutConfig(action)} />);
  fireEvent.submit(screen.getByRole("form", { name: "Checkout" }));
}
async function alertWithHeading(name: RegExp): Promise<string> {
  const heading = await screen.findByRole("heading", { name });
  return squash(heading.closest('[role="alert"]')?.textContent);
}

describe("T164 AC4: checkout failure states still render (T161 restyle)", () => {
  test("payment declined", async () => {
    renderCheckout(failure("PAYMENT_FAILED", "Your card was declined."));
    const text = await alertWithHeading(/payment didn't go through/i);
    expect(text).toContain("Your card was declined.");
    expect(text).toContain("Try a different card");
  });

  test("stock changed (hostile product name stays text) with a link back to the cart", async () => {
    renderCheckout(failure("STOCK_CHANGED", "Stock changed.", { lines: [{ productId: "p1", name: HOSTILE, requested: 2, available: 1 }, { productId: "p2", name: "Lamp", requested: 1, available: 0 }] }));
    const text = await alertWithHeading(/items in your cart changed/i);
    expect(text).toContain(`${HOSTILE}: you asked for 2, only 1 available.`);
    expect(text).toContain("Lamp: no longer available.");
    expect(document.querySelector('img[src="x"]')).toBeNull();
    const link = screen.getByRole("link", { name: "Review your cart" });
    expect(link.getAttribute("href")).toBe("/cart");
  });

  test("invalid coupon: nothing charged, 'Change in cart' link", async () => {
    renderCheckout(failure("COUPON_INVALID", "That code isn't valid."));
    const text = await alertWithHeading(/promo code can't be used/i);
    expect(text).toContain("That code isn't valid.");
    expect(text).toContain("Nothing was charged");
    expect(screen.getByRole("link", { name: "Change in cart" }).getAttribute("href")).toBe("/cart");
  });

  test("static markup: 6 Card step panels, 'Place order' primary pill, review totals spoken in full, data-total-check", () => {
    const action: CheckoutActionFnV2 = async () => null;
    const d = doc(<CheckoutForm initialIdempotencyKey="qa-key-0001" v2={checkoutConfig(action)} />);
    const steps = [...d.querySelectorAll("section[aria-labelledby^='checkout-step-']")];
    expect(steps).toHaveLength(6);
    for (const s of steps) expect(hasClasses(s, "rounded-lg", "bg-surface-raised")).toBe(true);
    const place = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Place order");
    expect(hasClasses(place, "rounded-full", "bg-accent", "w-full")).toBe(true);
    const summary = d.querySelector("[data-total-check]");
    expect(summary?.getAttribute("data-total-check")).toBe("match");
    expect(visibleText(summary ?? d)).toContain("$35.99");
    expectTokenOnlyClasses(d.body, "CheckoutForm");
    expectBrandFree(d);
  });
});

describe("T161 OrderSummary", () => {
  test("Card section; Total is plain '$41.98' (T180/U18); data-total-check=match; mismatch still shows the given total", () => {
    const view = makeOrderView();
    const props = {
      items: view.items.map((i) => ({ productId: i.productId, name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
      subtotalCents: view.subtotalCents,
      discountCents: view.discountCents,
      shippingCents: view.shippingCents,
      totalCents: view.totalCents,
      currency: "USD",
    };
    const d = doc(<OrderSummary {...props} />);
    const section = d.querySelector("[data-total-check]") as HTMLElement;
    expect(section.getAttribute("data-total-check")).toBe("match");
    expect(hasClasses(section, "rounded-lg")).toBe(true);
    const totalDd = [...section.querySelectorAll("dt")].find((dt) => squash(dt.textContent) === "Total")?.nextElementSibling;
    expect(plainAmount(totalDd)).toEqual({ text: "$41.98", superscript: false });
    const bad = doc(<OrderSummary {...props} totalCents={4199} />);
    expect(bad.querySelector("[data-total-check]")?.getAttribute("data-total-check")).toBe("mismatch");
    const badDd = [...bad.querySelectorAll("dt")].find((dt) => squash(dt.textContent) === "Total")?.nextElementSibling;
    expect(plainAmount(badDd).text).toBe("$41.99");
  });
});

// ---------------------------------------------------------------------------
// Account, orders, info organisms (T162)
// ---------------------------------------------------------------------------

const noopForm = async () => undefined;
const PLACED = Date.parse("2026-11-07T10:00:00.000Z");

describe("T162 OrderDetail / OrdersList", () => {
  test("order status is text plus a colour tone; panels are Cards; Cancel order = danger pill with text; total spoken in full", () => {
    const seen: Record<string, { label: string; bg: string }> = {};
    for (const status of ["processing", "shipped", "delivered", "cancelled"] as const) {
      const d = doc(<OrderDetail order={makeOrderView({ fulfillmentStatus: status })} variant="detail" buyAgainAction={noopForm} cancelAction={async () => null} now={PLACED + 60_000} paymentBrand="Visa" />);
      // Status badge: the header pill = a span holding a decorative icon span and its text label.
      const badge = [...d.querySelectorAll("header span")].find((s) => s.querySelector(':scope > span[aria-hidden="true"]') !== null && classesOf(s).some((c) => c.startsWith("bg-")));
      const label = squash(badge?.textContent);
      const bg = classesOf(badge).find((c) => c.startsWith("bg-")) ?? "";
      expect({ status, hasText: label.length > 2, hasTone: bg !== "" && classesOf(badge).some((c) => c.startsWith("text-")) }).toEqual({ status, hasText: true, hasTone: true });
      seen[status] = { label, bg };
    }
    // Problem states are told apart by text AND tone (not colour only, not text only).
    expect(seen).toEqual({
      processing: { label: "Processing", bg: "bg-surface-sunken" },
      shipped: { label: "Shipped", bg: "bg-info-subtle" },
      delivered: { label: "Delivered", bg: "bg-success-subtle" },
      cancelled: { label: "Cancelled", bg: "bg-danger-subtle" },
    });
    const d = doc(<OrderDetail order={makeOrderView()} variant="detail" buyAgainAction={noopForm} cancelAction={async () => null} now={PLACED + 60_000} paymentBrand="Visa" />);
    for (const slot of ["order-items", "order-ship-to", "order-payment", "order-cancel"]) {
      expect({ slot, card: hasClasses(d.querySelector(`[data-slot="${slot}"]`), "rounded-lg", "bg-surface-raised") }).toEqual({ slot, card: true });
    }
    const cancel = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Cancel order");
    expect(hasClasses(cancel, "bg-danger", "rounded-full")).toBe(true);
    expect(d.querySelector("[data-total-check]")?.getAttribute("data-total-check")).toBe("match");
    expect(visibleText(d)).toContain("$41.98");
    expect(d.body.innerHTML).not.toContain("jane.secret@example.com");
    expectHrefsAllowed(d);
    expectTokenOnlyClasses(d.body, "OrderDetail");
  });

  test("orders empty state keeps its copy and link in a sunken Card; Buy Again tile price is superscript with spoken '$12.50'", () => {
    const empty = doc(<OrdersList orders={[]} tab="orders" range="3m" query="" page={1} pageCount={0} buyAgainProducts={[]} actions={{ buyAgain: noopForm, addToCart: noopForm }} />);
    const box = empty.querySelector('[data-slot="orders-empty"]');
    expect(hasClasses(box, "rounded-lg", "bg-surface-sunken")).toBe(true);
    expect(squash(box?.textContent)).toContain("No orders yet");
    expect(box?.querySelector('a[href="/products"]')?.textContent).toBe("Start shopping");
    const again = doc(
      <OrdersList
        orders={[]}
        tab="buy-again"
        range="3m"
        query=""
        page={1}
        pageCount={0}
        buyAgainProducts={[{ productId: "a", slug: "qa-a", name: HOSTILE, imageUrl: null, priceCents: 1250, currency: "USD", inStock: true }]}
        actions={{ buyAgain: noopForm, addToCart: noopForm }}
      />,
    );
    const sup = again.querySelector('[data-slot="price-superscript"]');
    expect(sup?.getAttribute("aria-hidden")).toBe("true");
    expect(squash(sup?.parentElement?.querySelector(".sr-only")?.textContent)).toBe("$12.50");
    expect(again.querySelectorAll('img[src="x"]')).toHaveLength(0);
    expectHrefsAllowed(again);
  });
});

describe("T162 AddressBook / AccountHub / ContactSection / FaqList", () => {
  const addressActions = { save: noopForm, delete: noopForm, setDefault: noopForm } as unknown as Parameters<typeof AddressBook>[0]["actions"];

  test("address book empty state keeps its copy; add form sits in a Card", () => {
    const d = doc(<AddressBook addresses={[]} actions={addressActions} />);
    expect(visibleText(d)).toContain(EMPTY_ADDRESSES_TEXT);
    const form = d.querySelector("form");
    expect(form).not.toBeNull();
    const card = form?.closest(".rounded-lg");
    expect(card).not.toBeNull();
    expectTokenOnlyClasses(d.body, "AddressBook");
  });

  test("account hub (guest): sign-in / sign-up links, Card tiles, hrefs allow-listed, brand-free", () => {
    const counts = { orders: 0, lists: 0, addresses: 0, history: 0, reviews: 0, questions: 0, alerts: 0, messages: 0 };
    const d = doc(<AccountHub user={null} counts={counts} backInStock={[]} />);
    const hrefs = [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/signin");
    expect(hrefs).toContain("/signup");
    expect(d.querySelectorAll(".rounded-lg").length).toBeGreaterThan(2);
    expectHrefsAllowed(d);
    expectTokenOnlyClasses(d.body, "AccountHub");
    expectBrandFree(d);
  });

  test("contact form limits 80 / 254 / 2000 and the 'feedback' topic is offered and preselectable (L-21)", () => {
    const noopContact: ContactActionFn = async () => null;
    const d = doc(<ContactSection action={noopContact} initialTopic="feedback" />);
    expect(d.querySelector('input[name="name"]')?.getAttribute("maxLength") ?? d.querySelector('input[name="name"]')?.getAttribute("maxlength")).toBe("80");
    expect(d.querySelector('input[name="email"]')?.getAttribute("maxLength") ?? d.querySelector('input[name="email"]')?.getAttribute("maxlength")).toBe("254");
    expect(d.querySelector('textarea[name="message"]')?.getAttribute("maxLength") ?? d.querySelector('textarea[name="message"]')?.getAttribute("maxlength")).toBe("2000");
    const feedback = d.querySelector('select[name="topic"] option[value="feedback"]');
    expect(feedback).not.toBeNull();
    expect(feedback?.hasAttribute("selected")).toBe(true);
    for (const field of d.querySelectorAll("input:not([type='hidden']):not([name='website']), select, textarea")) {
      expect({ id: field.id, labelled: d.querySelector(`label[for="${field.id}"]`) !== null }).toEqual({ id: field.id, labelled: true });
    }
    expectTokenOnlyClasses(d.body, "ContactSection");
  });

  test("FAQ entries are bordered native disclosures; hostile text stays text", () => {
    const d = doc(<FaqList entries={[{ slug: "a", question: HOSTILE, answer: [HOSTILE], topic: "ordering", relatedHrefs: ["/shipping"] }, { slug: "b", question: "B?", answer: ["B."], topic: "ordering" }]} openSlug="b" />);
    const details = [...d.querySelectorAll("details")];
    expect(details).toHaveLength(2);
    expect(details[1]?.hasAttribute("open")).toBe(true);
    expect(details[0]?.hasAttribute("open")).toBe(false);
    expect(d.querySelectorAll('img[src="x"]')).toHaveLength(0);
    expect(visibleText(d)).toContain(HOSTILE);
    expectHrefsAllowed(d);
  });
});

describe("source hygiene (T161/T162 files)", () => {
  const files = [
    "CartTable/CartTable.tsx",
    "CartTable/SavedForLaterSection.tsx",
    "CartSummary/CartSummary.tsx",
    "CheckoutForm/CheckoutFormV2.tsx",
    "CheckoutForm/checkout-form-shared.tsx",
    "OrderSummary/OrderSummary.tsx",
    "AccountHub/AccountHub.tsx",
    "AddressBook/AddressBook.tsx",
    "AddressBook/AddressBookList.tsx",
    "OrdersList/OrdersList.tsx",
    "OrderDetail/OrderDetail.tsx",
    "ContactSection/ContactSection.tsx",
    "FaqList/FaqList.tsx",
  ];
  for (const file of files) {
    test(`${file}: no any, ts-ignore, dangerouslySetInnerHTML, style=, dark variant`, () => {
      const src = readFileSync(join(ORG, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toContain("@ts-ignore");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/style=\{/);
      expect(src.includes(DARK_PREFIX)).toBe(false);
    });
  }
});
