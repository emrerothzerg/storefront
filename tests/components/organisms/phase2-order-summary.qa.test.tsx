// QA (QA-W4-organisms-C / T90): T83 OrderSummary v2.
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  OrderSummary,
  checkOrderSummaryTotal,
  computeOrderSummaryTotal,
  toDisplayAmount,
  type OrderSummaryProps,
} from "@/components/organisms/OrderSummary";
import { formatDeliveryRange } from "@/components/molecules/DeliveryEstimate";
import { createCartService } from "@/server/cart/cart-service";
import { createDatabase } from "@/server/db/client";
import { runMigrations } from "@/server/db/schema";
import { seedDatabase } from "@/server/db/seed";
import { createOrderService, type OrderView } from "@/server/orders/order-service";
import { MOCK_CARDS, createMockPaymentProvider } from "@/server/payments/mock-payment-provider";

const DIR = join(import.meta.dir, "../../../src/components/organisms/OrderSummary");
const MAX = Number.MAX_SAFE_INTEGER;

const ITEMS: OrderSummaryProps["items"] = [
  { productId: "p1", name: "Canvas Tote", quantity: 2, unitPriceCents: 1250 },
  { productId: "p2", name: "Mug", quantity: 3, unitPriceCents: 999 },
];
// 2500 + 2997 = 5497

function summary(over: Partial<OrderSummaryProps> = {}) {
  return (
    <OrderSummary items={ITEMS} subtotalCents={5497} shippingCents={599} totalCents={6096} currency="USD" {...over} />
  );
}

function region(over: Partial<OrderSummaryProps> = {}): HTMLElement {
  render(summary(over));
  return screen.getByRole("region", { name: over.heading ?? "Order summary" });
}

function dd(section: HTMLElement, label: string | RegExp): HTMLElement {
  const dt = within(section).getByText(label, { selector: "dt" });
  const next = dt.nextElementSibling;
  if (!(next instanceof HTMLElement)) throw new Error(`no dd for ${String(label)}`);
  return next;
}

const INVOICE = {
  orderId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  placedAt: "2026-11-07T23:30:00.000Z",
  status: "payment_failed",
  paymentLast4: "4242",
  billToName: "Ada Lovelace",
  shipTo: { fullName: "Ada Lovelace", line1: "1 Analytical Way", line2: null, city: "London", region: "LDN", postalCode: "N1 9GU", country: "GB" },
};

