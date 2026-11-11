import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { SiteHeader, normalizeCartCount } from "./SiteHeader";
import { expectFocused } from "@/test/dom-assertions";

function firstFocusable(container: HTMLElement): Element | null {
  return container.querySelector("a[href], button");
}

describe("SiteHeader", () => {
  test("skip link is the first focusable element and targets #main", () => {
    const { container } = render(<SiteHeader cartCount={0} />);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(firstFocusable(container)).toBe(skip);
    expect(skip).toHaveAttribute("href", "#main");
    expect(skip).toHaveClass("sr-only", "focus:not-sr-only");
  });

  test("skip link receives focus and becomes visible via focus utilities", () => {
    render(<SiteHeader cartCount={0} />);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    skip.focus();
    expectFocused(skip);
    expect(skip).toHaveClass("focus:bg-surface-raised", "focus:text-text-primary", "focus:z-toast");
  });

  test("renders a single banner landmark with a sticky token-styled header", () => {
    render(<SiteHeader cartCount={0} />);
    const banner = screen.getByRole("banner");
    expect(banner.tagName).toBe("HEADER");
    expect(banner).toHaveClass(
      "sticky",
      "top-0",
      "z-sticky",
      "bg-surface-page",
      "border-b",
      "border-border-default",
    );
  });

  // T148: the row-1 links are a plain list (no "Main" nav landmark); the header's
  // navs are now CategoryNav "Primary" and the drawer's "Departments".
  test("row-1 list contains Catalog and Cart; the minimal header has no nav landmark", () => {
    render(<SiteHeader cartCount={2} />);
    const list = within(screen.getByRole("banner")).getByRole("list");
    expect(within(list).getByRole("link", { name: "Catalog" })).toHaveAttribute("href", "/");
    expect(within(list).getByRole("link", { name: /^Cart/ })).toHaveAttribute("href", "/cart");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  test("store name links home and defaults to Storefront", () => {
    const { unmount } = render(<SiteHeader cartCount={0} />);
    expect(screen.getByRole("link", { name: "Storefront" })).toHaveAttribute("href", "/");
    unmount();
    render(<SiteHeader cartCount={0} storeName="Acme Goods" />);
    const home = within(screen.getByRole("banner")).getByRole("link", { name: /Acme Goods/ });
    expect(home).toHaveAttribute("href", "/");
  });

  test.each<[number, string, string]>([
    [3, "Cart, 3 items", "3"],
    [1, "Cart, 1 item", "1"],
    [0, "Cart, 0 items", "0"],
    [99, "Cart, 99 items", "99"],
    [100, "Cart, 100 items", "99+"],
    [1234, "Cart, 1234 items", "99+"],
  ])("cartCount %d gives accessible name %p and shows %p", (count, name, visible) => {
    render(<SiteHeader cartCount={count} />);
    const cart = screen.getByRole("link", { name });
    const badge = within(cart).getByTestId("cart-count");
    expect(badge).toHaveTextContent(visible);
    expect(badge).toHaveAttribute("aria-hidden", "true");
  });

  test.each([-1, -50, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "invalid cartCount %p is treated as 0",
    (count) => {
      render(<SiteHeader cartCount={count} />);
      const cart = screen.getByRole("link", { name: "Cart, 0 items" });
      expect(within(cart).getByTestId("cart-count")).toHaveTextContent("0");
    },
  );

  test("normalizeCartCount clamps invalid input to 0", () => {
    expect(normalizeCartCount(5)).toBe(5);
    expect(normalizeCartCount(-3)).toBe(0);
    expect(normalizeCartCount(1.2)).toBe(0);
  });

  test("currentPath marks only the matching nav link as current", () => {
    const { unmount } = render(<SiteHeader cartCount={0} currentPath="/cart" />);
    const nav = within(screen.getByRole("banner")).getByRole("list");
    expect(within(nav).getByRole("link", { name: /^Cart/ })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Catalog" })).not.toHaveAttribute("aria-current");
    unmount();

    render(<SiteHeader cartCount={0} currentPath="/" />);
    const nav2 = within(screen.getByRole("banner")).getByRole("list");
    expect(within(nav2).getByRole("link", { name: "Catalog" })).toHaveAttribute("aria-current", "page");
    expect(within(nav2).getByRole("link", { name: /^Cart/ })).not.toHaveAttribute("aria-current");
  });

  test("no nav link is current when currentPath is omitted or unmatched", () => {
    render(<SiteHeader cartCount={0} currentPath="/products/shoe" />);
    const nav = within(screen.getByRole("banner")).getByRole("list");
    for (const link of within(nav).getAllByRole("link")) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  test("layout wraps without overflow at 320px (responsive classes)", () => {
    render(<SiteHeader cartCount={0} />);
    const row = screen.getByRole("banner").firstElementChild;
    expect(row).toHaveClass("flex", "flex-wrap", "gap-x-4", "px-4", "min-w-0");
    const list = within(screen.getByRole("banner")).getByRole("list");
    expect(list).toHaveClass("flex-wrap", "gap-2", "min-w-0");
  });
});
