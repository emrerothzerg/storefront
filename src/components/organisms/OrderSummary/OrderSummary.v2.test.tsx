import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrderView } from "@/server/orders/order-service";
import { OrderSummary, type OrderSummaryProps } from "./OrderSummary";

const items: OrderSummaryProps["items"] = [
  { productId: "p1", name: "Canvas Tote", quantity: 2, unitPriceCents: 1250, productSlug: "canvas-tote", imageUrl: "/t.jpg" },
  { productId: "p2", name: "Mug", quantity: 3, unitPriceCents: 999 },
];
// 2500 + 2997 = 5497
const RANGE = { start: "2026-11-10T00:00:00.000Z", end: "2026-11-12T23:59:00.000Z" };
const INVOICE = {
  orderId: "ord_01JABCDEF",
  placedAt: "2026-11-07T15:04:00.000Z",
  status: "paid",
  paymentLast4: "4242",
  billToName: "Ada Lovelace",
  shipTo: {
    fullName: "Ada Lovelace",
    line1: "1 Analytical Way",
    line2: "Suite 2",
    city: "London",
    region: "LDN",
    postalCode: "N1 9GU",
    country: "GB",
  },
};

function parseUsd(text: string | null): number {
  return Math.round(Number((text ?? "").replace(/[^0-9.]/g, "")) * 100);
}

/** Text a screen reader announces: `textContent` without `aria-hidden` subtrees (the superscript visual). */
function spokenText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const hidden of Array.from(clone.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
  return clone.textContent ?? "";
}