describe("T83.1 MVP tests kept and green", () => {
  // T164: the mtime ordering check was dropped (Phase 3 R5: T161 updated the MVP file for the
  // restyle). The intent stays: the MVP file still has its 9 tests and none is skipped.
  test("OrderSummary.test.tsx still has its 9 MVP tests, none skipped", () => {
    expect(statSync(join(DIR, "OrderSummary.test.tsx")).isFile()).toBe(true);
    expect(statSync(join(DIR, "order-summary-helpers.ts")).isFile()).toBe(true);
    const src = readFileSync(join(DIR, "OrderSummary.test.tsx"), "utf8");
    expect(src.match(/^\s*test\(/gm)?.length).toBe(9);
    expect(/\b(test|it|describe)\.(skip|todo|only)\b/.test(src)).toBe(false);
  });
});

describe("T83.1 total = items + shipping - discount exactly", () => {
  test("data-total-check=match for a consistent fixture", () => {
    expect(region({ discountCents: 500, couponCode: "WELCOME10", totalCents: 5596 })).toHaveAttribute("data-total-check", "match");
    expect(region({ heading: "B", shippingCents: 0, totalCents: 5497 })).toHaveAttribute("data-total-check", "match");
  });

  test("mismatch when totalCents disagrees by 1 cent; the given total is still displayed", () => {
    const section = region({ totalCents: 6097 });
    expect(section).toHaveAttribute("data-total-check", "mismatch");
    expect(dd(section, "Total")).toHaveTextContent("$60.97");
  });

  test("large safe integers: exact equality vs BigInt reference", () => {
    const unit = 3_000_000_000_000_001; // 3e15 + 2e15 + 999 - 7 stays below MAX_SAFE_INTEGER (~9.007e15)
    const items = [
      { productId: "a", name: "A", quantity: 1, unitPriceCents: unit },
      { productId: "b", name: "B", quantity: 2, unitPriceCents: 1_000_000_000_000_003 },
    ];
    const shipping = 999;
    const discount = 7;
    const exact = BigInt(unit) + 2n * 1_000_000_000_000_003n + BigInt(shipping) - BigInt(discount);
    expect(exact <= BigInt(MAX)).toBe(true);
    const total = Number(exact);
    expect(BigInt(total)).toBe(exact);
    const input = { items, shippingCents: shipping, discountCents: discount };
    expect(computeOrderSummaryTotal(input)).toEqual({ ok: true, value: total });
    expect(checkOrderSummaryTotal(input, total)).toBe("match");
    expect(checkOrderSummaryTotal(input, total + 1)).toBe("mismatch");
    expect(checkOrderSummaryTotal(input, total - 1)).toBe("mismatch");
    // At the edge: exactly MAX_SAFE_INTEGER.
    const edge = { items: [{ unitPriceCents: MAX - 10, quantity: 1 }], shippingCents: 10 };
    expect(checkOrderSummaryTotal(edge, MAX)).toBe("match");
    expect(checkOrderSummaryTotal({ ...edge, shippingCents: 11 }, MAX)).toBe("unavailable");
  });

  test("unavailable for Infinity / unsafe inputs (never throws)", () => {
    const base = { items: [{ unitPriceCents: 100, quantity: 1 }], shippingCents: 0 };
    expect(checkOrderSummaryTotal({ ...base, shippingCents: Number.POSITIVE_INFINITY }, 100)).toBe("unavailable");
    expect(checkOrderSummaryTotal({ ...base, items: [{ unitPriceCents: MAX + 2, quantity: 1 }] }, 100)).toBe("unavailable");
    expect(checkOrderSummaryTotal({ ...base, items: [{ unitPriceCents: MAX, quantity: 2 }] }, 100)).toBe("unavailable");
    expect(region({ shippingCents: Number.POSITIVE_INFINITY })).toHaveAttribute("data-total-check", "unavailable");
  });

  test("observation: an Infinity/unsafe totalCents with valid inputs is 'mismatch' (display shows unavailable)", () => {
    const base = { items: [{ unitPriceCents: 100, quantity: 1 }], shippingCents: 0 };
    expect(checkOrderSummaryTotal(base, Number.POSITIVE_INFINITY)).toBe("mismatch");
    expect(checkOrderSummaryTotal(base, MAX + 2)).toBe("mismatch");
    expect(checkOrderSummaryTotal(base, Number.NaN)).toBe("mismatch");
  });

  test("computeOrderSummaryTotal clamps at 0 when discount > items + shipping", () => {
    const r = computeOrderSummaryTotal({ items: [{ unitPriceCents: 500, quantity: 1 }], shippingCents: 100, discountCents: 10_000 });
    expect(r).toEqual({ ok: true, value: 0 });
    expect(computeOrderSummaryTotal({ items: [], shippingCents: 0, discountCents: 1 })).toEqual({ ok: true, value: 0 });
    expect(computeOrderSummaryTotal({ items: [{ unitPriceCents: 500, quantity: 1 }], shippingCents: 100, discountCents: 600 })).toEqual({ ok: true, value: 0 });
  });

  test("NaN / float / negative amounts display $0.00, never NaN", () => {
    for (const bad of [Number.NaN, 12.5, -100, Number.NEGATIVE_INFINITY]) {
      const html = renderToStaticMarkup(
        summary({
          subtotalCents: bad,
          shippingCents: bad,
          totalCents: bad,
          discountCents: bad,
          items: [{ productId: "x", name: "X", quantity: bad, unitPriceCents: bad }],
        }),
      );
      expect(html).not.toContain("NaN");
      expect(html).not.toContain("Infinity");
      expect(html).not.toContain("-$");
      expect(html).toContain("$0.00");
    }
    expect(toDisplayAmount(-0)).toEqual({ kind: "ok", cents: 0 });
    expect(toDisplayAmount("100")).toEqual({ kind: "ok", cents: 0 });
  });

  test("unsafe total displays an em dash + visually hidden 'unavailable'", () => {
    const section = region({ totalCents: MAX + 2 });
    const total = dd(section, "Total");
    expect(total).toHaveTextContent("unavailable");
    expect(total.textContent).not.toContain("NaN");
  });
});

describe("T83.1 discount row", () => {
  test("absent when 0 / undefined / invalid", () => {
    for (const discountCents of [0, undefined, Number.NaN, -5, 1.5]) {
      const html = renderToStaticMarkup(summary({ discountCents, couponCode: "SAVE" }));
      expect(html).not.toContain("Discount");
    }
  });

  test("'Discount (CODE)' with a screen-reader 'minus'; hostile code inert", () => {
    const section = region({ discountCents: 500, couponCode: "WELCOME10", totalCents: 5596 });
    const value = dd(section, "Discount (WELCOME10)");
    expect(value).toHaveTextContent(/minus\s*\$5\.00/);
    const evil = "<img src=x onerror=alert(1)>";
    const html = renderToStaticMarkup(summary({ discountCents: 1, couponCode: evil }));
    expect(html).not.toContain("<img");
    expect(html).toContain("Discount (&lt;img");
  });

  test("blank coupon code -> plain 'Discount'", () => {
    const section = region({ discountCents: 100, couponCode: "   " });
    expect(within(section).getByText("Discount", { selector: "dt" })).toBeInTheDocument();
  });
});

describe("T83.2 Free shipping", () => {
  test("'Free' text when shippingCents is 0 or isFreeShipping", () => {
    expect(dd(region({ shippingCents: 0, totalCents: 5497 }), "Shipping")).toHaveTextContent(/^Free$/);
  });
  test("isFreeShipping forces Free (display only) and shows the method name", () => {
    const section = region({ isFreeShipping: true, shippingCents: 0, shippingMethodName: "Standard Shipping", totalCents: 5497 });
    const value = dd(section, "Shipping");
    expect(value).toHaveTextContent("Standard Shipping");
    expect(value).toHaveTextContent("Free");
    expect(value).not.toHaveTextContent("$");
    expect(section).toHaveAttribute("data-total-check", "match");
  });
  test("paid shipping shows price, not Free", () => {
    const value = dd(region({ shippingMethodName: "Express" }), "Shipping");
    expect(value).toHaveTextContent("$5.99");
    expect(value).not.toHaveTextContent("Free");
  });
});

describe("T83.3 delivery note", () => {
  test("rendered as text, whitespace-pre-line, hostile text inert", () => {
    const note = "<b>Ring</b> the bell\n<script>alert(1)</script>";
    const { container } = render(summary({ deliveryNote: note }));
    const el = screen.getByTestId("order-delivery-note");
    expect(el).toHaveClass("whitespace-pre-line");
    expect(el.textContent).toBe(note);
    expect(container.querySelector("b, script")).toBeNull();
  });
  test("omitted when null / empty / whitespace", () => {
    for (const deliveryNote of [null, undefined, "", "   \n\t "]) {
      const html = renderToStaticMarkup(summary({ deliveryNote }));
      expect(html).not.toContain("Delivery note");
      expect(html).not.toContain("Delivery details");
    }
  });
});

describe("T83 estimated delivery", () => {
  test("range formatted like formatDeliveryRange; same-day shows one date", () => {
    const est = { start: "2026-11-10T00:00:00.000Z", end: "2026-11-12T00:00:00.000Z" };
    const range = formatDeliveryRange(est);
    expect(range).not.toBeNull();
    render(summary({ estimatedDelivery: est }));
    const el = screen.getByTestId("order-estimated-delivery");
    expect(el).toHaveTextContent(range?.start ?? "x");
    expect(el).toHaveTextContent(range?.end ?? "x");
    expect(el).toHaveTextContent(/to/);
  });
  test("invalid ranges omitted", () => {
    for (const estimatedDelivery of [
      { start: "2026-11-12T00:00:00.000Z", end: "2026-11-10T00:00:00.000Z" },
      { start: "garbage", end: "2026-11-10T00:00:00.000Z" },
      { start: "2026-02-31T00:00:00.000Z", end: "2026-03-02T00:00:00.000Z" },
      null,
    ]) {
      const html = renderToStaticMarkup(summary({ estimatedDelivery }));
      expect(html).not.toContain("Estimated delivery");
    }
  });
});

describe("T83.4 invoice variant", () => {
  test("order number, placed date (en-US UTC), readable status, card ending, bill/ship to, unit prices", () => {
    const section = region({ variant: "invoice", invoice: INVOICE });
    expect(section).toHaveAttribute("data-variant", "invoice");
    expect(dd(section, "Order number")).toHaveTextContent(INVOICE.orderId);
    expect(dd(section, "Order placed")).toHaveTextContent("November 7, 2026");
    expect(dd(section, "Status")).toHaveTextContent("Payment failed");
    expect(dd(section, "Payment")).toHaveTextContent("Paid with card ending in 4242");
    expect(dd(section, "Bill to")).toHaveTextContent("Ada Lovelace");
    const ship = dd(section, "Ship to");
    expect(ship).toHaveTextContent("1 Analytical Way");
    expect(ship).toHaveTextContent("London, LDN N1 9GU");
    expect(within(section).getAllByText("each")).toHaveLength(2);
    expect(section).toHaveTextContent("$12.50");
    expect(section).toHaveTextContent("$9.99");
  });

  test("placed date uses UTC (23:30Z stays Nov 7; 02:00+05:00 is Nov 6 in UTC)", () => {
    const html = renderToStaticMarkup(summary({ variant: "invoice", invoice: { ...INVOICE, placedAt: "2026-11-07T02:00:00+05:00" } }));
    expect(html).toContain("November 6, 2026");
  });

  test("card line only for exactly 4 ASCII digits; never a full PAN", () => {
    const pan = "4242424242424242";
    for (const paymentLast4 of ["42425", "abcd", pan, "424", "", null, " 4242", "4242\n", "４２４２", "4 24"]) {
      const html = renderToStaticMarkup(summary({ variant: "invoice", invoice: { ...INVOICE, paymentLast4 } }));
      expect(html).not.toContain("card ending");
      expect(html).not.toContain(pan);
      expect(html).not.toContain("42425");
    }
  });

  test("no interactive controls: no a/button/form/input/select/textarea/tabindex/details", () => {
    const html = renderToStaticMarkup(
      summary({
        variant: "invoice",
        invoice: INVOICE,
        discountCents: 500,
        couponCode: "WELCOME10",
        deliveryNote: "Leave at door",
        estimatedDelivery: { start: "2026-11-10T00:00:00.000Z", end: "2026-11-12T00:00:00.000Z" },
        shippingMethodName: "Express",
        totalCents: 5596,
      }),
    );
    expect(html).not.toMatch(/<(a|button|form|input|select|textarea|details|summary)\b/);
    expect(html).not.toMatch(/tabindex/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  test("hostile invoice text renders as text", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { container } = render(
      summary({
        variant: "invoice",
        invoice: { ...INVOICE, orderId: evil, status: evil, billToName: evil, shipTo: { ...INVOICE.shipTo, line1: evil } },
        items: [{ productId: "x", name: evil, quantity: 1, unitPriceCents: 100 }],
      }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(dd(screen.getByRole("region"), "Order number")).toHaveTextContent(evil);
  });

  test("invoice header absent in default variant even when invoice data is passed", () => {
    const html = renderToStaticMarkup(summary({ invoice: INVOICE }));
    expect(html).not.toContain("Order number");
    expect(html).not.toContain("card ending");
  });
});

describe("T83 orderViewToSummaryProps with a real OrderView", () => {
  // Same mapping as the implementer's example (OrderSummary.v2.test.tsx); typed so
  // `bun run typecheck` proves OrderView -> OrderSummaryProps compiles.
  function orderViewToSummaryProps(order: OrderView): OrderSummaryProps {
    return {
      items: order.items,
      subtotalCents: order.subtotalCents,
      discountCents: order.discountCents,
      couponCode: order.couponCode,
      shippingCents: order.shippingCents,
      shippingMethodName: order.shippingMethodName,
      totalCents: order.totalCents,
      currency: order.currency,
      deliveryNote: order.deliveryNote,
      estimatedDelivery: order.estimatedDelivery,
      variant: "invoice",
      invoice: { orderId: order.id, placedAt: order.createdAt, status: order.status, paymentLast4: order.cardLast4 },
    };
  }

  test("order placed through OrderService v2 (coupon + delivery note) renders with data-total-check=match", async () => {
    const NOW = Date.parse("2026-11-04T10:00:00.000Z");
    const S1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const db = createDatabase(":memory:");
    runMigrations(db);
    seedDatabase(db, { now: new Date(NOW) });
    const pay = createMockPaymentProvider({ latencyMs: 0, now: () => new Date(NOW) });
    const svc = createOrderService(db, { now: () => NOW, payments: pay, inFlight: new Map() });
    const carts = createCartService(db, { now: () => NOW });
    expect(carts.addItem(S1, "prod_canvas-tote-bag", 2).ok).toBe(true);
    expect(carts.applyCoupon(S1, "WELCOME10").ok).toBe(true);
    const placed = await svc.placeOrderV2({
      sessionId: S1,
      address: { fullName: "Ada Lovelace", email: "ada@example.com", line1: "1 Analytical Way", city: "London", region: "LDN", postalCode: "N1 9GU", country: "GB" },
      card: { number: MOCK_CARDS.success, expMonth: 12, expYear: 2030, cvc: "987", nameOnCard: "Ada Lovelace" },
      idempotencyKey: `qa-${crypto.randomUUID()}`,
      deliveryNote: "<b>Side door</b>",
    });
    if (!placed.ok) throw new Error(JSON.stringify(placed.error));
    const view = svc.getOrderView(placed.value.id, S1);
    expect(view).not.toBeNull();
    const order = view as OrderView;
    expect(order.discountCents).toBeGreaterThan(0);

    const { container } = render(<OrderSummary {...orderViewToSummaryProps(order)} />);
    const section = screen.getByRole("region", { name: "Order summary" });
    expect(section).toHaveAttribute("data-total-check", "match");
    expect(section).toHaveAttribute("data-variant", "invoice");
    expect(dd(section, `Discount (${order.couponCode ?? ""})`)).toHaveTextContent("minus");
    expect(dd(section, "Order number")).toHaveTextContent(order.id);
    expect(dd(section, "Payment")).toHaveTextContent(`Paid with card ending in ${order.cardLast4}`);
    expect(screen.getByTestId("order-delivery-note").textContent).toBe("<b>Side door</b>");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).not.toContain(MOCK_CARDS.success);
    db.close();
  });
});

describe("T83 source hygiene", () => {
  test("no style=, dangerouslySetInnerHTML, any, ts-ignore, runtime server imports", () => {
    for (const file of ["OrderSummary.tsx", "order-summary-helpers.ts", "index.ts"]) {
      const src = readFileSync(join(DIR, file), "utf8");
      expect(src).not.toMatch(/style=\{/);
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|eslint-disable/);
      expect(src).not.toMatch(/from ["']@\/server/);
    }
  });
});
