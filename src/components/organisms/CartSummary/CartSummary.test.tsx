import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import { ok } from "@/lib/result";
import type { ShippingMethod } from "@/lib/types";
import type { CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import type { CartLineView, CartViewV2 } from "@/server/cart/cart-service";
import type { ValidatedCoupon } from "@/server/pricing/coupon-service";
import type { ShippingQuote } from "@/server/pricing/shipping-service";
import { computeTotals } from "@/server/pricing/totals";
import { OrderSummary } from "../OrderSummary";
import { computeOrderSummaryTotal } from "../OrderSummary/order-summary-helpers";
import {
  CHECKOUT_BLOCKED_TEXT,
  CartSummary,
  billableLineQuantity,
  cartSummaryTotalCheck,
  checkoutState,
  itemCountLabel,
  resolveCheckoutHref,
  resolveCurrency,
  subtotalLabel,
  toOrderSummaryItems,
  toOrderSummaryTotalInput,
  type CartSummaryActions,
  type CartSummaryCart,
} from ".";

// ---------------------------------------------------------------------------
// Fixtures: built with the real pricing arithmetic (computeTotals), exactly as
// getCartView does, so the server totals are realistic.
// ---------------------------------------------------------------------------

const STANDARD: ShippingMethod = {
  id: "standard",
  name: "Standard",
  description: "3-5 business days",
  priceCents: 599,
  freeOverCents: 3500,
  minDays: 3,
  maxDays: 5,
  sortOrder: 1,
  isActive: true,
};
const EXPRESS: ShippingMethod = {
  id: "express",
  name: "Express",
  description: "1-2 business days",
  priceCents: 1499,
  freeOverCents: null,
  minDays: 1,
  maxDays: 2,
  sortOrder: 2,
  isActive: true,
};

function quote(method: ShippingMethod, subtotalCents: number): ShippingQuote {
  const free = method.freeOverCents !== null && subtotalCents >= method.freeOverCents;
  return {
    method,
    priceCents: free ? 0 : method.priceCents,
    isFree: free,
    amountToFreeCents: method.freeOverCents === null ? null : Math.max(0, method.freeOverCents - subtotalCents),
  };
}

function line(productId: string, unitPriceCents: number, quantity: number, stock = 99, name = `Product ${productId}`): CartLineView {
  const status = stock === 0 ? "unavailable" : quantity > stock ? "reduced" : "ok";
  const billable = status === "unavailable" ? 0 : Math.min(quantity, stock);
  return {
    productId,
    quantity,
    unitPriceCents: stock === 0 ? 0 : unitPriceCents,
    status,
    name,
    slug: productId,
    imageUrl: "/x.svg",
    availableStock: stock,
    lineTotalCents: (stock === 0 ? 0 : unitPriceCents) * billable,
  };
}

function coupon(code: string, kind: ValidatedCoupon["kind"], value: number, description = "Promo"): ValidatedCoupon {
  return { code, kind, value, promoted: false, description };
}

interface BuildOptions {
  readonly lines: readonly CartLineView[];
  readonly coupon?: ValidatedCoupon | null;
  readonly methodId?: string;
  readonly methods?: readonly ShippingMethod[];
  readonly savedCount?: number;
  readonly couponNotice?: string | null;
}

function buildCart(options: BuildOptions): CartViewV2 {
  const { lines, methods = [STANDARD, EXPRESS] } = options;
  const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const shippingOptions = lines.length === 0 ? [] : methods.map((m) => quote(m, subtotalCents));
  const shipping =
    shippingOptions.find((q) => q.method.id === options.methodId) ??
    [...shippingOptions].sort((a, b) => a.priceCents - b.priceCents)[0] ??
    null;
  const c = options.coupon ?? null;
  const totals = computeTotals({ subtotalCents, coupon: c, shipping });
  if (!totals.ok) throw new Error(totals.error.message);
  return {
    sessionId: "00000000-0000-4000-8000-000000000000",
    items: lines,
    subtotalCents,
    currency: "USD",
    itemCount: lines.reduce((sum, l) => sum + l.quantity, 0),
    canCheckout: lines.length > 0 && lines.every((l) => l.status !== "unavailable"),
    saved: Array.from({ length: options.savedCount ?? 0 }, (_, i) => ({
      productId: `s${i}`,
      product: null,
      quantityDesired: 1,
      available: false,
      priceCents: null,
      priceDroppedByCents: null,
      addedAt: "2026-11-07T00:00:00.000Z",
    })),
    coupon: c,
    couponNotice: options.couponNotice ?? null,
    shipping,
    shippingOptions,
    totals: totals.value,
  };
}

const FIXTURES = {
  singleUnderThreshold: buildCart({ lines: [line("a", 2000, 1)] }),
  oneLineTwoUnits: buildCart({ lines: [line("a", 1250, 2)] }),
  overThresholdFree: buildCart({ lines: [line("a", 2000, 1), line("b", 1999, 1)] }),
  percentExpress: buildCart({ lines: [line("a", 3333, 1)], coupon: coupon("SAVE15", "percent", 15), methodId: "express" }),
  fixedCoupon: buildCart({ lines: [line("a", 1000, 3)], coupon: coupon("FIVEOFF", "fixed", 500) }),
  fixedBiggerThanSubtotal: buildCart({ lines: [line("a", 300, 1)], coupon: coupon("BIG", "fixed", 5000), methodId: "express" }),
  freeShippingCoupon: buildCart({ lines: [line("a", 1000, 1)], coupon: coupon("SHIPFREE", "free_shipping", 0) }),
  reducedLine: buildCart({ lines: [line("a", 1500, 5, 2), line("b", 700, 1)] }),
  unavailableLine: buildCart({ lines: [line("a", 1500, 1, 0), line("b", 700, 2)] }),
  allUnavailable: buildCart({ lines: [line("a", 1500, 1, 0)] }),
  exactThreshold: buildCart({ lines: [line("a", 3500, 1)] }),
} satisfies Record<string, CartViewV2>;

const noop: CartActionFnV2 = async () => null;
const ACTIONS: CartSummaryActions = { applyCoupon: noop, removeCoupon: noop, setShippingMethod: noop };

// React appends its form-replay bootstrap <script> when a form action is a
// plain function (test doubles); real server actions render a POST action.
// Strip it so assertions only see CartSummary's own markup.
const REPLAY_SCRIPT = /<script>addEventListener\("submit"[\s\S]*?<\/script>/g;

function html(cart: CartSummaryCart, extra: Partial<Parameters<typeof CartSummary>[0]> = {}): string {
  return renderToStaticMarkup(<CartSummary cart={cart} actions={ACTIONS} {...extra} />).replace(REPLAY_SCRIPT, "");
}

function parse(markup: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = markup;
  return div;
}

function ddText(root: HTMLElement, label: string): string {
  const dt = Array.from(root.querySelectorAll("dt")).find((el) => el.textContent === label);
  if (!dt) throw new Error(`no dt "${label}"`);
  return dt.nextElementSibling?.textContent ?? "";
}

/** Text a screen reader announces: `textContent` without `aria-hidden` subtrees (the superscript visual). */
function spokenText(el: Element | null | undefined): string {
  if (!el) return "";
  const clone = el.cloneNode(true) as Element;
  for (const hidden of Array.from(clone.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
  return clone.textContent ?? "";
}

function ddSpoken(root: HTMLElement, label: string): string {
  const dt = Array.from(root.querySelectorAll("dt")).find((el) => el.textContent === label);
  if (!dt) throw new Error(`no dt "${label}"`);
  return spokenText(dt.nextElementSibling);
}

// Type-level check: the full getCartView result fits the prop as is.
function acceptsView(view: CartViewV2): CartSummaryCart {
  return view;
}

// ---------------------------------------------------------------------------

describe("helpers", () => {
  test("itemCountLabel singular/plural; invalid counts read as 0", () => {
    expect(itemCountLabel(1)).toBe("1 item");
    expect(itemCountLabel(0)).toBe("0 items");
    expect(itemCountLabel(2)).toBe("2 items");
    expect(itemCountLabel(Number.NaN)).toBe("0 items");
    expect(itemCountLabel(-1)).toBe("0 items");
    expect(itemCountLabel(1.5)).toBe("0 items");
    expect(subtotalLabel(1)).toBe("Subtotal (1 item)");
  });

  test("billableLineQuantity mirrors the service line total", () => {
    expect(billableLineQuantity(line("a", 100, 5, 2))).toBe(2);
    expect(billableLineQuantity(line("a", 100, 1, 0))).toBe(0);
    expect(billableLineQuantity({ ...line("a", 100, 3), availableStock: Number.NaN })).toBe(0);
    expect(billableLineQuantity({ ...line("a", 100, -3) })).toBe(0);
  });

  test("checkoutState derives every reason", () => {
    expect(checkoutState(FIXTURES.singleUnderThreshold)).toEqual({ canCheckout: true });
    expect(checkoutState(buildCart({ lines: [], savedCount: 1 }))).toMatchObject({ reason: "empty" });
    expect(checkoutState(FIXTURES.allUnavailable)).toMatchObject({ reason: "allUnavailable" });
    expect(checkoutState(FIXTURES.unavailableLine)).toMatchObject({ reason: "someUnavailable" });
    // Service says yes for a reduced line; the UI keeps the stricter rule.
    expect(FIXTURES.reducedLine.canCheckout).toBe(true);
    expect(checkoutState(FIXTURES.reducedLine)).toMatchObject({ reason: "reduced" });
    expect(checkoutState({ ...FIXTURES.singleUnderThreshold, canCheckout: false })).toMatchObject({ reason: "unknown" });
  });

  test("resolveCheckoutHref keeps allowed internal hrefs only", () => {
    expect(resolveCheckoutHref(undefined)).toBe("/checkout");
    expect(resolveCheckoutHref("/checkout?step=1")).toBe("/checkout?step=1");
    for (const bad of ["https://evil.example/checkout", "//evil.example", "javascript:alert(1)", "checkout", ""]) {
      expect(resolveCheckoutHref(bad)).toBe("/checkout");
    }
  });

  test("resolveCurrency: prop, then cart, then USD; unknown codes skipped", () => {
    expect(resolveCurrency("EUR", "USD")).toBe("EUR");
    expect(resolveCurrency(undefined, "GBP")).toBe("GBP");
    expect(resolveCurrency("NOPE!", undefined)).toBe("USD");
    expect(resolveCurrency("", "")).toBe("USD");
  });

  test("a full CartViewV2 is accepted unchanged", () => {
    expect(acceptsView(FIXTURES.singleUnderThreshold).items).toHaveLength(1);
  });
});

describe("D-T92-1: toOrderSummaryItems is additive", () => {
  test("keeps every line field (incl. name) and overrides only quantity with the billable quantity", () => {
    const first = line("a", 1000, 5, 2, "Tote bag");
    const view = buildCart({ lines: [first, line("b", 500, 1)] });
    const items = toOrderSummaryItems(view);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ ...first, quantity: 2 });
    expect(items[0]?.name).toBe("Tote bag");
    expect(items[1]?.name).toBe("Product b");
    expect(items[1]?.quantity).toBe(1);
  });

  test("does not mutate the input lines", () => {
    const view = buildCart({ lines: [line("a", 1000, 5, 2)] });
    toOrderSummaryItems(view);
    expect(view.items[0]?.quantity).toBe(5);
  });

  test("a trimmed CartSummaryLine without name still works (generic over the line type)", () => {
    const items = toOrderSummaryItems({
      items: [{ productId: "p", quantity: 3, unitPriceCents: 100, status: "unavailable", availableStock: 0 }],
    });
    expect(items).toEqual([{ productId: "p", quantity: 0, unitPriceCents: 100, status: "unavailable", availableStock: 0 }]);
  });

  test("non-array items yields []", () => {
    expect(toOrderSummaryItems({ items: null as unknown as readonly CartLineView[] })).toEqual([]);
  });
});

describe("criterion 3: totals identical to OrderSummary", () => {
  for (const [name, cart] of Object.entries(FIXTURES)) {
    test(`${name}: server total equals computeOrderSummaryTotal and both organisms show the same Total`, () => {
      const computed = computeOrderSummaryTotal(toOrderSummaryTotalInput(cart));
      expect(computed.ok).toBe(true);
      if (!computed.ok) return;
      expect(computed.value).toBe(cart.totals.totalCents);
      expect(cartSummaryTotalCheck(cart)).toBe("match");

      const summary = parse(html(cart));
      expect(summary.querySelector("aside")?.getAttribute("data-total-check")).toBe("match");

      const order = parse(
        renderToStaticMarkup(
          <OrderSummary
            items={toOrderSummaryItems(cart)}
            subtotalCents={cart.totals.subtotalCents}
            discountCents={cart.totals.discountCents}
            couponCode={cart.coupon?.code ?? null}
            shippingCents={cart.totals.shippingCents}
            totalCents={cart.totals.totalCents}
            currency={cart.currency}
          />,
        ),
      );
      expect(order.querySelector("section")?.getAttribute("data-total-check")).toBe("match");
      expect(ddText(summary, "Total")).toBe(ddText(order, "Total"));
      if (cart.totals.discountCents > 0) {
        const label = `Discount (${cart.coupon?.code ?? ""})`;
        expect(ddText(summary, label)).toBe(ddText(order, label));
      }
    });
  }

  test("a tampered total is displayed as given but flagged mismatch", () => {
    const cart = { ...FIXTURES.singleUnderThreshold, totals: { ...FIXTURES.singleUnderThreshold.totals, totalCents: 1 } };
    const root = parse(html(cart));
    expect(root.querySelector("aside")?.getAttribute("data-total-check")).toBe("mismatch");
    expect(ddSpoken(root, "Total")).toBe("$0.01");
  });

  test("U18: Total uses the same plain format as every other row ($0.00, no superscript)", () => {
    const root = parse(html(FIXTURES.singleUnderThreshold));
    const total = root.querySelector('[data-testid="cart-summary-total"]');
    expect(total?.querySelector('[data-slot="price-superscript"]')).toBeNull();
    expect(root.querySelector('[data-slot="price-superscript"]')).toBeNull();
    expect(total?.textContent).toBe(ddSpoken(root, "Total"));
    expect(total?.textContent ?? "").toMatch(/^\$\d[\d,]*\.\d{2}$/);
    expect(ddText(root, "Subtotal (1 item)")).toBe("$20.00");
  });
});

describe("criterion 4: subtotal count", () => {
  test('one unit reads "Subtotal (1 item)"', () => {
    const root = parse(html(FIXTURES.singleUnderThreshold));
    expect(ddText(root, "Subtotal (1 item)")).toBe("$20.00");
  });
  test("one line of two units reads (2 items)", () => {
    expect(parse(html(FIXTURES.oneLineTwoUnits)).textContent).toContain("Subtotal (2 items)");
  });
  test("two lines read (2 items)", () => {
    expect(parse(html(FIXTURES.overThresholdFree)).textContent).toContain("Subtotal (2 items)");
  });
});

describe("criterion 1: checkout link vs reason, empty cart", () => {
  test("empty cart (no lines, nothing saved) renders nothing", () => {
    expect(html(buildCart({ lines: [] }))).toBe("");
  });

  test("canCheckout: one Proceed to checkout button link to /checkout, no reason", () => {
    render(<CartSummary cart={FIXTURES.singleUnderThreshold} actions={ACTIONS} />);
    const aside = screen.getByRole("complementary", { name: "Order summary" });
    const link = within(aside).getByRole("link", { name: "Proceed to checkout" });
    expect(link).toHaveAttribute("href", "/checkout");
    expect(within(aside).queryByTestId("cart-summary-blocked")).toBeNull();
    expect(aside).toHaveAttribute("data-can-checkout", "true");
  });

  test("custom checkoutHref is used; hostile one falls back", () => {
    expect(html(FIXTURES.singleUnderThreshold, { checkoutHref: "/checkout?from=cart" })).toContain('href="/checkout?from=cart"');
    const hostile = html(FIXTURES.singleUnderThreshold, { checkoutHref: "javascript:alert(1)" });
    expect(hostile).toContain('href="/checkout"');
    expect(hostile).not.toContain('href="javascript:');
  });

  const blockedCases: Array<[string, CartSummaryCart, string]> = [
    ["some unavailable", FIXTURES.unavailableLine, CHECKOUT_BLOCKED_TEXT.someUnavailable],
    ["all unavailable", FIXTURES.allUnavailable, CHECKOUT_BLOCKED_TEXT.allUnavailable],
    ["reduced", FIXTURES.reducedLine, CHECKOUT_BLOCKED_TEXT.reduced],
    ["saved only", buildCart({ lines: [], savedCount: 2 }), CHECKOUT_BLOCKED_TEXT.empty],
    ["service says no", { ...FIXTURES.singleUnderThreshold, canCheckout: false }, CHECKOUT_BLOCKED_TEXT.unknown],
  ];
  for (const [name, cart, text] of blockedCases) {
    test(`${name}: no checkout link or button, reason as text`, () => {
      const markup = html(cart);
      const root = parse(markup);
      expect(markup).not.toContain("Proceed to checkout");
      expect(root.querySelector('a[href^="/checkout"]')).toBeNull();
      expect(root.querySelector("aside")?.getAttribute("data-can-checkout")).toBe("false");
      expect(root.querySelector('[data-testid="cart-summary-blocked"]')?.textContent).toBe(text);
    });
  }

  test("saved-only cart shows the subtotal and the reason but no coupon/shipping forms or totals", () => {
    const root = parse(html(buildCart({ lines: [], savedCount: 1 })));
    expect(root.textContent).toContain("Subtotal (0 items)");
    expect(root.querySelectorAll("form")).toHaveLength(0);
    expect(root.textContent).not.toContain("Total");
    expect(root.querySelector("aside")?.hasAttribute("data-total-check")).toBe(false);
  });
});

describe("criterion 2: separate forms, none nested", () => {
  function assertForms(markup: string, expected: number): void {
    const root = parse(markup);
    const forms = Array.from(root.querySelectorAll("form"));
    expect(forms).toHaveLength(expected);
    expect((markup.match(/<form/g) ?? []).length).toBe(expected);
    for (const form of forms) expect(form.parentElement?.closest("form")).toBeNull();
    expect(root.querySelector("aside")?.closest("form")).toBeNull();
  }

  test("no coupon: apply form + shipping form (2)", () => {
    const markup = html(FIXTURES.singleUnderThreshold);
    assertForms(markup, 2);
    expect(markup).toContain('name="couponCode"');
    expect(markup).toContain('name="shippingMethodId"');
  });

  test("coupon applied: remove form + shipping form (2), no code input", () => {
    const markup = html(FIXTURES.fixedCoupon);
    assertForms(markup, 2);
    expect(markup).not.toContain('name="couponCode"');
    expect(markup).toContain("Remove");
  });

  test("no shipping options: only the coupon form (1)", () => {
    assertForms(html(buildCart({ lines: [line("a", 1000, 1)], methods: [] })), 1);
  });

  test("selected method radio is checked and the no-JS Update button is visible", () => {
    const root = parse(html(FIXTURES.percentExpress));
    const checked = root.querySelector<HTMLInputElement>('input[name="shippingMethodId"][checked]');
    expect(checked?.value).toBe("express");
    expect(root.textContent).toContain("Update");
  });

  test("coupon form posts couponCode to applyCoupon; shipping form posts shippingMethodId", async () => {
    const posted: string[] = [];
    const record =
      (field: string): CartActionFnV2 =>
      async (_prev, formData) => {
        posted.push(`${field}=${String(formData.get(field))}`);
        return ok({ itemCount: 1, subtotalCents: 2000, message: "Updated" });
      };
    render(
      <CartSummary
        cart={FIXTURES.singleUnderThreshold}
        actions={{ applyCoupon: record("couponCode"), removeCoupon: noop, setShippingMethod: record("shippingMethodId") }}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Promo code" });
    fireEvent.change(input, { target: { value: "save10" } });
    const couponForm = input.closest("form");
    if (!couponForm) throw new Error("no coupon form");
    fireEvent.submit(couponForm);
    await waitFor(() => expect(posted).toContain("couponCode=SAVE10"));

    const express = screen.getByRole("radio", { name: /Express/ });
    const shippingForm = express.closest("form");
    if (!shippingForm || shippingForm === couponForm) throw new Error("shipping form must be separate");
    // happy-dom's requestSubmit() passes the form as submitter (FormData then
    // throws); replay it as a plain submit event, as the picker's own tests do.
    shippingForm.requestSubmit = () => {
      fireEvent.submit(shippingForm);
    };
    // Hydrated + autoSubmit: choosing a method submits its own form.
    fireEvent.click(express);
    await waitFor(() => expect(posted).toContain("shippingMethodId=express"));
  });
});

describe("rows", () => {
  test("discount row only when > 0, labelled with the code", () => {
    expect(parse(html(FIXTURES.singleUnderThreshold)).textContent).not.toContain("Discount");
    const root = parse(html(FIXTURES.fixedCoupon));
    expect(ddText(root, "Discount (FIVEOFF)")).toContain("$5.00");
    expect(ddText(root, "Discount (FIVEOFF)")).toContain("minus");
    // free-shipping coupon: no discount row, shipping Free
    const free = parse(html(FIXTURES.freeShippingCoupon));
    expect(free.textContent).not.toContain("Discount (");
    expect(ddText(free, "Shipping")).toContain("Free");
  });

  test('shipping row shows the method and "Free" at 0, the price otherwise', () => {
    expect(ddText(parse(html(FIXTURES.overThresholdFree)), "Shipping")).toBe("Standard Free");
    expect(ddText(parse(html(FIXTURES.exactThreshold)), "Shipping")).toBe("Standard Free");
    expect(ddText(parse(html(FIXTURES.singleUnderThreshold)), "Shipping")).toBe("Standard $5.99");
    expect(ddText(parse(html(FIXTURES.percentExpress)), "Shipping")).toBe("Express $14.99");
  });

  test("no shipping method: shipping row reads not available, never Free", () => {
    const text = ddText(parse(html(buildCart({ lines: [line("a", 1000, 1)], methods: [] }))), "Shipping");
    expect(text).toContain("not available");
    expect(text).not.toContain("Free");
  });

  test("free-shipping progress: remaining amount under the threshold, success at it", () => {
    expect(parse(html(FIXTURES.singleUnderThreshold)).textContent).toContain("Add $15.00 more for free shipping");
    expect(parse(html(FIXTURES.exactThreshold)).textContent).toContain("You've got free shipping!");
    // Express has no threshold: no progress bar
    expect(parse(html(FIXTURES.percentExpress)).textContent).not.toContain("more for free shipping");
  });

  test("couponNotice is shown", () => {
    const cart = buildCart({ lines: [line("a", 1000, 1)], couponNotice: "Promo code OLD has expired and was removed from your cart." });
    expect(parse(html(cart)).textContent).toContain("Promo code OLD has expired");
  });

  test("shippingNotice renders as an info Notice (role=status, not alert) right before the shipping picker", () => {
    const text = "Your selected shipping method is no longer available.";
    render(<CartSummary cart={FIXTURES.singleUnderThreshold} actions={ACTIONS} shippingNotice={text} />);
    const notice = screen.getByTestId("cart-summary-shipping-notice");
    expect(notice).toHaveTextContent(text);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("data-tone")).toBe("info");
    expect(screen.queryAllByRole("alert").some((el) => el.textContent?.includes(text))).toBe(false);
    const picker = screen.getAllByRole("radio")[0];
    expect(picker).toBeDefined();
    if (picker === undefined) return;
    expect(notice.compareDocumentPosition(picker) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("shippingNotice and couponNotice render together, each with its own role", () => {
    const cart = buildCart({ lines: [line("a", 1000, 1)], couponNotice: "Promo code OLD has expired." });
    render(<CartSummary cart={cart} actions={ACTIONS} shippingNotice="Shipping method changed." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Promo code OLD has expired.");
    expect(screen.getByTestId("cart-summary-shipping-notice")).toHaveTextContent("Shipping method changed.");
  });

  test("absent / null / blank shippingNotice renders nothing", () => {
    for (const value of [undefined, null, "", "   "]) {
      const root = parse(html(FIXTURES.singleUnderThreshold, { shippingNotice: value }));
      expect(root.querySelector('[data-testid="cart-summary-shipping-notice"]')).toBeNull();
      expect(root.querySelector('[role="status"][data-tone="info"]')).toBeNull();
    }
  });

  test("shippingNotice is trimmed and rendered as text (no HTML injection)", () => {
    const root = parse(html(FIXTURES.singleUnderThreshold, { shippingNotice: "  <img src=x onerror=alert(1)>  " }));
    const notice = root.querySelector('[data-testid="cart-summary-shipping-notice"]');
    expect(notice?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(notice?.querySelector("img")).toBeNull();
  });

  test("shippingNotice still shows when only saved items remain (no lines)", () => {
    const cart = buildCart({ lines: [], savedCount: 1 });
    const root = parse(html(cart, { shippingNotice: "Shipping method changed." }));
    expect(root.querySelector('[data-testid="cart-summary-shipping-notice"]')?.textContent).toBe("Shipping method changed.");
  });

  test("currency prop is used for every amount", () => {
    const markup = html(FIXTURES.fixedCoupon, { currency: "EUR" });
    expect(markup).toContain("€");
    expect(markup).not.toContain("$");
  });

  test("headingLevel 3 renders an h3; default h2", () => {
    expect(parse(html(FIXTURES.singleUnderThreshold)).querySelector("h2")?.textContent).toBe("Order summary");
    expect(parse(html(FIXTURES.singleUnderThreshold, { headingLevel: 3 })).querySelector("h3")?.textContent).toBe("Order summary");
  });

  test("aside is labelled by its heading", () => {
    const root = parse(html(FIXTURES.singleUnderThreshold));
    const aside = root.querySelector("aside");
    const id = aside?.getAttribute("aria-labelledby") ?? "";
    expect(id).not.toBe("");
    expect(root.querySelector(`[id="${id}"]`)?.textContent).toBe("Order summary");
  });
});

describe("hostile and invalid input", () => {
  const HOSTILE = '<img src=x onerror="alert(1)">';

  test("coupon description and method names render as text", () => {
    const evil: ShippingMethod = { ...STANDARD, id: "evil", name: `<script>alert(1)</script>${HOSTILE}` };
    const cart = buildCart({
      lines: [line("a", 1000, 1)],
      coupon: coupon("SAVE10", "percent", 10, HOSTILE),
      methods: [evil],
    });
    const markup = html(cart);
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).toContain("&lt;img");
    const root = parse(markup);
    expect(root.querySelector("script, img")).toBeNull();
    expect(root.textContent).toContain(HOSTILE);
  });

  test("NaN / negative / float cents never render NaN; overflow renders —", () => {
    const base = FIXTURES.fixedCoupon;
    const cart: CartSummaryCart = {
      ...base,
      itemCount: Number.NaN,
      totals: {
        subtotalCents: Number.NaN,
        discountCents: -500,
        shippingCents: 1.5,
        totalCents: Number.POSITIVE_INFINITY,
        amountToFreeShippingCents: Number.NaN,
      },
    };
    const markup = html(cart);
    expect(markup).not.toContain("NaN");
    expect(markup).not.toContain("Infinity");
    const root = parse(markup);
    expect(ddText(root, "Subtotal (0 items)")).toBe("$0.00");
    expect(ddText(root, "Total")).toContain("unavailable");
    expect(root.textContent).not.toContain("Discount (");
    expect(root.querySelector("aside")?.getAttribute("data-total-check")).not.toBe("match");
  });

  test("every href passes isAllowedInternalHref", () => {
    for (const cart of Object.values(FIXTURES)) {
      const root = parse(html(cart, { checkoutHref: "https://evil.example" }));
      for (const a of Array.from(root.querySelectorAll("a"))) {
        expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
      }
    }
  });
});

describe("320px layout (tokens only)", () => {
  test("container and rows can shrink and wrap", () => {
    const root = parse(html(FIXTURES.fixedCoupon, { className: "lg:w-80" }));
    const aside = root.querySelector("aside");
    expect(aside?.className).toContain("min-w-0");
    expect(aside?.className).toContain("lg:w-80");
    const rows = Array.from(root.querySelectorAll('dl > [role="presentation"]'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) expect(row.className).toContain("flex-wrap");
    expect(root.querySelector("style")).toBeNull();
    expect(aside?.getAttribute("style")).toBeNull();
  });

  test("T161: the panel is a raised Card surface (role tokens only)", () => {
    const aside = parse(html(FIXTURES.singleUnderThreshold)).querySelector("aside");
    for (const cls of ["bg-surface-raised", "rounded-lg", "border-border-default", "shadow-sm"]) {
      expect(aside?.className).toContain(cls);
    }
  });
});