function ddValue(section: HTMLElement, label: string): HTMLElement {
  const dt = within(section).getByText(label, { selector: "dt" });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no dd for ${label}`);
  return dd;
}

function renderSummary(props: Partial<OrderSummaryProps> = {}) {
  const result = render(
    <OrderSummary
      items={items}
      subtotalCents={5497}
      shippingCents={0}
      totalCents={5497}
      currency="USD"
      {...props}
    />,
  );
  return { section: screen.getByRole("region", { name: props.heading ?? "Order summary" }), ...result };
}

function lineSum(section: HTMLElement): number {
  return within(section)
    .getAllByTestId("order-line-total")
    .reduce((sum, el) => sum + parseUsd(el.textContent), 0);
}

describe("OrderSummary v2: discount (criterion 1)", () => {
  test("discount row labelled with the coupon code; total = items + shipping − discount exactly", () => {
    const { section } = renderSummary({
      discountCents: 550,
      couponCode: "WELCOME10",
      shippingCents: 599,
      totalCents: 5497 + 599 - 550,
    });
    const terms = Array.from(section.querySelectorAll("dt")).map((n) => n.textContent);
    expect(terms).toEqual(["Subtotal", "Discount (WELCOME10)", "Shipping", "Total"]);
    const discount = ddValue(section, "Discount (WELCOME10)");
    expect(within(discount).getByTestId("order-discount")).toHaveTextContent("−minus $5.50");
    expect(within(discount).getByText("minus")).toHaveClass("sr-only");
    // T161: superscript Total; compare the spoken (full) amount.
    const shown = parseUsd(spokenText(ddValue(section, "Total")));
    expect(shown).toBe(lineSum(section) + parseUsd(ddValue(section, "Shipping").textContent) - parseUsd(discount.textContent));
    expect(section).toHaveAttribute("data-total-check", "match");
  });

  test("discount without a coupon code reads 'Discount'", () => {
    const { section } = renderSummary({ discountCents: 100, totalCents: 5397 });
    expect(ddValue(section, "Discount")).toHaveTextContent("$1.00");
  });

  test.each([0, undefined, Number.NaN, -100, 1.5])("discount %p never shows a row", (discountCents) => {
    const { section } = renderSummary({ discountCents, couponCode: "WELCOME10" });
    expect(within(section).queryByText(/Discount/)).toBeNull();
    expect(section).not.toHaveTextContent("NaN");
  });

  test("large integers: exact totals near MAX_SAFE_INTEGER", () => {
    const unit = 2 ** 51 + 1; // float sums of these round; integer math must not
    const big = [
      { productId: "a", name: "A", quantity: 2, unitPriceCents: unit },
      { productId: "b", name: "B", quantity: 1, unitPriceCents: 7 },
    ];
    const expected = unit * 2 + 7 + 3 - 5; // all values below 2^53, exact
    expect(BigInt(expected)).toBe(BigInt(unit) * 2n + 7n + 3n - 5n);
    const { section } = renderSummary({
      items: big,
      subtotalCents: unit * 2 + 7,
      shippingCents: 3,
      discountCents: 5,
      totalCents: expected,
    });
    expect(section).toHaveAttribute("data-total-check", "match");
    const digits = spokenText(ddValue(section, "Total")).replace(/[^0-9]/g, "");
    expect(BigInt(digits)).toBe(BigInt(expected));
  });

  test("a supplied total that does not match is still displayed (MVP) but flagged", () => {
    const { section } = renderSummary({ discountCents: 500, totalCents: 5497 });
    expect(ddValue(section, "Total")).toHaveTextContent("$54.97");
    expect(section).toHaveAttribute("data-total-check", "mismatch");
  });
});

describe("OrderSummary v2: shipping (criterion 2)", () => {
  test("method with 0 shipping shows the method and 'Free' as text", () => {
    const { section } = renderSummary({ shippingMethodName: "Standard Shipping" });
    const dd = ddValue(section, "Shipping");
    expect(dd).toHaveTextContent("Standard Shipping Free");
    expect(within(dd).getByText("Free").tagName).toBe("SPAN");
    expect(dd.querySelector("svg, img")).toBeNull();
  });

  test("isFreeShipping forces 'Free'", () => {
    const { section } = renderSummary({ shippingMethodName: "Express", isFreeShipping: true });
    expect(ddValue(section, "Shipping")).toHaveTextContent("Express Free");
  });

  test("paid method shows the price next to the method", () => {
    const { section } = renderSummary({ shippingMethodName: "Express", shippingCents: 1299, totalCents: 6796 });
    const dd = ddValue(section, "Shipping");
    expect(dd).toHaveTextContent("Express $12.99");
    expect(dd).not.toHaveTextContent("Free");
    expect(section).toHaveAttribute("data-total-check", "match");
  });

  test("blank method name is ignored", () => {
    const { section } = renderSummary({ shippingMethodName: "   ", shippingCents: 500, totalCents: 5997 });
    expect(ddValue(section, "Shipping").textContent).toBe("$5.00");
  });
});

describe("OrderSummary v2: delivery note and estimate (criterion 3)", () => {
  test("note rendered as text with whitespace-pre-line", () => {
    renderSummary({ deliveryNote: "Leave at the door\nRing twice" });
    const note = screen.getByTestId("order-delivery-note");
    expect(note).toHaveClass("whitespace-pre-line");
    expect(note.textContent).toBe("Leave at the door\nRing twice");
    expect(screen.getByText("Delivery note", { selector: "dt" })).toBeInTheDocument();
  });

  test.each([null, undefined, "", "   \n  "])("empty note %p is absent", (deliveryNote) => {
    renderSummary({ deliveryNote });
    expect(screen.queryByTestId("order-delivery-note")).toBeNull();
    expect(screen.queryByText("Delivery note")).toBeNull();
    expect(document.querySelector('dl[aria-label="Delivery details"]')).toBeNull();
  });

  test("hostile note and names render as text, not markup (SR3)", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = renderSummary({
      deliveryNote: evil,
      couponCode: "<b>X</b>",
      discountCents: 1,
      totalCents: 5496,
      shippingMethodName: "<a href=javascript:1>m</a>",
      items: [{ productId: "x", name: evil, quantity: 1, unitPriceCents: 5497 }],
      variant: "invoice",
      invoice: { ...INVOICE, orderId: evil, billToName: evil, shipTo: { ...INVOICE.shipTo, line1: evil } },
    });
    expect(container.querySelector("img, script, b, a")).toBeNull();
    expect(screen.getByTestId("order-delivery-note").textContent).toBe(evil);
    expect(container).toHaveTextContent("Discount (<b>X</b>)");
    const html = renderToStaticMarkup(
      <OrderSummary items={[]} subtotalCents={0} shippingCents={0} totalCents={0} currency="USD" deliveryNote={evil} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  test("estimated delivery via formatDeliveryRange (en-US UTC)", () => {
    renderSummary({ estimatedDelivery: RANGE });
    const el = screen.getByTestId("order-estimated-delivery");
    expect(el).toHaveTextContent(/^Tue, Nov 10 – to Thu, Nov 12$/);
    expect(within(el).getByText("to")).toHaveClass("sr-only");
  });

  test("single-day estimate and invalid estimate", () => {
    const { unmount } = renderSummary({ estimatedDelivery: { start: RANGE.start, end: "2026-11-10T20:00:00Z" } });
    expect(screen.getByTestId("order-estimated-delivery").textContent).toBe("Tue, Nov 10");
    unmount();
    renderSummary({ estimatedDelivery: { start: "garbage", end: RANGE.end } });
    expect(screen.queryByTestId("order-estimated-delivery")).toBeNull();
  });
});

describe("OrderSummary v2: invoice variant (criterion 4)", () => {
  test("header block with mono order number, UTC date, status, payment and ship-to", () => {
    const { section } = renderSummary({ variant: "invoice", invoice: INVOICE, heading: "Invoice" });
    expect(section).toHaveAttribute("data-variant", "invoice");
    const header = within(section).getByTestId("order-summary-invoice");
    expect(within(header).getByText("ord_01JABCDEF")).toHaveClass("font-mono");
    expect(ddValue(header, "Order placed")).toHaveTextContent("November 7, 2026");
    expect(ddValue(header, "Status")).toHaveTextContent("Paid");
    expect(ddValue(header, "Payment")).toHaveTextContent("Paid with card ending in 4242");
    expect(ddValue(header, "Bill to")).toHaveTextContent("Ada Lovelace");
    const lines = Array.from(ddValue(header, "Ship to").children).map((n) => n.textContent);
    expect(lines).toEqual(["Ada Lovelace", "1 Analytical Way", "Suite 2", "London, LDN N1 9GU", "GB"]);
  });

  test("no interactive controls anywhere in the invoice", () => {
    const { container } = renderSummary({
      variant: "invoice",
      invoice: INVOICE,
      discountCents: 500,
      couponCode: "WELCOME10",
      shippingMethodName: "Standard",
      deliveryNote: "note",
      estimatedDelivery: RANGE,
      totalCents: 4997,
    });
    expect(container.querySelectorAll("a, button, input, select, textarea, form, [tabindex]")).toHaveLength(0);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("invoice lines show the unit price; line totals stay unit × qty", () => {
    const { section } = renderSummary({ variant: "invoice", invoice: INVOICE });
    const first = within(section).getAllByRole("listitem")[0];
    if (first === undefined) throw new Error("no line");
    expect(first).toHaveTextContent("$12.50each");
    expect(within(first).getByTestId("order-line-total")).toHaveTextContent("$25.00");
  });

  test("missing last4/date/order id degrade without crashing", () => {
    const { section } = renderSummary({
      variant: "invoice",
      invoice: { orderId: " ", placedAt: "nope", status: "", paymentLast4: "42" },
    });
    const header = within(section).getByTestId("order-summary-invoice");
    expect(within(header).queryByText("Payment")).toBeNull();
    expect(within(header).queryByText("Ship to")).toBeNull();
    expect(within(header).getAllByText("unavailable")).toHaveLength(3);
  });

  test("invoice data is ignored in the default variant; invoice variant without data has no header", () => {
    const { unmount } = renderSummary({ invoice: INVOICE });
    expect(screen.queryByTestId("order-summary-invoice")).toBeNull();
    unmount();
    renderSummary({ variant: "invoice" });
    expect(screen.queryByTestId("order-summary-invoice")).toBeNull();
  });
});

describe("OrderSummary v2: robustness", () => {
  test("invalid numbers render as $0.00, never NaN", () => {
    const { section } = renderSummary({
      subtotalCents: Number.NaN,
      shippingCents: -5,
      totalCents: 1.5,
      items: [{ productId: "n", name: "N", quantity: Number.NaN, unitPriceCents: Number.NaN }],
    });
    expect(section).not.toHaveTextContent("NaN");
    expect(ddValue(section, "Subtotal")).toHaveTextContent("$0.00");
    expect(ddValue(section, "Shipping")).toHaveTextContent("Free");
    expect(ddValue(section, "Total")).toHaveTextContent("$0.00");
    expect(within(section).getByRole("listitem")).toHaveTextContent("N × 0");
  });

  test("overflow-sized amounts render '—' with a visually hidden 'unavailable'", () => {
    const { section } = renderSummary({
      subtotalCents: Number.MAX_SAFE_INTEGER + 2,
      shippingCents: Number.POSITIVE_INFINITY,
      discountCents: 2 ** 60,
      totalCents: Number.MAX_SAFE_INTEGER + 2,
    });
    for (const label of ["Subtotal", "Discount", "Shipping", "Total"]) {
      const dd = ddValue(section, label);
      expect(dd).toHaveTextContent("—unavailable");
      expect(within(dd).getByText("unavailable")).toHaveClass("sr-only");
    }
    expect(section).toHaveAttribute("data-total-check", "unavailable");
  });

  test("duplicate product ids render every line; empty items renders no list", () => {
    const { unmount } = renderSummary({
      items: [
        { productId: "dup", name: "One", quantity: 1, unitPriceCents: 100 },
        { productId: "dup", name: "Two", quantity: 1, unitPriceCents: 100 },
      ],
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    unmount();
    renderSummary({ items: [] });
    expect(screen.queryByRole("list")).toBeNull();
  });

  test("renderToStaticMarkup works for both variants; no inline styles", () => {
    for (const variant of ["default", "invoice"] as const) {
      const html = renderToStaticMarkup(
        <OrderSummary
          items={items}
          subtotalCents={5497}
          shippingCents={0}
          totalCents={4947}
          currency="USD"
          discountCents={550}
          couponCode="WELCOME10"
          shippingMethodName="Standard"
          deliveryNote="Back door"
          estimatedDelivery={RANGE}
          variant={variant}
          invoice={INVOICE}
        />,
      );
      expect(html).toContain("Discount (WELCOME10)");
      expect(html).toContain("Back door");
      expect(html).toContain("Tue, Nov 10");
      expect(html).not.toContain("style=");
      expect(html).not.toContain("NaN");
      expect(html.includes("Paid with card ending in 4242")).toBe(variant === "invoice");
    }
  });

  test("320px: wrapping rows and shrinkable blocks", () => {
    const { section } = renderSummary({
      discountCents: 1,
      couponCode: "AVERYLONGCOUPONCODEWITHOUTSPACES",
      shippingMethodName: "Standard",
      deliveryNote: "x",
      variant: "invoice",
      invoice: INVOICE,
      totalCents: 5496,
    });
    expect(section).toHaveClass("min-w-0");
    expect(ddValue(section, "Discount (AVERYLONGCOUPONCODEWITHOUTSPACES)").parentElement).toHaveClass("flex-wrap", "wrap-anywhere");
    expect(ddValue(section, "Shipping").parentElement).toHaveClass("flex-wrap");
    expect(screen.getByTestId("order-delivery-note").parentElement).toHaveClass("break-words", "min-w-0");
    expect(screen.getByTestId("order-summary-invoice")).toHaveClass("grid-cols-1", "min-w-0");
  });
});

// Compile-time contract: an OrderView maps 1:1 onto the props (checked by `bun run typecheck`).
export function orderViewToSummaryProps(order: OrderView): OrderSummaryProps {
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

test("orderViewToSummaryProps is a type-level contract", () => {
  expect(typeof orderViewToSummaryProps).toBe("function");
});

describe("OrderSummary T161 light-only pass", () => {
  test("U18: Total uses the same plain format as the other rows (no superscript anywhere in the summary)", () => {
    const { section } = renderSummary({ shippingCents: 500, totalCents: 5997 });
    const total = ddValue(section, "Total");
    expect(section.querySelector('[data-slot="price-superscript"]')).toBeNull();
    expect(total.textContent).toBe("$59.97");
    expect(spokenText(total)).toBe("$59.97");
    // Line totals and the other rows use the same one-run format.
    for (const el of within(section).getAllByTestId("order-line-total")) {
      expect(el.querySelector('[data-slot="price-superscript"]')).toBeNull();
    }
    expect(ddValue(section, "Subtotal").textContent).toBe("$54.97");
  });

  test("T161: the panel is a raised Card surface (role tokens only)", () => {
    const { section } = renderSummary();
    expect(section).toHaveClass("bg-surface-raised", "rounded-lg", "border-border-default", "shadow-sm");
  });
});
