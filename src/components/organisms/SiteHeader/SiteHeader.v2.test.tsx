import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DepartmentInput } from "@/components/molecules/DepartmentMenu";
import { ACCOUNT_NAV, AUTH_NAV, PRIMARY_NAV } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";
import type { Category } from "@/lib/types";
import { SiteHeader } from "./SiteHeader";
import type { SiteHeaderProps } from "./SiteHeader";
import type { HeaderAccount } from "./AccountMenu";

function category(id: string, name: string, parentId: string | null, sortOrder = 0): Category {
  return { id, slug: id, name, parentId, sortOrder } as Category;
}

const DEPARTMENTS: DepartmentInput[] = [
  { ...category("electronics", "Electronics", null, 1), children: [category("audio", "Audio", "electronics")] },
  { ...category("home", "Home & Kitchen", null, 2), children: [] },
];

const UTILITIES: SiteHeaderProps["utilityLinks"] = [
  { label: "Returns & Orders", href: "/orders", icon: "package" },
  { label: "Lists", href: "/lists", icon: "heart" },
];

const GUEST: HeaderAccount = { status: "guest" };
const SIGNED_IN: HeaderAccount = { status: "signed-in", displayName: "Ada Lovelace", signOutAction: () => {} };

function props(overrides: Partial<SiteHeaderProps> = {}): SiteHeaderProps {
  return {
    cartCount: 3,
    storeName: "Northwind Goods",
    departments: DEPARTMENTS,
    popularSearches: ["Electronics"],
    account: GUEST,
    utilityLinks: UTILITIES,
    primaryNav: PRIMARY_NAV,
    promo: { message: "Free shipping on orders of $35 or more", coupon: { code: "WELCOME10", description: "10% off" } },
    ...overrides,
  };
}

/**
 * React emits a form-replay `<script>` (and a `javascript:` placeholder action)
 * when a `<form action>` is a plain function, as in these tests. A real server
 * action reference (the layout binds `signOut`) renders a normal POST form.
 */
