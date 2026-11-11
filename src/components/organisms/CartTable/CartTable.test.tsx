import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { ok } from "@/lib/result";
import type { CartLineItemData } from "@/components/molecules/CartLineItem";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import { CartTable, REDUCED_WARNING, UNAVAILABLE_WARNING, cartAnnouncement, type CartTableData } from "./CartTable";

const noop: CartActionFn = async () => ok({ itemCount: 0, subtotalCents: 0, message: "" });

function line(overrides: Partial<CartLineItemData> = {}): CartLineItemData {
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

const cartWith = (items: CartLineItemData[], extra: Partial<CartTableData> = {}): CartTableData => ({
  items,
  subtotalCents: items.reduce((sum, i) => sum + i.lineTotalCents, 0),
  currency: "USD",
  itemCount: items.reduce((sum, i) => sum + i.quantity, 0),
  canCheckout: items.length > 0,
  ...extra,
});

const emptyCart: CartTableData = {
  items: [],
  subtotalCents: 0,
  currency: "USD",
  itemCount: 0,
  canCheckout: false,
};

function ui(cart: CartTableData, props: { checkoutHref?: string; continueShoppingHref?: string } = {}) {
  return <CartTable cart={cart} updateQuantity={noop} removeItem={noop} {...props} />;
}

function liveRegion(): HTMLElement {
  return screen.getByTestId("cart-live-region");
}

describe("CartTable", () => {
  test("empty cart: empty state + Continue shopping link, no checkout control, no list", () => {
    render(ui(emptyCart, { continueShoppingHref: "/catalog" }));
    expect(screen.getByText("Your cart is empty")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/catalog");
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /checkout/i })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("region", { name: "Cart summary" })).toBeNull();
  });

  test("empty cart: continue shopping defaults to /", () => {
    render(ui(emptyCart));
    expect(screen.getByRole("link", { name: "Continue shopping" })).toHaveAttribute("href", "/");
  });

  test("non-empty: list semantics (no table) with a visually hidden 'Cart items' heading", () => {
    const { container } = render(
      ui(cartWith([line(), line({ productId: "p2", name: "Mug", lineTotalCents: 900, quantity: 1, unitPriceCents: 900 })])),
    );
    expect(container.querySelector("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Cart items" });
    expect(list.tagName).toBe("UL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    const heading = screen.getByRole("heading", { level: 2, name: "Cart items" });
    expect(heading).toHaveClass("sr-only");
    expect(within(list).getByText("Canvas Tote")).toBeInTheDocument();
    expect(within(list).getByText("Mug")).toBeInTheDocument();
  });

  test("summary region shows Subtotal, Free shipping, emphasised Estimated total", () => {
    render(ui(cartWith([line()])));
    const summary = screen.getByRole("region", { name: "Cart summary" });
    expect(summary.tagName).toBe("SECTION");
    const terms = Array.from(summary.querySelectorAll("dt")).map((n) => n.textContent);
    expect(terms).toEqual(["Subtotal", "Shipping", "Estimated total"]);
    const dds = summary.querySelectorAll("dd");
    expect(dds[0]).toHaveTextContent("$25.00");
    expect(dds[1]).toHaveTextContent("Free");
    expect(dds[2]).toHaveTextContent("$25.00");
    expect(within(summary).getByText("Estimated total").parentElement).toHaveClass("text-h4", "font-semibold");
  });

  test("checkout link shown when canCheckout, href configurable, styled as a primary action, not nested", () => {
    render(ui(cartWith([line()]), { checkoutHref: "/pay" }));
    const checkout = screen.getByRole("link", { name: "Proceed to checkout" });
    expect(checkout).toHaveAttribute("href", "/pay");
    expect(checkout).toHaveClass("bg-accent");
    expect(Array.from(checkout.classList).filter((c) => c.includes("!"))).toEqual([]);
    expect(checkout.querySelector("a, button")).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_WARNING)).toBeNull();
  });

  test("checkout link defaults to /checkout", () => {
    render(ui(cartWith([line()])));
    expect(screen.getByRole("link", { name: "Proceed to checkout" })).toHaveAttribute("href", "/checkout");
  });

  test("canCheckout=false hides the checkout link", () => {
    render(ui(cartWith([line()], { canCheckout: false })));
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
  });

  test("any unavailable line: warning status, no checkout link even if canCheckout is true", () => {
    render(
      ui(
        cartWith([line(), line({ productId: "p2", name: "Gone", status: "unavailable", availableStock: 0 })], {
          canCheckout: true,
        }),
      ),
    );
    const summary = screen.getByRole("region", { name: "Cart summary" });
    const warning = within(summary).getByText(UNAVAILABLE_WARNING);
    expect(warning).toHaveAttribute("role", "status");
    expect(warning).toHaveClass("bg-warning-subtle", "text-warning");
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
    // Line-level notice from CartLineItem is still rendered.
    expect(screen.getByText("No longer available")).toBeInTheDocument();
  });

  test("reduced line (none unavailable): reduced warning status, no checkout link even if canCheckout", () => {
    render(
      ui(cartWith([line(), line({ productId: "p2", name: "Lamp", status: "reduced", quantity: 3, availableStock: 3, lineTotalCents: 3750 })], {
        canCheckout: true,
      })),
    );
    expect(screen.getByText(/Only 3 left/)).toBeInTheDocument();
    const summary = screen.getByRole("region", { name: "Cart summary" });
    const warning = within(summary).getByText(REDUCED_WARNING);
    expect(warning).toHaveAttribute("role", "status");
    expect(warning).toHaveClass("bg-warning-subtle", "text-warning");
    expect(within(summary).queryByText(UNAVAILABLE_WARNING)).toBeNull();
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
  });

  test("unavailable warning takes precedence over reduced", () => {
    render(
      ui(
        cartWith(
          [
            line({ status: "reduced", quantity: 3, availableStock: 3, lineTotalCents: 3750 }),
            line({ productId: "p2", name: "Gone", status: "unavailable", availableStock: 0 }),
          ],
          { canCheckout: true },
        ),
      ),
    );
    const summary = screen.getByRole("region", { name: "Cart summary" });
    expect(within(summary).getByText(UNAVAILABLE_WARNING)).toHaveAttribute("role", "status");
    expect(within(summary).queryByText(REDUCED_WARNING)).toBeNull();
    expect(screen.queryByRole("link", { name: /checkout/i })).toBeNull();
  });

  test("all lines ok + canCheckout: checkout link and no warning", () => {
    render(ui(cartWith([line(), line({ productId: "p2", name: "Mug", quantity: 1, unitPriceCents: 900, lineTotalCents: 900 })])));
    expect(screen.getByRole("link", { name: "Proceed to checkout" })).toBeInTheDocument();
    expect(screen.queryByText(REDUCED_WARNING)).toBeNull();
    expect(screen.queryByText(UNAVAILABLE_WARNING)).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("responsive at 320px: shrinkable containers and wrapping rows", () => {
    const { container } = render(ui(cartWith([line()])));
    const list = screen.getByRole("list", { name: "Cart items" });
    expect(list).toHaveClass("min-w-0");
    for (const li of within(list).getAllByRole("listitem")) expect(li).toHaveClass("min-w-0");
    expect(screen.getByRole("region", { name: "Cart summary" })).toHaveClass("min-w-0");
    expect(container.firstElementChild).toHaveClass("min-w-0");
    expect(container.querySelectorAll(".flex-wrap").length).toBeGreaterThan(0);
    // Summary only gets a fixed width from lg up.
    expect(screen.getByRole("region", { name: "Cart summary" })).toHaveClass("lg:w-80");
  });

  describe("live region", () => {
    test("is polite, visually hidden, and empty on first render", () => {
      render(ui(cartWith([line()])));
      const region = liveRegion();
      expect(region).toHaveAttribute("aria-live", "polite");
      expect(region).toHaveClass("sr-only");
      expect(region).toBeEmptyDOMElement();
    });

    test("announces when itemCount or subtotal changes", () => {
      const { rerender } = render(ui(cartWith([line()])));
      expect(liveRegion()).toBeEmptyDOMElement();

      rerender(ui(cartWith([line({ quantity: 3, lineTotalCents: 3750 })])));
      expect(liveRegion()).toHaveTextContent("Cart updated: 3 items, subtotal $37.50");

      // Subtotal change only (price refresh), same count.
      rerender(ui(cartWith([line({ quantity: 3, unitPriceCents: 1000, lineTotalCents: 3000 })])));
      expect(liveRegion()).toHaveTextContent("Cart updated: 3 items, subtotal $30.00");
    });

    test("does not change when totals are unchanged", () => {
      const { rerender } = render(ui(cartWith([line()])));
      rerender(ui(cartWith([line()], { canCheckout: false })));
      expect(liveRegion()).toBeEmptyDOMElement();
    });

    test("persists into the empty state so removing the last item is announced", () => {
      const { rerender } = render(ui(cartWith([line({ quantity: 1, lineTotalCents: 1250 })])));
      rerender(ui(emptyCart));
      expect(liveRegion()).toHaveTextContent("Cart updated: 0 items, subtotal $0.00");
      expect(screen.getByText("Your cart is empty")).toBeInTheDocument();
    });
  });

  test("cartAnnouncement singular/plural and invalid amounts", () => {
    expect(cartAnnouncement(1, 1250, "USD")).toBe("Cart updated: 1 item, subtotal $12.50");
    expect(cartAnnouncement(2, 2500, "USD")).toBe("Cart updated: 2 items, subtotal $25.00");
    expect(cartAnnouncement(2, -1, "USD")).toBe("Cart updated: 2 items");
    expect(cartAnnouncement(2, 100, "NOPE")).toBe("Cart updated: 2 items");
  });
});
