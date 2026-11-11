import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ToastProvider } from "@/components/atoms/Toast";
import type {
  CartActionFn,
  CartActionFnV2,
  CartActionState,
} from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import type { StockAlertActionFn } from "@/components/molecules/_contracts/stock-alert-actions";
import { fail, ok } from "@/lib/result";
import { BUY_BOX_MAX_QUANTITY, BuyBox, type BuyBoxProps } from "./BuyBox";

const success = ok({ itemCount: 1, subtotalCents: 2500, message: "Added to cart" });

function actions(overrides: Partial<BuyBoxProps["actions"]> = {}): BuyBoxProps["actions"] {
  const addToCart: CartActionFn = async () => success;
  const buyNow: CartActionFnV2 = async () => success;
  const list: ListActionFn = async () => null;
  const alert: StockAlertActionFn = async () => null;
  return {
    addToCart,
    buyNow,
    addToList: list,
    removeFromList: list,
    subscribeStockAlert: alert,
    unsubscribeStockAlert: alert,
    ...overrides,
  };
}

function props(overrides: Partial<BuyBoxProps> = {}): BuyBoxProps {
  return {
    product: {
      id: "prod_tote",
      slug: "canvas-tote-bag",
      name: "Canvas Tote Bag",
      priceCents: 1999,
      listPriceCents: 2999,
      currency: "USD",
      stock: 42,
      brandName: "Northwind",
    },
    actions: actions(),
    viewer: { inWishlist: false, alertRegistered: false },
    delivery: {
      estimate: { start: "2026-11-10T12:00:00.000Z", end: "2026-11-12T12:00:00.000Z" },
      methodName: "Standard Shipping",
      isFree: true,
    },
    ...overrides,
  };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function cartForm(doc: Document | HTMLElement): HTMLFormElement | null {
  const hidden = doc.querySelector('input[type="hidden"][name="productId"][value="prod_tote"]');
  const form = hidden?.closest("form") ?? null;
  return form && form.querySelector('input[name="quantity"]') ? form : null;
}

describe("BuyBox: in stock (static markup)", () => {
  const doc = parse(renderToStaticMarkup(<BuyBox {...props()} />));

  test("one cart form with Add to cart + Buy Now (formaction), hidden productId and quantity", () => {
    const quantityForms = doc.querySelectorAll('form:has(input[name="quantity"])');
    expect(quantityForms).toHaveLength(1);
    const form = cartForm(doc);
    expect(form).not.toBeNull();
    const submits = form?.querySelectorAll('button[type="submit"]') ?? [];
    expect(submits).toHaveLength(2);
    expect(submits[0]?.textContent).toContain("Add to cart");
    expect(submits[1]?.textContent).toContain("Buy Now");
    expect(submits[1]?.hasAttribute("formaction")).toBe(true);
    expect(doc.body.textContent).not.toContain("Notify me when available");
  });

  test("v3 white card styling, superscript price, delivery and trust lines as text", () => {
    const section = doc.querySelector("section");
    expect(section?.className).toContain("bg-surface-raised");
    expect(section?.className).toContain("border-border-default");
    expect(section?.className).toContain("rounded-lg");
    expect(section?.className).toContain("shadow-sm");
    expect(section?.className).toContain("min-w-0");
    // Not sticky unless asked for.
    expect(section?.className).not.toContain("sticky");
    expect(section?.hasAttribute("data-sticky")).toBe(false);
    const text = doc.body.textContent ?? "";
    expect(text).toContain("$19.99");
    expect(text).toContain("$29.99");
    expect(doc.querySelector('[data-slot="price-superscript"]')).not.toBeNull();
    expect(text).toContain("Standard Shipping");
    expect(text).toContain("Secure transaction");
    expect(text).toContain("Free returns within 30 days (sample policy)");
    expect(text).toContain("Ships from Northwind Goods");
    // Trust icons are decorative.
    const trustIcons = doc.querySelectorAll("section > ul li svg");
    expect(trustIcons.length).toBe(3);
    for (const icon of trustIcons) expect(icon.getAttribute("aria-hidden")).toBe("true");
  });

  test("P-6: struck 'Was $29.99' next to the 'Save $10.00 (33%)' badge; no stacked 'List price:' wording", () => {
    const struck = doc.querySelector('[data-slot="buy-box-price"] s');
    expect(struck?.textContent).toBe("Was $29.99");
    const badge = doc.querySelector("[data-saving-badge]");
    expect(badge?.textContent).toBe("Save $10.00 (33%)");
    expect(badge?.closest('[data-slot="buy-box-price"]')).not.toBeNull();
    const text = doc.body.textContent ?? "";
    expect(text).not.toContain("List price:");
    expect(text).not.toContain("You save");
  });

  test("(ca) the percent is stated once: SavingBadge only, no PriceBlock 'N% off'", () => {
    const price = doc.querySelector('[data-slot="buy-box-price"]');
    const text = price?.textContent ?? "";
    expect(text).not.toContain("% off");
    expect(text.match(/33%/g)?.length).toBe(1);
  });

  test("P-6: percent rounded down (1999 vs 2499 -> 'Save $5.00 (20%)')", () => {
    const base = props();
    const d = parse(
      renderToStaticMarkup(<BuyBox {...props({ product: { ...base.product, priceCents: 1999, listPriceCents: 2499 } })} />),
    );
    expect(d.querySelector("[data-saving-badge]")?.textContent).toBe("Save $5.00 (20%)");
  });

  test.each([null, undefined, 1999, 1500, -1, Number.NaN, 2.5])(
    "P-6: list price %p (price 1999) -> no saving, no strike, no badge",
    (listPriceCents) => {
      const base = props();
      const d = parse(renderToStaticMarkup(<BuyBox {...props({ product: { ...base.product, listPriceCents } })} />));
      expect(d.querySelector("[data-saving-badge]")).toBeNull();
      expect(d.querySelector('[data-slot="buy-box-price"] s')).toBeNull();
      expect(d.body.textContent ?? "").not.toMatch(/Save \$|Was \$|NaN/);
      expect(d.body.textContent).toContain("$19.99");
    },
  );

  test("stock pill: one 'In stock' status line (no duplicate badge)", () => {
    const pills = doc.querySelectorAll("[data-stock-status]");
    expect(pills).toHaveLength(1);
    expect(pills[0]?.textContent).toBe("In stock");
  });

  test("wish list is a full-width pill after the cart form", () => {
    const form = cartForm(doc);
    const wish = [...doc.querySelectorAll("button")].find((b) => /Wish List/.test(b.textContent ?? ""));
    expect(wish).toBeDefined();
    expect(wish?.className).toContain("w-full");
    if (form && wish) expect(form.compareDocumentPosition(wish) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("labelled section with a visually hidden heading (level 2 default, 3 on request)", () => {
    const heading = doc.querySelector("h2");
    expect(heading?.textContent).toBe("Buying options");
    expect(heading?.className).toContain("sr-only");
    expect(doc.querySelector("section")?.getAttribute("aria-labelledby")).toBe(heading?.id ?? "missing");
    const doc3 = parse(renderToStaticMarkup(<BuyBox {...props({ headingLevel: 3 })} />));
    expect(doc3.querySelector("h3")?.textContent).toBe("Buying options");
    expect(doc3.querySelector("h2")).toBeNull();
    expect(doc3.querySelector("h1")).toBeNull();
  });

  test("wish list button is rendered", () => {
    expect(doc.querySelector('[aria-label="Add Canvas Tote Bag to Wish List"], button')).not.toBeNull();
    expect(doc.body.textContent).toContain("Wish List");
  });

  test("no Share or Compare without their props (criterion 6)", () => {
    expect(doc.querySelector('form[action="/compare"]')).toBeNull();
    expect(doc.body.textContent).not.toContain("Compare");
    expect(doc.querySelector("details")).toBeNull();
    expect(doc.body.textContent).not.toContain("Share");
  });
});

describe("BuyBox: optional parts", () => {
  test("Share and Compare render when supplied; empty shareUrl does not render Share", () => {
    const doc = parse(
      renderToStaticMarkup(
        <BuyBox {...props({ shareUrl: "/products/canvas-tote-bag", compare: { selected: ["desk-lamp"] } })} />,
      ),
    );
    expect(doc.body.textContent).toContain("Share");
    expect(doc.querySelector('form[action="/compare"]')).not.toBeNull();
    const empty = parse(renderToStaticMarkup(<BuyBox {...props({ shareUrl: "   " })} />));
    expect(empty.body.textContent).not.toContain("Share");
  });

  test("promoted coupon is shown as text (hostile code inert); blank code or description -> no line", () => {
    const doc = parse(
      renderToStaticMarkup(<BuyBox {...props({ promotedCoupon: { code: "SAVE10", description: "10% off" } })} />),
    );
    expect(doc.body.textContent).toContain("Save with code SAVE10: 10% off");
    const evil = parse(
      renderToStaticMarkup(<BuyBox {...props({ promotedCoupon: { code: "<b>X</b>", description: "<i>y</i>" } })} />),
    );
    expect(evil.querySelector("b, i")).toBeNull();
    expect(evil.body.textContent).toContain("Save with code <b>X</b>: <i>y</i>");
    for (const promotedCoupon of [{ code: " ", description: "d" }, { code: "C", description: "  " }]) {
      const d = parse(renderToStaticMarkup(<BuyBox {...props({ promotedCoupon })} />));
      expect(d.body.textContent).not.toContain("Save with code");
    }
  });

  test("coupon line: icon is a non-shrinking flex sibling of a flex-1 text span, never wrapped onto its own line (U10)", () => {
    const doc = parse(
      renderToStaticMarkup(<BuyBox {...props({ promotedCoupon: { code: "FREESHIP", description: "Free shipping on orders of $20.00 or more" } })} />),
    );
    const line = doc.querySelector('[data-slot="buy-box-coupon"]');
    if (line === null) throw new Error("coupon line missing");
    const classes = line.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["flex", "items-start", "gap-1"]));
    expect(classes).not.toContain("flex-wrap");
    expect(classes).not.toContain("inline-flex");
    const [icon, text] = Array.from(line.children);
    expect(icon?.tagName.toLowerCase()).toBe("svg");
    expect(icon?.getAttribute("class") ?? "").toContain("shrink-0");
    expect(text?.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-1", "min-w-0"]));
  });

  test("compare + share share one row after the wish list; focus order quantity -> Add -> Buy Now -> list -> compare -> share", () => {
    const doc = parse(
      renderToStaticMarkup(
        <BuyBox {...props({ shareUrl: "/products/canvas-tote-bag", compare: { selected: [] } })} />,
      ),
    );
    const row = doc.querySelector('[data-slot="buy-box-secondary"]');
    expect(row?.querySelector('form[action="/compare"]')).not.toBeNull();
    expect(row?.textContent).toContain("Share");
    const focusables = [...doc.querySelectorAll("a[href], button, summary, input:not([type=hidden]), select, textarea")];
    const indexOf = (match: (el: Element) => boolean) => focusables.findIndex(match);
    const order = [
      indexOf((el) => el.getAttribute("name") === "quantity"),
      indexOf((el) => el.textContent === "Add to cart"),
      indexOf((el) => el.textContent === "Buy Now"),
      indexOf((el) => /Wish List/.test(el.textContent ?? "") || /Wish List/.test(el.getAttribute("aria-label") ?? "")),
      indexOf((el) => el.closest('form[action="/compare"]') !== null),
      indexOf((el) => /Share/.test(el.textContent ?? "")),
    ];
    for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test("no secondary row without compare or share", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props()} />));
    expect(doc.querySelector('[data-slot="buy-box-secondary"]')).toBeNull();
  });

  test("sticky opt-in: lg-only sticky classes and scroll margins for focused controls (P-14)", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({ sticky: true })} />));
    const cls = doc.querySelector("section")?.className.split(/\s+/) ?? [];
    expect(cls).toContain("lg:sticky");
    expect(cls).toContain("lg:top-4");
    expect(cls).not.toContain("sticky");
    expect(cls).toContain("**:scroll-mt-4");
    expect(doc.querySelector("section")?.hasAttribute("data-sticky")).toBe(true);
  });

  test("custom sellerName", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({ sellerName: "Acme" })} />));
    expect(doc.body.textContent).toContain("Ships from Acme");
  });
});

