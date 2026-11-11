import { describe, expect, mock, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import { IDEMPOTENCY_KEY, PRODUCT_A, SECRET_EMAIL, makeOrderView, uuidsIn } from "../OrderDetail/order-view.fixtures";
import { OrdersList, type OrdersListProps } from ".";
import type { BuyAgainProduct } from "./orders-list-model";

const noop = mock(async (formData: FormData) => {
  void formData;
});

function props(overrides: Partial<OrdersListProps> = {}): OrdersListProps {
  return {
    orders: [makeOrderView()],
    tab: "orders",
    range: "3m",
    query: "",
    page: 1,
    pageCount: 1,
    buyAgainProducts: [],
    actions: { buyAgain: noop, addToCart: noop },
    ...overrides,
  };
}

const product = (overrides: Partial<BuyAgainProduct> = {}): BuyAgainProduct => ({
  productId: PRODUCT_A,
  slug: "trail-mug",
  name: "Trail Mug",
  imageUrl: null,
  priceCents: 1500,
  currency: "USD",
  inStock: true,
  ...overrides,
});

function hrefs(root: HTMLElement): string[] {
  return [...root.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

describe("OrdersList tabs (criterion 1)", () => {
  test("tabs are links in an 'Order views' nav; selected has aria-current=page", () => {
    render(<OrdersList {...props({ tab: "cancelled", range: "1y" })} />);
    const nav = screen.getByRole("navigation", { name: "Order views" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Orders", "Buy Again", "Not Yet Shipped", "Cancelled"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/orders?range=1y",
      "/orders?tab=buy-again&range=1y",
      "/orders?tab=not-shipped&range=1y",
      "/orders?tab=cancelled&range=1y",
    ]);
    expect(within(nav).getByRole("link", { name: "Cancelled" })).toHaveAttribute("aria-current", "page");
    expect(nav.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  test("garbage tab falls back to Orders", () => {
    render(<OrdersList {...props({ tab: "<script>" })} />);
    expect(screen.getByRole("link", { name: "Orders" })).toHaveAttribute("aria-current", "page");
  });
});

describe("OrdersList filter GET form (criteria 1, 4)", () => {
  test("static markup has the GET form with range select, q input (maxLength 100), hidden tab and submit", () => {
    const html = renderToStaticMarkup(<OrdersList {...props({ tab: "not-shipped", range: "6m", query: "mug" })} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector('form[method="get"]');
    expect(form).not.toBeNull();
    expect(form?.getAttribute("action")).toBe("/orders");
    const select = form?.querySelector('select[name="range"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect([...(select?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"))).toEqual([
      "30d",
      "3m",
      "6m",
      "1y",
      "all",
    ]);
    expect(select?.querySelector("option[selected]")?.getAttribute("value")).toBe("6m");
    const q = form?.querySelector('input[name="q"]');
    expect(q?.getAttribute("maxlength")).toBe("100");
    expect(q?.getAttribute("value")).toBe("mug");
    expect(form?.querySelector('input[type="hidden"][name="tab"]')?.getAttribute("value")).toBe("not-shipped");
    expect(form?.querySelector('button[type="submit"]')?.textContent).toContain("Search orders");
  });

  test("invalid range falls back to 3m in the select and links", () => {
    render(<OrdersList {...props({ range: "10y" })} />);
    expect((screen.getByLabelText(/Orders placed in/) as HTMLSelectElement).value).toBe("3m");
    expect(screen.getByRole("link", { name: "Buy Again" })).toHaveAttribute("href", "/orders?tab=buy-again");
  });

  test("labels are associated; overlong query is cut to 100 for display", () => {
    render(<OrdersList {...props({ query: "x".repeat(300) })} />);
    expect((screen.getByLabelText(/Search all orders/) as HTMLInputElement).value).toHaveLength(100);
  });

  test("basePath with query/fragment is stripped; hostile basePath falls back", () => {
    const { container, unmount } = render(<OrdersList {...props({ basePath: "/orders?x=1#y" })} />);
    expect(container.querySelector('form[method="get"]')?.getAttribute("action")).toBe("/orders");
    unmount();
    const r = render(<OrdersList {...props({ basePath: "javascript:alert(1)" })} />);
    expect(r.container.querySelector('form[method="get"]')?.getAttribute("action")).toBe("/orders");
    for (const href of hrefs(r.container)) expect(isAllowedInternalHref(href)).toBe(true);
  });
});

describe("OrdersList orders", () => {
  test("renders an OrderCard per order in a list, with Buy it again posting orderId", () => {
    const second = makeOrderView({ id: "2d1e2f3a-4b5c-4d6e-8f90-a1b2c3d4e5f6" });
    const { container } = render(<OrdersList {...props({ orders: [makeOrderView(), second] })} />);
    const list = screen.getAllByRole("article")[0]?.closest("ul");
    expect(list?.querySelectorAll(":scope > li")).toHaveLength(2);
    expect(screen.getAllByRole("article")).toHaveLength(2);
    const forms = container.querySelectorAll("form:not([method=get])");
    expect(forms).toHaveLength(2);
    expect(forms[0]?.querySelector('input[name="orderId"]')?.getAttribute("value")).toBe(makeOrderView().id);
  });

  test("pagination hrefs preserve tab, range and q", () => {
    render(<OrdersList {...props({ tab: "cancelled", range: "1y", query: "trail mug", page: 2, pageCount: 3 })} />);
    const nav = screen.getByRole("navigation", { name: "Order pages" });
    const all = hrefs(nav);
    expect(all).toContain("/orders?tab=cancelled&range=1y&q=trail+mug&page=3");
    expect(all).toContain("/orders?tab=cancelled&range=1y&q=trail+mug");
  });

  test("heading levels: h1 + h2 cards by default, h2 + h3 when nested", () => {
    const { unmount } = render(<OrdersList {...props()} />);
    expect(screen.getByRole("heading", { level: 1, name: "Your orders" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /Order #/ })).toBeInTheDocument();
    unmount();
    render(<OrdersList {...props({ headingLevel: 2 })} />);
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: /Order #/ })).toBeInTheDocument();
  });

  test("hostile ship-to and product names render as text; no owner data leaks", () => {
    const hostile = makeOrderView({
      address: { ...makeOrderView().address, fullName: '<img src=x onerror="alert(1)">' },
    });
    const html = renderToStaticMarkup(<OrdersList {...props({ orders: [hostile] })} />);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
    expect(html).not.toContain(SECRET_EMAIL);
    expect(html).not.toContain(IDEMPOTENCY_KEY);
    const allowed = new Set([hostile.id, ...hostile.items.map((i) => i.productId)]);
    for (const uuid of uuidsIn(html)) expect(allowed.has(uuid)).toBe(true);
  });

  test("no nested forms", () => {
    const html = renderToStaticMarkup(<OrdersList {...props({ orders: [makeOrderView()], pageCount: 2 })} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
  });
});

describe("OrdersList empty states (criterion 2)", () => {
  const cases = [
    ["orders", "No orders yet", "/products"],
    ["not-shipped", "No orders waiting to ship", "/orders"],
    ["cancelled", "No cancelled orders", "/help/ordering"],
    ["buy-again", "Nothing to buy again yet", "/products"],
  ] as const;
  for (const [tab, title, href] of cases) {
    test(`${tab}: message and next-step link`, () => {
      const { container } = render(<OrdersList {...props({ tab, orders: [] })} />);
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
      const main = [...container.querySelectorAll("a")].filter((a) => !a.closest("nav"));
      expect(main.map((a) => a.getAttribute("href"))).toContain(href);
    });
  }
  test("filtered empty list offers clearing the search", () => {
    render(<OrdersList {...props({ orders: [], query: "nothing" })} />);
    expect(screen.getByRole("link", { name: "Clear search and filters" })).toHaveAttribute("href", "/orders");
  });
});

describe("OrdersList Buy Again tab (criterion 3)", () => {
  test("each product once, with an add-to-cart form posting the cart contract fields", () => {
    const html = renderToStaticMarkup(
      <OrdersList
        {...props({
          tab: "buy-again",
          buyAgainProducts: [product(), product({ name: "Duplicate" }), product({ productId: "p2", slug: "socks", name: "Socks" })],
        })}
      />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector('form[method="get"]')).toBeNull();
    const items = doc.querySelectorAll('ul[aria-label="Products to buy again"] > li');
    expect(items).toHaveLength(2);
    expect(html).not.toContain("Duplicate");
    const form = items[0]?.querySelector("form");
    expect(form?.querySelector('input[name="productId"]')?.getAttribute("value")).toBe(PRODUCT_A);
    expect(form?.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
    expect(form?.querySelector('button[type="submit"]')?.textContent).toContain("Add to cart");
    expect(items[0]?.querySelector("a")?.getAttribute("href")).toBe("/products/trail-mug");
    expect(items[0]?.textContent).toContain("$15.00");
  });

  test("out-of-stock items show text instead of the form", () => {
    render(<OrdersList {...props({ tab: "buy-again", buyAgainProducts: [product({ inStock: false })] })} />);
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add to cart/ })).toBeNull();
  });

  test("hostile names as text; bad price/slug omitted", () => {
    const html = renderToStaticMarkup(
      <OrdersList
        {...props({
          tab: "buy-again",
          buyAgainProducts: [product({ name: "<script>x</script>", slug: "../..", priceCents: Number.NaN })],
        })}
      />,
    );
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;script&gt;x");
    expect(html).not.toContain("NaN");
  });

  test("button names include the product for screen readers", () => {
    render(<OrdersList {...props({ tab: "buy-again", buyAgainProducts: [product()] })} />);
    expect(screen.getByRole("button", { name: /^Add to cart\s*: Trail Mug$/ })).toBeInTheDocument();
  });
});

describe("OrdersList: Phase 3 look (T162)", () => {
  test("Buy Again tiles are Cards with a superscript price that still reads $15.00", () => {
    render(<OrdersList {...props({ tab: "buy-again", buyAgainProducts: [product()] })} />);
    const grid = screen.getByRole("list", { name: "Products to buy again" });
    const item = grid.querySelector(":scope > li");
    expect(item).toHaveClass("bg-surface-raised", "rounded-lg", "hover:shadow-md");
    expect(item?.querySelector('[data-slot="price-superscript"]')).not.toBeNull();
    expect(within(item as HTMLElement).getByText("$15.00")).toHaveClass("sr-only");
  });

  test("empty state is a sunken Card with the same copy and links", () => {
    const { container } = render(<OrdersList {...props({ orders: [] })} />);
    const empty = container.querySelector('[data-slot="orders-empty"]');
    expect(empty).toHaveClass("bg-surface-sunken", "rounded-lg");
    expect(empty?.querySelector("h2")).not.toBeNull();
  });
});
