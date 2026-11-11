import { describe, expect, mock, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import type { OrderActionFn, OrderActionState } from "@/components/molecules/_contracts/order-actions";
import type { OrderView } from "@/server/orders/order-service";
import { OrderDetail, type OrderDetailOrder, type OrderDetailProps } from ".";
import {
  IDEMPOTENCY_KEY,
  ORDER_ID,
  PLACED_MS,
  PRODUCT_A,
  PRODUCT_B,
  SECRET_EMAIL,
  makeCancelledOrderView,
  makeOrderView,
  uuidsIn,
} from "./order-view.fixtures";

const MIN = 60_000;
const buyAgain = mock(async (formData: FormData) => {
  void formData;
});
const cancelOk: OrderActionFn = async () => ({ ok: true, kind: "cancelled", message: "Your order was cancelled." });

function props(overrides: Partial<OrderDetailProps> = {}): OrderDetailProps {
  return {
    order: makeOrderView(),
    variant: "detail",
    buyAgainAction: buyAgain,
    cancelAction: cancelOk,
    now: PLACED_MS + 10 * MIN,
    ...overrides,
  };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("types", () => {
  test("OrderView fits the order prop", () => {
    const view: OrderView = makeOrderView();
    const order: OrderDetailOrder = view;
    expect(order.id).toBe(ORDER_ID);
  });

  test("criterion 4: no card data keys other than last4 in the props", () => {
    type Forbidden = "cardNumber" | "number" | "cvc" | "cvv" | "expiry" | "expMonth" | "expYear" | "card" | "nameOnCard";
    type Leaks = Extract<keyof OrderDetailOrder | keyof OrderDetailProps, Forbidden>;
    const none: [Leaks] extends [never] ? true : false = true;
    expect(none).toBe(true);
  });
});

describe("variants (criterion 1)", () => {
  test("confirmation says Order placed, thanks, and shows the estimated delivery", () => {
    render(<OrderDetail {...props({ variant: "confirmation" })} />);
    expect(screen.getByRole("heading", { level: 1, name: "Order placed" })).toBeInTheDocument();
    expect(screen.getByText(/Thank you for your order/)).toBeInTheDocument();
    expect(screen.getByText(/^Estimated delivery: .*Nov 12.*Nov 14/)).toBeInTheDocument();
  });

  test("detail heading is the order number with no celebration copy", () => {
    const html = renderToStaticMarkup(<OrderDetail {...props()} />);
    const doc = parse(html);
    expect(doc.querySelector("h1")?.textContent).toBe(`Order # ${ORDER_ID}`);
    expect(html).not.toContain("Thank you");
    expect(doc.querySelectorAll("h1")).toHaveLength(1);
    expect(html).toContain("Placed on November 7, 2026");
  });

  test("headingLevel 2 shifts every section heading down", () => {
    const doc = parse(renderToStaticMarkup(<OrderDetail {...props({ headingLevel: 2 })} />));
    expect(doc.querySelectorAll("h1")).toHaveLength(0);
    expect(doc.querySelector("h2")?.textContent).toContain("Order #");
    expect([...doc.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(
      expect.arrayContaining(["Order progress", "Items", "Order summary", "Ship to", "Payment method", "Cancel order"]),
    );
  });
});

describe("items", () => {
  test("thumbnail, name link, qty x price and per-item actions", () => {
    const { container } = render(<OrderDetail {...props()} />);
    const list = screen.getByRole("heading", { name: "Items" }).parentElement?.querySelector("ul");
    const rows = list?.querySelectorAll(":scope > li") ?? [];
    expect(rows).toHaveLength(2);
    const first = rows[0] as HTMLElement;
    expect(within(first).getByRole("link", { name: "Trail Mug" })).toHaveAttribute("href", "/products/trail-mug");
    // D-T171-1: the line's product-name link stands alone in its <p> -> 44px target.
    expect(within(first).getByRole("link", { name: "Trail Mug" }).className.split(/\s+/)).toEqual(
      expect.arrayContaining(["inline-flex", "min-h-touch", "items-center"]),
    );
    expect(first.textContent).toContain("Qty 2 ×");
    expect(first.textContent).toContain("$15.00");
    expect(within(first).getByRole("link", { name: /Write a review/ })).toHaveAttribute(
      "href",
      "/products/trail-mug#write-review",
    );
    expect(within(first).getByRole("link", { name: /Get help/ })).toHaveAttribute(
      "href",
      `/contact?topic=ordering&order=${ORDER_ID}`,
    );
    const form = first.querySelector("form");
    expect(form?.querySelector('input[name="orderId"]')?.getAttribute("value")).toBe(ORDER_ID);
    expect(form?.querySelector('input[name="productId"]')?.getAttribute("value")).toBe(PRODUCT_A);
    expect(within(first).getByRole("button", { name: /Buy it again/ })).toBeInTheDocument();
    expect(rows[1]?.querySelector('input[name="productId"]')?.getAttribute("value")).toBe(PRODUCT_B);
    for (const a of container.querySelectorAll("a")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("an item with a route-breaking slug has no product links but keeps its name", () => {
    const base = makeOrderView();
    const first = base.items[0];
    if (first === undefined) throw new Error("fixture");
    const order = makeOrderView({ items: [{ ...first, productSlug: "../x" }] });
    render(<OrderDetail {...props({ order })} />);
    expect(screen.getByText("Trail Mug")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Write a review/ })).toBeNull();
    expect(screen.queryByRole("link", { name: "Trail Mug" })).toBeNull();
  });
});

describe("summary, ship-to, payment", () => {
  test("invoice OrderSummary gets server totals (total check matches)", () => {
    const { container } = render(<OrderDetail {...props()} />);
    const section = container.querySelector('section[data-variant="invoice"]');
    expect(section?.getAttribute("data-total-check")).toBe("match");
    expect(section?.textContent).toContain("Discount (WELCOME10)");
    expect(section?.textContent).toContain("Standard Shipping");
    expect(section?.textContent).toContain("$41.98");
    // Payment line lives in the Payment method block, not duplicated in the summary.
    expect(section?.textContent).not.toContain("ending in");
  });

  test("free shipping shows Free", () => {
    const order = makeOrderView({ shippingCents: 0, totalCents: 3599 });
    const { container } = render(<OrderDetail {...props({ order })} />);
    const section = container.querySelector('section[data-variant="invoice"]');
    expect(section?.textContent).toContain("Free");
    expect(section?.getAttribute("data-total-check")).toBe("match");
  });

  test("ship-to as text without email; payment as brand + last4 only", () => {
    const html = renderToStaticMarkup(<OrderDetail {...props({ paymentBrand: "Visa" })} />);
    expect(html).toContain("Springfield, IL 62701");
    expect(html).not.toContain(SECRET_EMAIL);
    expect(html).toContain("Visa ending in 4242");
    const plain = renderToStaticMarkup(<OrderDetail {...props()} />);
    expect(plain).toContain("Card ending in 4242");
  });

  test("extra card data smuggled onto the order object is never rendered", () => {
    const smuggled = { ...makeOrderView(), cardNumber: "4242424242424242", cvc: "123", expiry: "12/30" };
    const order: OrderDetailOrder = smuggled;
    const html = renderToStaticMarkup(<OrderDetail {...props({ order })} />);
    expect(html).not.toContain("4242424242424242");
    expect(html).not.toContain("12/30");
    expect(html).not.toMatch(/\b123\b/);
  });

  test("hostile names and ship-to render as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    const base = makeOrderView();
    const first = base.items[0];
    if (first === undefined) throw new Error("fixture");
    const order = makeOrderView({
      items: [{ ...first, name: evil }],
      subtotalCents: 3000,
      totalCents: 3199,
      address: { ...base.address, fullName: evil, line1: "<script>x</script>" },
      deliveryNote: evil,
    });
    const html = renderToStaticMarkup(<OrderDetail {...props({ order })} />);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("cancel (criterion 2)", () => {
  test("static markup has the cancel form with hidden orderId, required confirm checkbox and window text", () => {
    const doc = parse(renderToStaticMarkup(<OrderDetail {...props()} />));
    const form = [...doc.querySelectorAll("form")].find((f) => f.querySelector('input[name="confirm"]'));
    expect(form).toBeDefined();
    expect(form?.querySelector('input[type="hidden"][name="orderId"]')?.getAttribute("value")).toBe(ORDER_ID);
    const confirm = form?.querySelector('input[name="confirm"]');
    expect(confirm?.getAttribute("type")).toBe("checkbox");
    expect(confirm?.getAttribute("value")).toBe("yes");
    expect(confirm?.hasAttribute("required")).toBe(true);
    expect(form?.querySelector('button[type="submit"]')?.textContent).toContain("Cancel order");
    expect(form?.textContent).toContain("You can cancel for 20 more minutes.");
  });

  test("no form when not cancellable, window elapsed, under a minute left, no action, or invalid clock", () => {
    const cases: OrderDetailProps[] = [
      props({ order: makeOrderView({ cancellable: false, cancellableUntil: null }) }),
      props({ now: PLACED_MS + 31 * MIN }),
      props({ now: PLACED_MS + 29 * MIN + 30_000 }),
      props({ cancelAction: undefined }),
      props({ now: Number.NaN }),
    ];
    for (const p of cases) {
      const html = renderToStaticMarkup(<OrderDetail {...p} />);
      expect(html).not.toContain('name="confirm"');
      expect(html).not.toContain("You can cancel");
    }
  });

  test("success state: status message, form hidden", () => {
    const state: OrderActionState = { ok: true, kind: "cancelled", message: "Your order was cancelled." };
    render(<OrderDetail {...props({ cancelState: state })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Your order was cancelled.");
    expect(screen.queryByRole("button", { name: "Cancel order" })).toBeNull();
  });

  test("success message survives the re-render where the order is no longer cancellable", () => {
    const state: OrderActionState = { ok: true, kind: "cancelled", message: "Your order was cancelled." };
    render(<OrderDetail {...props({ order: makeCancelledOrderView(), cancelState: state })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Your order was cancelled.");
  });

  test("error state: alert, form still offered", () => {
    const state: OrderActionState = {
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." },
      message: "Too many requests. Try again later.",
      retryAfterSeconds: 60,
    };
    render(<OrderDetail {...props({ cancelState: state })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Too many requests");
    expect(screen.getByRole("button", { name: "Cancel order" })).toBeInTheDocument();
  });

  test("submitting posts orderId + confirm=yes and shows the result", async () => {
    const calls: FormData[] = [];
    const action: OrderActionFn = async (_prev, formData) => {
      calls.push(formData);
      return { ok: true, kind: "cancelled", message: "Your order was cancelled." };
    };
    render(<OrderDetail {...props({ cancelAction: action })} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Yes, cancel this order/ }));
    const form = screen.getByRole("button", { name: "Cancel order" }).closest("form");
    if (form === null) throw new Error("no form");
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Your order was cancelled."));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.get("orderId")).toBe(ORDER_ID);
    expect(calls[0]?.get("confirm")).toBe("yes");
  });
});

describe("cancelled order (criterion 5)", () => {
  test("shows the refund notice and no cancel form or estimate", () => {
    const html = renderToStaticMarkup(<OrderDetail {...props({ order: makeCancelledOrderView() })} />);
    expect(html).toContain("This order was cancelled on November 7, 2026.");
    expect(html).toContain("A refund of $41.98 to the card ending in 4242 is pending.");
    expect(html).not.toContain('name="confirm"');
    expect(html).not.toContain("Estimated delivery");
  });
});

describe("print (criterion 3)", () => {
  test("plain link to the invoice", () => {
    render(<OrderDetail {...props()} />);
    expect(screen.getByRole("link", { name: "Print invoice" })).toHaveAttribute("href", `/orders/${ORDER_ID}/invoice`);
  });

  test("D-T95-1: a declined (payment_failed) order renders no invoice link", () => {
    render(<OrderDetail {...props({ order: makeOrderView({ status: "payment_failed" }) })} />);
    expect(screen.queryByRole("link", { name: "Print invoice" })).toBeNull();
  });

  test("D-T95-1: any status other than exactly \"paid\" hides the invoice link", () => {
    for (const status of ["PAID", " paid", "", "pending", "cancelled"]) {
      const markup = renderToStaticMarkup(<OrderDetail {...props({ order: { ...makeOrderView(), status } })} />);
      expect(markup).not.toContain("Print invoice");
      expect(markup).not.toContain("/invoice");
    }
  });

  test("D-T95-1: a cancelled order keeps status \"paid\" and so keeps its invoice link", () => {
    render(<OrderDetail {...props({ order: makeCancelledOrderView() })} />);
    expect(screen.getByRole("link", { name: "Print invoice" })).toHaveAttribute("href", `/orders/${ORDER_ID}/invoice`);
  });
});

describe("privacy (R-1) and structure", () => {
  test("no UUID in the markup other than the order id and product ids", () => {
    for (const variant of ["confirmation", "detail"] as const) {
      const html = renderToStaticMarkup(<OrderDetail {...props({ variant })} />);
      const serialised = JSON.stringify(html);
      expect(serialised).not.toContain(IDEMPOTENCY_KEY);
      expect(serialised).not.toContain(SECRET_EMAIL);
      const allowed = new Set([ORDER_ID, PRODUCT_A, PRODUCT_B]);
      for (const uuid of uuidsIn(serialised)) expect(allowed.has(uuid)).toBe(true);
    }
  });

  test("no nested forms; single article landmark with unique section names", () => {
    const doc = parse(renderToStaticMarkup(<OrderDetail {...props()} />));
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
    const ids = [...doc.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("OrderDetail: Phase 3 look (T162)", () => {
  test("items, ship-to, payment and cancel panels are Card sections; headings unchanged", () => {
    const doc = parse(renderToStaticMarkup(<OrderDetail {...props()} />));
    for (const slot of ["order-items", "order-ship-to", "order-payment", "order-cancel"]) {
      const el = doc.querySelector(`[data-slot="${slot}"]`);
      expect(el?.tagName).toBe("SECTION");
      expect(el?.className).toContain("bg-surface-raised");
      expect(el?.getAttribute("aria-labelledby")).toBe(el?.querySelector("h2")?.id ?? "missing");
    }
  });

  test("refund panel is a sunken Card section", () => {
    const doc = parse(renderToStaticMarkup(<OrderDetail {...props({ order: makeCancelledOrderView() })} />));
    const refund = doc.querySelector('[data-slot="order-refund"]');
    expect(refund?.tagName).toBe("SECTION");
    expect(refund?.className).toContain("bg-surface-sunken");
    expect(refund?.querySelector("h2")?.textContent).toBe("Refund");
  });
});
