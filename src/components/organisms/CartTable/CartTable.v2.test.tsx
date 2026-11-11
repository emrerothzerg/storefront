import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { ok } from "@/lib/result";
import { formatMoney } from "@/lib/money";
import type { CartActionFn, CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import type { SavedForLaterLine } from "@/server/cart/cart-service";
import { CartTable, REDUCED_WARNING, UNAVAILABLE_WARNING, type CartTableData, type CartTableLine, type CartTableProps } from "./CartTable";

const noop: CartActionFn = async () => ok({ itemCount: 0, subtotalCents: 0, message: "" });
const noopV2: CartActionFnV2 = async () => null;
const noopList: ListActionFn = async () => null;

function line(overrides: Partial<CartTableLine> = {}): CartTableLine {
  return {
    productId: "p1",
    name: "Canvas Tote",
    slug: "canvas-tote",
    imageUrl: "/images/tote.jpg",
    quantity: 2,
    unitPriceCents: 1250,
    lineTotalCents: 2500,
    availableStock: 5,
    status: "ok",
    ...overrides,
  };
}

const cartWith = (items: CartTableLine[], extra: Partial<CartTableData> = {}): CartTableData => ({
  items,
  subtotalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0),
  currency: "USD",
  itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
  canCheckout: items.length > 0,
  ...extra,
});

const emptyCart = cartWith([], { canCheckout: false });

