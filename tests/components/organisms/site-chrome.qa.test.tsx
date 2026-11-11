// QA (T17): SiteHeader + SiteFooter.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { SiteHeader, MAX_VISIBLE_CART_COUNT } from "@/components/organisms/SiteHeader";
import { SiteFooter } from "@/components/organisms/SiteFooter";
import { expectFocused } from "@/test/dom-assertions";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Page({ cartCount = 0 }: { cartCount?: number }) {
  return (
    <div>
      <SiteHeader cartCount={cartCount} />
      <main id="main" tabIndex={-1}>
        <h1>Page</h1>
        <a href="/x">In-page link</a>
      </main>
      <SiteFooter year={2026} />
    </div>
  );
}

function allClasses(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((el) =>
    (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean),
  );
}

describe("T17.1 skip link", () => {
  test("is the first focusable element in the page and targets #main", () => {
    const { container } = render(<Page />);
    const focusables = [...container.querySelectorAll(FOCUSABLE)];
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(focusables[0]).toBe(skip);
    expect(skip.getAttribute("href")).toBe("#main");
  });

  test("its target exists, is the <main> landmark, and can take focus", () => {
    render(<Page />);
    const skip = screen.getByRole("link", { name: "Skip to content" }) as HTMLAnchorElement;
    const target = document.getElementById(skip.getAttribute("href")!.slice(1));
    expect(target).toBe(screen.getByRole("main"));
    target!.focus();
    expectFocused(target);
  });

  test("the app layout renders <main id=\"main\" tabIndex={-1}> (read-only check)", () => {
    const layout = readFileSync(join(import.meta.dir, "../../../src/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/<main[^>]*id="main"[^>]*tabIndex=\{-1\}/);
  });

  test("is visually hidden until focused (sr-only + focus:not-sr-only), not display:none", () => {
    render(<SiteHeader cartCount={0} />);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveClass("sr-only", "focus:not-sr-only");
    expect(skip).not.toHaveClass("hidden");
    expect(skip).not.toHaveAttribute("tabindex");
    skip.focus();
    expectFocused(skip);
  });
});

describe("T17.2 cart link accessible name and count", () => {
  const table: Array<[number, string, string]> = [
    [0, "Cart, 0 items", "0"],
    [1, "Cart, 1 item", "1"],
    [3, "Cart, 3 items", "3"],
    [99, "Cart, 99 items", "99"],
    [100, "Cart, 100 items", "99+"],
    [150, "Cart, 150 items", "99+"],
    [-1, "Cart, 0 items", "0"],
    [2.5, "Cart, 0 items", "0"],
    [Number.NaN, "Cart, 0 items", "0"],
    [Number.POSITIVE_INFINITY, "Cart, 0 items", "0"],
  ];
  for (const [count, name, visible] of table) {
    test(`cartCount ${String(count)} -> name "${name}", badge "${visible}"`, () => {
      render(<SiteHeader cartCount={count} />);
      const link = screen.getByRole("link", { name });
      expect(link).toHaveAccessibleName(name);
      expect(link.getAttribute("href")).toBe("/cart");
      const badge = within(link).getByTestId("cart-count");
      expect(badge.textContent).toBe(visible);
      // Visible label-in-name: visible "Cart" starts the accessible name.
      expect(name.startsWith("Cart")).toBe(true);
    });
  }

  test("MAX_VISIBLE_CART_COUNT is 99", () => {
    expect(MAX_VISIBLE_CART_COUNT).toBe(99);
  });

  test("only one link is named Cart*", () => {
    render(<SiteHeader cartCount={3} />);
    expect(screen.getAllByRole("link", { name: /^Cart/ })).toHaveLength(1);
  });

  test("currentPath /cart and /cart/x mark the Cart link aria-current=page; / marks Catalog only", () => {
    const { rerender } = render(<SiteHeader cartCount={1} currentPath="/cart" />);
    expect(screen.getByRole("link", { name: "Cart, 1 item" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Catalog" })).not.toHaveAttribute("aria-current");
    rerender(<SiteHeader cartCount={1} currentPath="/cart/x" />);
    expect(screen.getByRole("link", { name: "Cart, 1 item" })).toHaveAttribute("aria-current", "page");
    rerender(<SiteHeader cartCount={1} currentPath="/" />);
    expect(screen.getByRole("link", { name: "Catalog" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Cart, 1 item" })).not.toHaveAttribute("aria-current");
    rerender(<SiteHeader cartCount={1} currentPath="/cartography" />);
    expect(screen.getByRole("link", { name: "Cart, 1 item" })).not.toHaveAttribute("aria-current");
  });
});

describe("T17.3 landmarks", () => {
  test("header/footer elements; banner, contentinfo, main unique; navs uniquely named", () => {
    render(<Page cartCount={3} />);
    const banners = screen.getAllByRole("banner");
    expect(banners).toHaveLength(1);
    expect(banners[0]!.tagName).toBe("HEADER");
    const footers = screen.getAllByRole("contentinfo");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.tagName).toBe("FOOTER");
    expect(screen.getAllByRole("main")).toHaveLength(1);
    // T163 pin move (T148/T150): the MVP header row is a plain list (no "Main" nav); the v3 footer has
    // "Footer: Quick links" + one "Footer: <heading>" nav per column. Names stay unique.
    const navs = screen.getAllByRole("navigation");
    const names = navs.map((n) => n.getAttribute("aria-label"));
    expect(names[0]).toBe("Footer: Quick links");
    expect(names.every((n) => (n ?? "").startsWith("Footer: "))).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(within(banners[0]!).queryAllByRole("navigation")).toHaveLength(0);
    expect(within(banners[0]!).getByRole("list")).toBeInTheDocument();
    expect(within(footers[0]!).getByRole("navigation", { name: "Footer: Quick links" })).toBeInTheDocument();
  });

  test("navigation names do not repeat the word 'navigation'", () => {
    render(<Page />);
    for (const n of screen.getAllByRole("navigation")) {
      expect(n.getAttribute("aria-label")!.toLowerCase()).not.toContain("navigation");
    }
  });

  test("skip link sits outside the banner (before it)", () => {
    render(<SiteHeader cartCount={0} />);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(screen.getByRole("banner").contains(skip)).toBe(false);
  });

  // T163 pin move (T150): empty `links` adds no column nav; quick links + Legal remain; default name is SITE_NAME.
  test("footer: empty links renders no links column; external link gets sr-only new-tab notice", () => {
    const { unmount } = render(<SiteFooter year={2026} links={[]} />);
    expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual([
      "Footer: Quick links",
      "Footer: Legal",
    ]);
    expect(screen.getByRole("contentinfo")).toHaveTextContent("© 2026 Northwind Goods. All rights reserved.");
    unmount();
    render(<SiteFooter year={2026} storeName="Acme" links={[{ href: "https://example.com", label: "Docs", external: true }]} />);
    const link = screen.getByRole("link", { name: /Docs/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveTextContent("(opens in new tab)");
    expect(screen.getByRole("contentinfo")).toHaveTextContent("© 2026 Acme.");
  });
});

describe("T17.4 no overflow at 320px (classes)", () => {
  test("header/footer rows wrap and can shrink; no unprefixed fixed widths or arbitrary values", () => {
    const { container } = render(<Page cartCount={150} />);
    const header = screen.getByRole("banner");
    const row = header.firstElementChild!;
    expect(row).toHaveClass("flex-wrap", "min-w-0");
    expect(within(header).getByRole("list")).toHaveClass("flex-wrap", "min-w-0");
    // T163 pin move (T150): the footer has several lists; the quick-links row is the wrapping one.
    expect(within(screen.getByRole("navigation", { name: "Footer: Quick links" })).getByRole("list")).toHaveClass("flex-wrap");
    const classes = allClasses(container);
    // Fixed widths without a breakpoint prefix (w-64, min-w-80, w-screen...) would risk overflow.
    const fixed = classes.filter((c) => /^(min-)?w-(?!full$|fit$|auto$|0$|touch$|px$)/.test(c));
    expect(fixed).toEqual([]);
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /^(whitespace-nowrap|text-nowrap|overflow-x-scroll)$/.test(c))).toEqual([]);
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });

  test("very long store name breaks words instead of overflowing", () => {
    render(<SiteHeader cartCount={0} storeName={"Supercalifragilistic".repeat(10)} />);
    expect(screen.getByRole("link", { name: /^Supercali/ })).toHaveClass("break-words", "min-w-0");
  });

  test("sticky header uses the z-sticky token (not a bare z-50)", () => {
    render(<SiteHeader cartCount={0} />);
    const header = screen.getByRole("banner");
    expect(header).toHaveClass("sticky", "z-sticky");
    expect(header.className).not.toMatch(/\bz-\d+/);
  });
});
