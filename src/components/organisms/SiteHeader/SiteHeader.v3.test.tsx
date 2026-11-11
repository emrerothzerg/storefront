import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DepartmentInput } from "@/components/molecules/DepartmentMenu";
import { DEPARTMENT_NAV } from "@/content/navigation";
import { isAllowedInternalHref } from "@/content/routes";
import type { Category } from "@/lib/types";
import { SiteHeader } from "./SiteHeader";
import type { HeaderBenefits, SiteHeaderProps } from "./SiteHeader";
import type { HeaderAccount } from "./AccountMenu";
import { categorySlugFromPath } from "./header-model";

function category(id: string, name: string, parentId: string | null, sortOrder = 0): Category {
  return { id, slug: id, name, parentId, sortOrder } as Category;
}

const DEPARTMENTS: DepartmentInput[] = [
  { ...category("electronics", "Electronics", null, 1), children: [category("audio", "Audio", "electronics")] },
  { ...category("home-kitchen", "Home & Kitchen", null, 2), children: [] },
];

const BENEFITS: HeaderBenefits = {
  label: "Store benefits",
  items: [
    { id: "free-shipping", label: "Free shipping on orders of $35 or more", icon: "truck", href: "/shipping" },
    { id: "track-order", label: "Track your order", icon: "package", href: "/orders" },
    { id: "returns", label: "Returns and refunds", icon: "refresh", href: "/returns" },
    { id: "promo-code", label: "Use code WELCOME10 for 10% off", icon: "tag" },
  ],
};

const GUEST: HeaderAccount = { status: "guest" };
const SIGNED_IN: HeaderAccount = { status: "signed-in", displayName: "Ada Lovelace", signOutAction: () => {} };

/** What the v3 HeaderShell passes. */
function props(overrides: Partial<SiteHeaderProps> = {}): SiteHeaderProps {
  return {
    cartCount: 3,
    storeName: "Northwind Goods",
    departments: DEPARTMENTS,
    popularSearches: ["Electronics"],
    account: GUEST,
    utilityLinks: [{ label: "Lists", href: "/lists", icon: "heart" }],
    categoryNav: DEPARTMENT_NAV,
    benefits: BENEFITS,
    ...overrides,
  };
}