const REACT_FORM_REPLAY = /<script>addEventListener\("submit"[\s\S]*?<\/script>/;

function staticHtml(p: SiteHeaderProps): string {
  return renderToStaticMarkup(<SiteHeader {...p} />).replace(REACT_FORM_REPLAY, "");
}

function hrefsIn(root: ParentNode): string[] {
  return [...root.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
}

describe("SiteHeader v2: structure", () => {
  // T148: row-1 actions are a plain list (testid header-actions), not a "Main" nav.
  test("skip link first, then one banner holding logo, All menu, search, row-1 actions and Shop nav", () => {
    const { container } = render(<SiteHeader {...props()} />);
    const focusables = container.querySelectorAll("a[href], button, input, select, summary");
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(focusables[0]).toBe(skip);
    expect(skip).toHaveAttribute("href", "#main");

    const banners = screen.getAllByRole("banner");
    expect(banners).toHaveLength(1);
    const banner = banners[0]!;
    expect(within(banner).getByRole("link", { name: "Northwind Goods" })).toHaveAttribute("href", "/");
    expect(within(banner).getByRole("button", { name: /All/ })).toBeInTheDocument();
    expect(within(banner).getByRole("search")).toBeInTheDocument();
    expect(within(banner).getByTestId("header-actions").tagName).toBe("UL");
    expect(within(banner).queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(within(banner).getByRole("navigation", { name: "Shop" })).toBeInTheDocument();
  });

  test("landmarks are unique and nav names are distinct", () => {
    render(<SiteHeader {...props()} />);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("search")).toHaveLength(1);
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    // Legacy primaryNav row only (no categoryNav passed here; see SiteHeader.v3.test.tsx).
    expect(names).toEqual(["Shop"]);
  });

  test("row-1 actions: account block, Returns & Orders, Lists, then the cart with 'Cart, N items'", () => {
    render(<SiteHeader {...props({ cartCount: 3 })} />);
    const nav = screen.getByTestId("header-actions");
    expect(within(nav).getByRole("link", { name: "Hello, Sign in, Account & Lists" })).toHaveAttribute("href", "/signin");
    expect(within(nav).getByRole("link", { name: "Returns & Orders" })).toHaveAttribute("href", "/orders");
    expect(within(nav).getByRole("link", { name: "Lists" })).toHaveAttribute("href", "/lists");
    const cart = within(nav).getByRole("link", { name: "Cart, 3 items" });
    expect(cart).toHaveAttribute("href", "/cart");
    expect(within(cart).getByTestId("cart-count")).toHaveTextContent("3");
    expect(screen.getAllByRole("link", { name: /^Cart/ })).toHaveLength(1);
    // MVP "Catalog" link is replaced by the All menu + search in v2.
    expect(screen.queryByRole("link", { name: "Catalog" })).toBeNull();
  });

  test.each<[number, string]>([
    [0, "Cart, 0 items"],
    [1, "Cart, 1 item"],
    [150, "Cart, 150 items"],
  ])("cart count %d -> %p", (count, name) => {
    render(<SiteHeader {...props({ cartCount: count })} />);
    expect(screen.getByRole("link", { name })).toHaveAttribute("href", "/cart");
  });

  test("Shop nav renders PRIMARY_NAV in order, minus hrefs already in row 1", () => {
    render(<SiteHeader {...props()} />);
    const nav = screen.getByRole("navigation", { name: "Shop" });
    const rowOne = new Set(["/orders", "/lists", "/cart"]);
    const expected = PRIMARY_NAV.map((l) => l.href).filter((h) => !rowOne.has(h));
    expect(expected.length).toBeGreaterThan(0);
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(expected);
    // Each row-1 target has exactly one link in the header.
    for (const href of rowOne) {
      const banner = screen.getByRole("banner");
      const rowOneLinks = banner.querySelectorAll(`[data-testid="header-actions"] a[href="${href}"]:not([data-testid="account-menu"] a)`);
      expect(rowOneLinks.length).toBe(1);
      expect(banner.querySelectorAll(`nav[aria-label="Shop"] a[href="${href}"]`).length).toBe(0);
    }
  });

  test("without utility links, PRIMARY_NAV is rendered in full", () => {
    render(<SiteHeader {...props({ utilityLinks: [] })} />);
    const nav = screen.getByRole("navigation", { name: "Shop" });
    expect(within(nav).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(PRIMARY_NAV.map((l) => l.href));
  });

  test("icon utility links keep their text as the accessible name (visually hidden below sm)", () => {
    render(<SiteHeader {...props()} />);
    const link = screen.getByRole("link", { name: "Returns & Orders" });
    expect(link.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(within(link).getByText("Returns & Orders")).toHaveClass("sr-only", "sm:not-sr-only");
  });

  test("promo strip: free-shipping message and 'Use code WELCOME10 for 10% off', text only", () => {
    render(<SiteHeader {...props()} />);
    const strip = screen.getByTestId("promo-strip");
    expect(strip).toHaveTextContent("Free shipping on orders of $35 or more");
    expect(strip).toHaveTextContent("Use code WELCOME10 for 10% off");
    expect(strip.querySelectorAll("a, button")).toHaveLength(0);
  });

  test("promo strip: no coupon -> message only; nothing -> no strip", () => {
    const { unmount } = render(<SiteHeader {...props({ promo: { message: "Free shipping on orders of $35 or more", coupon: null } })} />);
    expect(screen.getByTestId("promo-strip")).not.toHaveTextContent("Use code");
    unmount();
    render(<SiteHeader {...props({ promo: { message: " ", coupon: null } })} />);
    expect(screen.queryByTestId("promo-strip")).toBeNull();
  });

  test("v2 header: only row 1 sticks, from lg (header box is lg:contents); MVP header keeps sticky top-0", () => {
    const { unmount } = render(<SiteHeader {...props()} />);
    const banner = screen.getByRole("banner");
    expect(banner).toHaveClass("lg:contents", "z-sticky");
    expect(banner).not.toHaveClass("sticky");
    expect(banner).not.toHaveClass("lg:sticky");
    expect(banner.firstElementChild).toHaveClass("lg:sticky", "lg:top-0", "lg:z-sticky", "bg-surface-page");
    expect(banner.firstElementChild).not.toHaveClass("sticky");
    unmount();
    render(<SiteHeader cartCount={0} />);
    expect(screen.getByRole("banner")).toHaveClass("sticky", "top-0");
  });

  test("320px: rows wrap and can shrink; search takes a full row below md", () => {
    render(<SiteHeader {...props()} />);
    const banner = screen.getByRole("banner");
    const row = banner.firstElementChild!;
    expect(row).toHaveClass("flex", "flex-wrap", "min-w-0", "relative");
    const searchRow = within(banner).getByRole("search").closest(".basis-full");
    expect(searchRow).not.toBeNull();
    expect(searchRow).toHaveClass("order-last", "min-w-0", "md:grow");
    const shopList = within(screen.getByRole("navigation", { name: "Shop" })).getByRole("list");
    expect(shopList).toHaveClass("flex-wrap", "min-w-0");
    expect(screen.getByTestId("header-actions")).toHaveClass("flex-wrap", "min-w-0");
  });
});

describe("SiteHeader v2: account block, two states (criterion 7)", () => {
  test("guest: 'Hello, Sign in' -> /signin; flyout = AUTH_NAV; no Sign out", () => {
    const { container } = render(<SiteHeader {...props({ account: GUEST })} />);
    expect(screen.getByRole("link", { name: "Hello, Sign in, Account & Lists" })).toHaveAttribute("href", "/signin");
    const menu = screen.getByTestId("account-menu");
    expect(hrefsIn(menu)).toEqual(AUTH_NAV.map((l) => l.href));
    expect(container.querySelector("form button[type=submit]")?.textContent ?? "").not.toContain("Sign out");
  });

  test("signed in: 'Hello, <name>' -> /account; flyout = ACCOUNT_NAV + Sign out form", () => {
    render(<SiteHeader {...props({ account: SIGNED_IN })} />);
    expect(screen.getByRole("link", { name: "Hello, Ada Lovelace, Account & Lists" })).toHaveAttribute("href", "/account");
    const menu = screen.getByTestId("account-menu");
    expect(hrefsIn(menu)).toEqual(ACCOUNT_NAV.map((l) => l.href));
    expect(within(menu).getByRole("button", { name: "Sign out", hidden: true }).closest("form")).not.toBeNull();
  });

  test("account nav overrides are allowlist-filtered", () => {
    render(
      <SiteHeader
        {...props({
          account: SIGNED_IN,
          accountNav: [
            { label: "Your account", href: "/account" },
            { label: "Evil", href: "https://evil.example/account" },
          ],
        })}
      />,
    );
    expect(hrefsIn(screen.getByTestId("account-menu"))).toEqual(["/account"]);
  });
});

describe("SiteHeader v2: hrefs (criterion 4)", () => {
  test.each<[string, HeaderAccount]>([
    ["guest", GUEST],
    ["signed in", SIGNED_IN],
  ])("every header href is an allowed internal route or #main (%s)", (_label, account) => {
    const { container } = render(<SiteHeader {...props({ account })} />);
    const hrefs = hrefsIn(container);
    expect(hrefs.length).toBeGreaterThan(10);
    for (const href of hrefs) {
      if (href === "#main") continue;
      expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
    }
    const html = renderToStaticMarkup(<SiteHeader {...props({ account })} />);
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
      if (href === "#main") continue;
      expect({ href, ok: isAllowedInternalHref(href!) }).toEqual({ href, ok: true });
    }
  });

  test("disallowed primaryNav / utility hrefs are dropped", () => {
    render(
      <SiteHeader
        {...props({
          primaryNav: [
            { label: "Deals", href: "/deals" },
            { label: "Evil", href: "//evil.example" },
            { label: "Ghost", href: "/not-a-route" },
          ],
          utilityLinks: [{ label: "Bad", href: "javascript:alert(1)" }],
        })}
      />,
    );
    const shop = screen.getByRole("navigation", { name: "Shop" });
    expect(hrefsIn(shop)).toEqual(["/deals"]);
    expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
  });

  test("an all-invalid primaryNav renders no Shop nav", () => {
    render(<SiteHeader {...props({ primaryNav: [{ label: "Evil", href: "https://evil.example" }] })} />);
    expect(screen.queryByRole("navigation", { name: "Shop" })).toBeNull();
  });
});

describe("SiteHeader v2: server HTML without JS", () => {
  test("static markup: skip link first, account link /account, cart name, no scripts or inline handlers", () => {
    const html = staticHtml(props({ account: SIGNED_IN, cartCount: 3 }));
    const firstAnchor = html.match(/<a [^>]*>/)?.[0] ?? "";
    expect(firstAnchor).toContain('href="#main"');
    expect(html.indexOf("Skip to content")).toBeLessThan(html.indexOf("<header"));
    expect(html).toMatch(/<a [^>]*href="\/account"/);
    expect(html).toContain("Hello, Ada Lovelace, Account &amp; Lists");
    expect(html).toContain("Cart, 3 items");
    expect(html).toMatch(/<a [^>]*href="\/cart"/);
    // The flyout is a native <details>, closed in the HTML, with its links present.
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    expect(html).toContain('href="/account/settings"');
    // "All" without JS is a link to the catalog; the search is a GET form to /search.
    expect(html).toMatch(/<a [^>]*href="\/products"/);
    expect(html).toMatch(/<form[^>]*action="\/search"/);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html).not.toMatch(/<a [^>]*href="javascript:/i);
  });

  test("static markup for guests links 'Hello, Sign in' to /signin", () => {
    const html = renderToStaticMarkup(<SiteHeader {...props({ account: GUEST })} />);
    // No form action at all for guests, so no React replay script either.
    expect(html).not.toContain("<script");
    expect(html).toMatch(/<a [^>]*href="\/signin"/);
    expect(html).toContain("Hello, Sign in, Account &amp; Lists");
  });

  test("hostile display name is escaped text everywhere", () => {
    const hostile = '"><script>alert(1)</script><img src=x onerror=alert(1)>';
    const html = staticHtml(props({ account: { status: "signed-in", displayName: hostile, signOutAction: () => {} } }));
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    const { container } = render(
      <SiteHeader {...props({ account: { status: "signed-in", displayName: hostile, signOutAction: () => {} } })} />,
    );
    expect(container.querySelector("script, img")).toBeNull();
  });
});