function savedLine(overrides: Partial<SavedForLaterLine> = {}): SavedForLaterLine {
  return {
    productId: "s1",
    product: {
      id: "s1",
      slug: "lamp",
      name: "Desk Lamp",
      description: "",
      priceCents: 3000,
      currency: "USD",
      imageUrl: "/images/lamp.jpg",
      stock: 3,
    },
    quantityDesired: 1,
    available: true,
    priceCents: 3000,
    priceDroppedByCents: null,
    addedAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

function savedProp(items: SavedForLaterLine[] = [savedLine()]): NonNullable<CartTableProps["saved"]> {
  return { items, listId: "sfl-1", actions: { moveToCart: noopV2, removeSaved: noopList } };
}

function ui(cart: CartTableData, props: Partial<CartTableProps> = {}) {
  return <CartTable cart={cart} updateQuantity={noop} removeItem={noop} {...props} />;
}

describe("CartTable v2", () => {
  test("saved section renders below the cart, outside the summary", () => {
    render(ui(cartWith([line()]), { saved: savedProp() }));
    const savedRegion = screen.getByRole("region", { name: "Saved for later (1 item)" });
    const summary = screen.getByRole("region", { name: "Cart summary" });
    expect(summary.contains(savedRegion)).toBe(false);
    const cartList = screen.getByRole("list", { name: "Cart items" });
    // Document order: cart list, then saved section.
    expect(cartList.compareDocumentPosition(savedRegion) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(savedRegion).getByText("In stock")).toBeInTheDocument();
  });

  test("saved section hidden when there are no saved items", () => {
    render(ui(cartWith([line()]), { saved: savedProp([]) }));
    expect(screen.queryByRole("region", { name: /Saved for later/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Saved for later/ })).toBeNull();
  });

  test("saved items do not affect the checkout rule", () => {
    const { unmount } = render(ui(cartWith([line()]), { saved: savedProp([savedLine({ available: false })]) }));
    expect(screen.getByRole("link", { name: "Proceed to checkout" })).toHaveAttribute("href", "/checkout");
    unmount();
    render(
      ui(cartWith([line({ status: "reduced", quantity: 3, availableStock: 3, lineTotalCents: 3750 })], { canCheckout: true }), {
        saved: savedProp(),
        saveForLaterAction: noopV2,
        thumbnails: true,
      }),
    );
    expect(screen.getByText(REDUCED_WARNING)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
  });

  test("UI keeps the stricter rule: server canCheckout=true + unavailable line -> no checkout link", () => {
    render(
      ui(cartWith([line(), line({ productId: "p2", name: "Gone", status: "unavailable", availableStock: 0, lineTotalCents: 0 })], { canCheckout: true }), {
        saveForLaterAction: noopV2,
      }),
    );
    expect(screen.getByText(UNAVAILABLE_WARNING)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
    // The unavailable line can be saved for later instead of removed.
    expect(screen.getByRole("button", { name: "Save for later: Gone" })).toBeEnabled();
  });

  test("empty cart: empty state + emptyState slot + saved section; no checkout", () => {
    render(ui(emptyCart, { saved: savedProp(), emptyState: <p>Suggested for you</p> }));
    expect(screen.getByText("Your cart is empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toBeInTheDocument();
    expect(screen.getByText("Suggested for you")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Saved for later (1 item)" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
    expect(screen.queryByRole("region", { name: "Cart summary" })).toBeNull();
  });

  test("saveForLaterAction reaches every line and posts that line's productId", async () => {
    const calls: Array<FormDataEntryValue | null> = [];
    const save: CartActionFnV2 = async (_p, fd) => {
      calls.push(fd.get("productId"));
      return null;
    };
    render(ui(cartWith([line(), line({ productId: "p2", name: "Mug", quantity: 1, unitPriceCents: 900, lineTotalCents: 900 })]), { saveForLaterAction: save }));
    expect(screen.getByRole("button", { name: "Save for later: Canvas Tote" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save for later: Mug" }));
    await waitFor(() => expect(calls).toEqual(["p2"]));
  });

  test("without saveForLaterAction no Save buttons render", () => {
    render(ui(cartWith([line()])));
    expect(screen.queryByRole("button", { name: /Save for later/ })).toBeNull();
  });

  test("thumbnails flag: 64px image per line with alt = product name", () => {
    const { unmount } = render(ui(cartWith([line()])));
    expect(screen.queryByRole("img", { name: "Canvas Tote" })).toBeNull();
    unmount();
    render(ui(cartWith([line()]), { thumbnails: true }));
    expect(screen.getByRole("img", { name: "Canvas Tote" })).toHaveAttribute("width", "64");
  });

  test("line names link to the product page; vanished products (empty slug) stay plain text", () => {
    render(ui(cartWith([line(), line({ productId: "x", name: "Unavailable product", slug: "", status: "unavailable", availableStock: 0, lineTotalCents: 0 })])));
    expect(screen.getByRole("link", { name: "Canvas Tote" })).toHaveAttribute("href", "/products/canvas-tote");
    expect(screen.queryByRole("link", { name: "Unavailable product" })).toBeNull();
  });

  test('slugs that fail isAllowedInternalHref ("..", ".") render the name as plain text (D-T82-2)', () => {
    render(ui(cartWith([line({ productId: "a", name: "Dot Dot", slug: ".." }), line({ productId: "b", name: "Dot", slug: "." })])));
    expect(screen.queryByRole("link", { name: "Dot Dot" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Dot" })).toBeNull();
    expect(screen.getByText("Dot Dot")).toBeInTheDocument();
    expect(screen.getByText("Dot")).toBeInTheDocument();
  });

  test("line name links carry the 44px touch class (D-T82-3)", () => {
    render(ui(cartWith([line()])));
    expect(screen.getByRole("link", { name: "Canvas Tote" }).className).toContain("min-h-touch");
  });

  test('line total text "Line total: $X" = unit x quantity; per-line savings from listPriceCents', () => {
    render(ui(cartWith([line({ quantity: 3, unitPriceCents: 1999, lineTotalCents: 5997, listPriceCents: 2499 })])));
    const item = screen.getByRole("listitem");
    expect(within(item).getByTestId("line-total-label")).toHaveTextContent("Line total:");
    expect(within(item).getByTestId("line-total")).toHaveTextContent("$59.97");
    expect(within(item).getByTestId("line-savings")).toHaveTextContent(`You save ${formatMoney(500 * 3, "USD")}`);
  });

  test("large integer totals stay exact", () => {
    const unit = 2 ** 51;
    render(ui(cartWith([line({ unitPriceCents: unit, quantity: 3, availableStock: 9, lineTotalCents: unit * 3 })])));
    expect(screen.getByTestId("line-total").textContent).toBe(formatMoney(unit * 3, "USD"));
  });

  test("checkoutHref still configurable with v2 props", () => {
    render(ui(cartWith([line()]), { checkoutHref: "/pay", saved: savedProp(), thumbnails: true, saveForLaterAction: noopV2 }));
    expect(screen.getByRole("link", { name: "Proceed to checkout" })).toHaveAttribute("href", "/pay");
  });

  test("server markup: plain forms for save / move / delete with hidden fields", () => {
    const html = renderToStaticMarkup(ui(cartWith([line()]), { saved: savedProp(), saveForLaterAction: noopV2, thumbnails: true }));
    // update + save + remove (line) + move + delete (saved)
    expect((html.match(/<form/g) ?? []).length).toBe(5);
    expect(html).toContain('type="hidden" name="productId" value="p1"');
    expect(html).toContain('type="hidden" name="productId" value="s1"');
    expect(html).toContain('type="hidden" name="listId" value="sfl-1"');
    for (const label of ["Save for later", "Move to cart", "Delete"]) {
      expect(html).toMatch(new RegExp(`<button[^>]*type="submit"[^>]*>${label}</button>`));
    }
  });

  test("320px: saved section and lines shrink and wrap", () => {
    render(ui(cartWith([line()]), { saved: savedProp(), thumbnails: true, saveForLaterAction: noopV2 }));
    expect(screen.getByRole("region", { name: /Saved for later/ })).toHaveClass("min-w-0");
    for (const li of screen.getAllByRole("listitem")) expect(li).toHaveClass("min-w-0");
  });
});

// ---------------------------------------------------------------------------
// T108 (additive): hideSummary
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the default (MVP props only) server markup captured BEFORE `hideSummary` was added,
 * re-captured after FIX-org-D (D-T82-3) added `inline-flex min-h-touch items-center` to the
 * product-name link class; that class is the only difference from the original capture
 * (bf825f5c…, verified by reverting the class string and re-hashing).
 * Re-captured in T161 (Phase 3 light-only pass: Card surfaces, superscript estimated total).
 * Before T161 the stored hash was already stale from the upstream P3-D1/T145/T146 atom and
 * molecule restyles: with T161's CartTable edits reverted the markup hashed to 2997223c…
 * (not cf4c5851…); with them applied it hashes to the value below. The hideSummary={false}
 * equality test underneath keeps the behavioural guarantee independent of the hash.
 * CLEANUP-P3 (cc, D-T161-1): CartLineItem "Remove" ghost -> danger; with only that change
 * reverted the markup still hashes to ea9d0e6c…, so the value below differs by that alone.
 */
const PRE_T108_MARKUP_SHA256 = "cdb2dddd6fd2f7acf3f47a33382c0ba744e909ba5b9f7bc7cb22607d215ebcd7";

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const baselineCart: CartTableData = {
  items: [
    {
      productId: "p1",
      name: "Canvas Tote",
      slug: "canvas-tote",
      imageUrl: "/images/tote.jpg",
      quantity: 2,
      unitPriceCents: 1250,
      lineTotalCents: 2500,
      availableStock: 5,
      status: "ok",
    },
  ],
  subtotalCents: 2500,
  currency: "USD",
  itemCount: 2,
  canCheckout: true,
};

describe("CartTable hideSummary (T108)", () => {
  test("default markup is byte-identical to the pre-T108 markup", () => {
    expect(sha256(renderToStaticMarkup(ui(baselineCart)))).toBe(PRE_T108_MARKUP_SHA256);
  });

  test("hideSummary={false} renders exactly the default markup (filled and empty carts)", () => {
    for (const cart of [baselineCart, cartWith([line(), line({ productId: "p2", status: "unavailable" })]), emptyCart]) {
      expect(renderToStaticMarkup(ui(cart, { hideSummary: false }))).toBe(renderToStaticMarkup(ui(cart)));
    }
  });

  test("hideSummary omits the summary box, warning and checkout link; lines stay", () => {
    render(ui(cartWith([line()]), { hideSummary: true }));
    expect(screen.queryByRole("region", { name: "Cart summary" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Proceed to checkout" })).toBeNull();
    expect(screen.queryByText("Estimated total")).toBeNull();
    expect(screen.getByRole("list", { name: "Cart items" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Canvas Tote" })).toHaveAttribute("href", "/products/canvas-tote");
  });

  test("hideSummary hides the unavailable warning too (the page's CartSummary explains it)", () => {
    render(ui(cartWith([line({ status: "unavailable" })]), { hideSummary: true }));
    expect(screen.queryByText(UNAVAILABLE_WARNING)).toBeNull();
    expect(screen.queryByText(REDUCED_WARNING)).toBeNull();
  });

  test("hideSummary keeps the saved section and the live region", () => {
    render(ui(cartWith([line()]), { hideSummary: true, saved: savedProp() }));
    expect(screen.getByRole("region", { name: "Saved for later (1 item)" })).toBeInTheDocument();
    expect(screen.getByTestId("cart-live-region")).toBeInTheDocument();
  });

  test("hideSummary has no effect on the empty state", () => {
    expect(renderToStaticMarkup(ui(emptyCart, { hideSummary: true }))).toBe(renderToStaticMarkup(ui(emptyCart)));
  });
});

describe("CartTable T161 light-only pass", () => {
  test("T161: lines, summary and empty state sit on Card surfaces; Estimated total is a superscript Price", () => {
    const { unmount } = render(ui(cartWith([line()])));
    const list = screen.getByRole("list", { name: "Cart items" });
    expect(list.parentElement).toHaveClass("bg-surface-raised", "rounded-lg", "border-border-default");
    const summary = screen.getByRole("region", { name: "Cart summary" });
    expect(summary.tagName).toBe("SECTION");
    expect(summary).toHaveClass("bg-surface-raised", "rounded-lg", "shadow-sm");
    const total = summary.querySelectorAll("dd")[2];
    const visual = total?.querySelector('[data-slot="price-superscript"]');
    expect(visual?.getAttribute("aria-hidden")).toBe("true");
    expect(within(total as HTMLElement).getByText("$25.00")).toHaveClass("sr-only");
    // Subtotal stays a one-run standard price.
    expect(summary.querySelectorAll("dd")[0]?.textContent).toBe("$25.00");
    unmount();
    render(ui(cartWith([])));
    const heading = screen.getByRole("heading", { level: 2, name: "Your cart is empty" });
    expect(heading.parentElement).toHaveClass("bg-surface-sunken", "rounded-lg", "text-center");
  });
});