const REACT_FORM_REPLAY = /<script>addEventListener\("submit"[\s\S]*?<\/script>/;

describe("SiteHeader v3: landmarks and order (T148 criterion 1)", () => {
  test("skip link is the first focusable element; exactly one banner (HEADER)", () => {
    const { container } = render(<SiteHeader {...props()} />);
    const first = container.querySelector('a[href], button, input, select, textarea, summary, [tabindex="0"]');
    expect(first).toBe(screen.getByRole("link", { name: "Skip to content" }));
    expect(first).toHaveAttribute("href", "#main");
    const banners = screen.getAllByRole("banner");
    expect(banners).toHaveLength(1);
    expect(banners[0]!.tagName).toBe("HEADER");
    expect(banners[0]!.contains(first)).toBe(false);
  });

  test("closed drawer: navs = Primary only; search landmark 'Site search'; no Main/Shop nav", () => {
    render(<SiteHeader {...props()} />);
    expect(screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"))).toEqual(["Primary"]);
    const search = within(screen.getByRole("banner")).getByRole("search");
    expect(search).toHaveAccessibleName("Site search");
    expect(screen.getAllByRole("search")).toHaveLength(1);
  });

  test("open drawer adds nav 'Departments'; nav names stay unique", () => {
    render(<SiteHeader {...props()} />);
    const trigger = within(screen.getByTestId("header-menu")).getByRole("button", { name: /All/ });
    act(() => {
      fireEvent.click(trigger);
    });
    const names = screen.getAllByRole("navigation").map((n) => n.getAttribute("aria-label"));
    expect(names).toContain("Primary");
    expect(names).toContain("Departments");
    expect(new Set(names).size).toBe(names.length);
  });

  test("DOM order: wordmark, search, actions, menu; then category row, benefits", () => {
    render(<SiteHeader {...props()} />);
    const banner = screen.getByRole("banner");
    const row = banner.firstElementChild!;
    const kids = [...row.children].map((el) => el.getAttribute("data-testid"));
    expect(kids).toEqual(["header-wordmark", "header-search", "header-actions", "header-menu"]);
    const rows = [...banner.children].map((el) => el.getAttribute("data-testid"));
    expect(rows.slice(1)).toEqual(["header-category-row", "header-benefits"]);
  });
});

describe("SiteHeader v3: row 1", () => {
  test("wordmark is a text link 'Northwind Goods' to / (no image), in the accent colour", () => {
    render(<SiteHeader {...props()} />);
    const home = within(screen.getByRole("banner")).getByRole("link", { name: "Northwind Goods" });
    expect(home).toHaveAttribute("href", "/");
    expect(home.querySelector("img, svg")).toBeNull();
    expect(home.querySelector(".text-accent")).toHaveTextContent("Northwind Goods");
  });

  test("search: GET /search, q maxlength 100, pill placeholder", () => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(<SiteHeader {...props()} />), "text/html");
    const form = doc.querySelector('form[action="/search"]');
    expect(form).not.toBeNull();
    expect((form?.getAttribute("method") ?? "get").toLowerCase()).toBe("get");
    const q = doc.querySelector('input[name="q"]');
    expect(q?.getAttribute("maxlength")).toBe("100");
    expect(q?.getAttribute("placeholder")).toBe("Search products, categories and more");
  });

  test("guest: 'Sign in' link to /signin; signed in: greeting link to /account + POST sign-out form", () => {
    const { unmount } = render(<SiteHeader {...props({ account: GUEST })} />);
    const signIn = screen.getByRole("link", { name: "Hello, Sign in, Account & Lists" });
    expect(signIn).toHaveAttribute("href", "/signin");
    expect(signIn.textContent).toContain("Sign in");
    unmount();
    render(<SiteHeader {...props({ account: SIGNED_IN })} />);
    expect(screen.getByRole("link", { name: "Hello, Ada Lovelace, Account & Lists" })).toHaveAttribute("href", "/account");
    const menu = screen.getByTestId("account-menu");
    expect(within(menu).getByRole("button", { name: "Sign out", hidden: true }).closest("form")).not.toBeNull();
    for (const href of ["/account", "/orders", "/lists"]) {
      expect(menu.querySelector(`a[href="${href}"]`)).not.toBeNull();
    }
  });

  test("lists link and cart in the actions list; cart caps at 99+ with the full count hidden", () => {
    render(<SiteHeader {...props({ cartCount: 150 })} />);
    const actions = screen.getByTestId("header-actions");
    expect(within(actions).getByRole("link", { name: "Lists" })).toHaveAttribute("href", "/lists");
    const cart = within(actions).getByRole("link", { name: "Cart, 150 items" });
    expect(cart).toHaveAttribute("href", "/cart");
    expect(within(cart).getByTestId("cart-count")).toHaveTextContent("99+");
    expect(within(cart).getByTestId("cart-count")).toHaveAttribute("aria-hidden", "true");
    expect(within(cart).getByText("Cart, 150 items")).toHaveClass("sr-only");
    expect(screen.queryByRole("link", { name: "Returns & Orders" })).toBeNull();
  });
});