describe("BuyBox: out of stock (criterion 2)", () => {
  test.each([0, -1, Number.NaN, 2.5])("stock %p: no quantity, no Add/Buy buttons, StockAlertForm shown", (stock) => {
    const base = props();
    const doc = parse(renderToStaticMarkup(<BuyBox {...props({ product: { ...base.product, stock } })} />));
    expect(doc.querySelector('input[name="quantity"]')).toBeNull();
    const buttons = [...doc.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((t) => /add to cart/i.test(t))).toBe(false);
    expect(buttons.some((t) => /buy now/i.test(t))).toBe(false);
    expect(doc.body.textContent).toContain("Notify me when available");
    expect(doc.body.textContent).toContain("Wish List");
    expect(doc.body.textContent).toContain("Secure transaction");
    expect(doc.querySelector("[data-stock-status]")?.textContent).toBe("Out of stock");
    // Price and saving still shown when out of stock.
    expect(doc.querySelector("[data-saving-badge]")?.textContent).toBe("Save $10.00 (33%)");
  });

  test("registered viewer sees the registered state", () => {
    const base = props();
    const doc = parse(
      renderToStaticMarkup(
        <BuyBox
          {...props({
            product: { ...base.product, stock: 0 },
            viewer: { inWishlist: true, wishlistId: "list_1", alertRegistered: true, alertId: "alert_1" },
          })}
        />,
      ),
    );
    expect(doc.body.textContent).toContain("We'll let you know when this is back in stock.");
    expect(doc.body.textContent).toContain("Stop watching");
  });
});