describe("SiteHeader v3: responsive classes (criterion 4)", () => {
  test("<768px: account and utility links hidden (drawer lists them), cart visible, menu only below md, search on its own row", () => {
    render(<SiteHeader {...props({ account: SIGNED_IN })} />);
    const actions = screen.getByTestId("header-actions");
    const items = [...actions.children];
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveClass("hidden", "md:block"); // account menu
    expect(items[1]).toHaveClass("hidden", "md:block"); // Lists
    expect(items[2]).toHaveClass("md:hidden"); // phone account icon link
    expect(items[2]!.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(items[3]!.className).not.toContain("hidden"); // cart
    expect(screen.getByTestId("header-menu")).toHaveClass("md:hidden");
    expect(screen.getByTestId("header-search")).toHaveClass("order-last", "basis-full", "min-w-0", "md:order-none", "md:grow");
    expect(screen.getByTestId("header-wordmark")).toHaveClass("min-w-0", "flex-1", "whitespace-nowrap", "text-body", "sm:text-h4", "md:flex-none");
  });

  test("category row shows from md; benefits row always (from md it scrolls inside its own container)", () => {
    render(<SiteHeader {...props()} />);
    expect(screen.getByTestId("header-category-row")).toHaveClass("hidden", "md:block", "min-w-0");
    const benefits = screen.getByTestId("header-benefits");
    expect(benefits.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(benefits).toHaveClass("min-w-0");
    expect(benefits.querySelector(String.raw`.md\:overflow-x-auto`)).not.toBeNull();
  });

  test("no arbitrary values, inline styles or unprefixed fixed widths in the header markup", () => {
    const html = renderToStaticMarkup(<SiteHeader {...props()} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const classes = [...doc.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(html).not.toMatch(/\sstyle="/);
    const header = doc.querySelector("header")!;
    const headerClasses = [header, ...header.querySelectorAll("[class]")]
      .filter((el) => el.closest('[data-testid="category-nav-more"]') === null && el.closest('[data-testid="account-menu"]') === null)
      .flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(headerClasses.filter((c) => /^(min-)?w-(?!full$|fit$|auto$|0$|touch$|px$|max$)/.test(c))).toEqual([]);
  });
});

describe("SiteHeader v3: T148 follow-up rulings", () => {
  test("header search has no department select (no select, no form= link, no dept field)", () => {
    const html = renderToStaticMarkup(<SiteHeader {...props()} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const header = doc.querySelector("header")!;
    expect(header.querySelector("select")).toBeNull();
    expect(header.querySelector('[name="dept"]')).toBeNull();
    expect(header.querySelector("[form]")).toBeNull();
    const form = header.querySelector('form[action="/search"]');
    expect([...(form?.querySelectorAll("[name]") ?? [])].map((el) => el.getAttribute("name"))).toEqual(["q"]);
  });

  test("phone account icon link: guest 'Sign in' -> /signin, signed in 'Your account' -> /account; 44px; works without JS", () => {
    const guestHtml = renderToStaticMarkup(<SiteHeader {...props({ account: GUEST })} />);
    const guest = new DOMParser().parseFromString(guestHtml, "text/html").querySelector('[data-testid="header-mobile-account"] a');
    expect(guest?.getAttribute("href")).toBe("/signin");
    expect(guest?.textContent).toBe("Sign in");
    expect(guest?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(guest?.className).toContain("min-h-touch");
    expect(guest?.className).toContain("min-w-touch");
    render(<SiteHeader {...props({ account: SIGNED_IN })} />);
    const item = screen.getByTestId("header-mobile-account");
    expect(item).toHaveClass("md:hidden");
    expect(within(item).getByRole("link", { name: "Your account" })).toHaveAttribute("href", "/account");
  });

  test("no phone account link without an account block or without the drawer (MVP shapes)", () => {
    const { unmount } = render(<SiteHeader {...props({ account: undefined })} />);
    expect(screen.queryByTestId("header-mobile-account")).toBeNull();
    unmount();
    render(<SiteHeader {...props({ departments: undefined })} />);
    expect(screen.queryByTestId("header-mobile-account")).toBeNull();
  });

  test("categoryNavLeading renders Deals first in the Primary nav; disallowed hrefs dropped", () => {
    const { unmount } = render(<SiteHeader {...props({ categoryNavLeading: { label: "Deals", href: "/deals" } })} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const hrefs = within(nav).getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/deals", ...DEPARTMENT_NAV.map((d) => `/category/${d.slug}`)]);
    unmount();
    render(<SiteHeader {...props({ categoryNavLeading: { label: "Evil", href: "https://evil.example" } })} />);
    expect(within(screen.getByRole("navigation", { name: "Primary" })).queryByRole("link", { name: "Evil" })).toBeNull();
  });

  test("a leading link alone keeps the category row", () => {
    render(<SiteHeader {...props({ categoryNav: [], categoryNavLeading: { label: "Deals", href: "/deals" } })} />);
    expect(screen.getByTestId("header-category-row")).toBeInTheDocument();
  });
});

describe("SiteHeader v3: CategoryNav row", () => {
  test("one link per DEPARTMENT_NAV entry (8 <= 9, no More); none current without a path", () => {
    render(<SiteHeader {...props()} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(DEPARTMENT_NAV.map((d) => `/category/${d.slug}`));
    expect(links.some((a) => a.hasAttribute("aria-current"))).toBe(false);
    expect(within(nav).queryByText("More")).toBeNull();
  });

  test("currentPath /category/<slug> marks that department aria-current=page", () => {
    render(<SiteHeader {...props({ currentPath: "/category/electronics" })} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Electronics" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Books" })).not.toHaveAttribute("aria-current");
  });

  test("empty or all-invalid categoryNav -> no row", () => {
    const { unmount } = render(<SiteHeader {...props({ categoryNav: [] })} />);
    expect(screen.queryByTestId("header-category-row")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    unmount();
    render(<SiteHeader {...props({ categoryNav: [{ slug: " ", label: "Blank" }] })} />);
    expect(screen.queryByTestId("header-category-row")).toBeNull();
  });

  test("categorySlugFromPath", () => {
    expect(categorySlugFromPath("/category/electronics")).toBe("electronics");
    expect(categorySlugFromPath("/category/home%20kitchen/sub")).toBe("home kitchen");
    expect(categorySlugFromPath("/category/books?page=2")).toBe("books");
    expect(categorySlugFromPath("/category/")).toBeNull();
    expect(categorySlugFromPath("/categoryx/books")).toBeNull();
    expect(categorySlugFromPath("/category/%E0%A4%A")).toBeNull();
    expect(categorySlugFromPath(undefined)).toBeNull();
    expect(categorySlugFromPath("/brand/acme")).toBeNull();
  });
});

describe("SiteHeader v3: benefits strip (criterion 5)", () => {
  test("named list of 4 items; links to /shipping, /orders, /returns; coupon is text", () => {
    render(<SiteHeader {...props()} />);
    const list = screen.getByRole("list", { name: "Store benefits" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/shipping", "/orders", "/returns"]);
    expect(items[3]).toHaveTextContent("Use code WELCOME10 for 10% off");
    expect(items[3]!.querySelector("a")).toBeNull();
  });

  test("no benefits / only blank items -> no row", () => {
    const { unmount } = render(<SiteHeader {...props({ benefits: undefined })} />);
    expect(screen.queryByTestId("header-benefits")).toBeNull();
    unmount();
    render(<SiteHeader {...props({ benefits: { label: "Store benefits", items: [{ label: "  " }] } })} />);
    expect(screen.queryByTestId("header-benefits")).toBeNull();
  });

  test("hostile benefit text renders as text; disallowed hrefs are dropped", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <SiteHeader {...props({ benefits: { label: "Store benefits", items: [{ label: hostile, href: "javascript:alert(1)" }, { label: "Ok", href: "/orders" }] } })} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByTestId("header-benefits")).toHaveTextContent(hostile);
    expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  });
});

describe("SiteHeader v3: no JS, hrefs, no theme toggle", () => {
  test("static HTML: skip link first, Sign in link, drawer fallback link to /products, search form, no scripts", () => {
    const html = renderToStaticMarkup(<SiteHeader {...props({ account: GUEST })} />);
    expect(html.match(/<a [^>]*>/)?.[0]).toContain('href="#main"');
    expect(html).toMatch(/<a [^>]*href="\/signin"/);
    expect(html).toMatch(/<a [^>]*href="\/products"/);
    expect(html).toMatch(/<form[^>]*action="\/search"/);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  test("signed-in static HTML keeps the sign-out form (React replay script aside)", () => {
    const html = renderToStaticMarkup(<SiteHeader {...props({ account: SIGNED_IN })} />).replace(REACT_FORM_REPLAY, "");
    expect(html).toMatch(/<form[^>]*>[\s\S]*Sign out/);
    expect(html).toMatch(/<a [^>]*href="\/account"/);
  });

  test.each<[string, HeaderAccount]>([
    ["guest", GUEST],
    ["signed in", SIGNED_IN],
  ])("every href is an allowed internal route or #main (%s)", (_l, account) => {
    const { container } = render(<SiteHeader {...props({ account })} />);
    for (const a of container.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      if (href === "#main") continue;
      expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
    }
  });

  test("no theme toggle anywhere (criterion 6, contract G-20)", () => {
    const { container } = render(<SiteHeader {...props({ account: SIGNED_IN })} />);
    for (const el of container.querySelectorAll("a, button, summary, input, select, [role]")) {
      const name = `${el.getAttribute("aria-label") ?? ""} ${el.textContent ?? ""}`;
      expect(name).not.toMatch(/theme|dark mode|light mode/i);
    }
    // Assembled at runtime so this source never contains the light-only guard's strings (G02).
    const themeMarkers = new RegExp([["data", "-theme"], ["dark", ":"]].map((p) => p.join("")).join("|"));
    expect(container.innerHTML).not.toMatch(themeMarkers);
  });

  test("ids are unique", () => {
    const doc = new DOMParser().parseFromString(renderToStaticMarkup(<SiteHeader {...props()} />), "text/html");
    const ids = [...doc.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