describe("BuyBox: quantity cap and interaction", () => {
  test("stepper max = min(stock, 10)", () => {
    const base = props();
    const { unmount } = render(<BuyBox {...props()} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue(String(BUY_BOX_MAX_QUANTITY));
    unmount();
    render(<BuyBox {...props({ product: { ...base.product, stock: 3 } })} />);
    const qty3 = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty3, { key: "End" });
    expect(qty3).toHaveValue("3");
  });

  test("Add to cart success raises the 'Added to cart' toast and keeps the inline message", async () => {
    render(
      <ToastProvider>
        <BuyBox {...props()} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    const notifications = await screen.findByRole("region", { name: "Notifications" });
    await waitFor(() => expect(within(notifications).getByText("Added to cart")).toBeInTheDocument());
    expect(within(notifications).getByText("Canvas Tote Bag")).toBeInTheDocument();
    expect(within(notifications).getByRole("button", { name: "View cart" })).toBeInTheDocument();
  });

  test("works without a ToastProvider (no throw, inline message only)", async () => {
    const { container } = render(<BuyBox {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    const region = container.querySelector('form [aria-live="polite"]:not(.sr-only)');
    await waitFor(() => expect(region).toHaveTextContent("Added to cart"));
  });

  test("Buy Now posts the same fields to buyNow; its error shows inline with role=alert", async () => {
    const posted: { productId: FormDataEntryValue | null; quantity: FormDataEntryValue | null }[] = [];
    const buyNow: CartActionFnV2 = async (_p, fd) => {
      posted.push({ productId: fd.get("productId"), quantity: fd.get("quantity") });
      return fail("STOCK_CHANGED", "Stock changed.", { productId: "prod_tote", available: 1 });
    };
    render(<BuyBox {...props({ actions: actions({ buyNow }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    const alert = await screen.findByText(/Stock changed\./);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Available now: 1.");
    expect(posted).toEqual([{ productId: "prod_tote", quantity: "2" }]);
  });

  test("no toast for an add error", async () => {
    const addToCart: CartActionFn = async (): Promise<CartActionState> => fail("OUT_OF_STOCK", "Sold out.");
    render(
      <ToastProvider>
        <BuyBox {...props({ actions: actions({ addToCart }) })} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await screen.findByText("Sold out.");
    expect(within(screen.getByRole("region", { name: "Notifications" })).queryByText("Added to cart")).toBeNull();
  });
});

describe("BuyBox: hostile text (SR3) and layout", () => {
  test("hostile product name renders as text only", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const base = props();
    const html = renderToStaticMarkup(
      <BuyBox {...props({ product: { ...base.product, name: evil }, shareUrl: "/products/x", compare: { selected: [] } })} />,
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    const doc = parse(html);
    expect(doc.querySelector("img")).toBeNull();
    // The only script is React's own form-replay helper (progressive enhancement).
    for (const script of doc.querySelectorAll("script")) expect(script.textContent).not.toContain("alert(");
  });

  test("hostile slug cannot break the heading id", () => {
    const base = props();
    const doc = parse(
      renderToStaticMarkup(<BuyBox {...props({ product: { ...base.product, slug: '"><b>x</b>' } })} />),
    );
    const id = doc.querySelector("h2")?.id ?? "";
    expect(id).toMatch(/^buy-box-[a-z0-9-]+-heading$/);
    expect(doc.querySelector("b")).toBeNull();
  });

  test("tokens only: no arbitrary values or palette classes in BuyBox sources", () => {
    for (const file of ["BuyBox.tsx", "BuyBoxPurchase.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).not.toMatch(/\b[a-z-]+-\[[^\]]+\]/);
      expect(src).not.toMatch(/\b(?:bg|text|border)-(?:red|blue|green|gray|slate|zinc|neutral|white|black)\b/);
      expect(src).not.toContain("dangerouslySetInnerHTML");
    }
  });

  test("320px-safe: panel can shrink (min-w-0) and trust text wraps", () => {
    const doc = parse(renderToStaticMarkup(<BuyBox {...props()} />));
    expect(doc.querySelector("section")?.className).toContain("min-w-0");
    const span = doc.querySelector("ul li span");
    expect(span?.className).toContain("break-words");
  });
});
