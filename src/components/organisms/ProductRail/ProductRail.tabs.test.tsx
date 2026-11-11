import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import type { Product } from "@/lib/types";
import { PRODUCT_RAIL_EMPTY_TAB_TEXT, ProductRail, railTabsLabel } from "./ProductRail";
import type { ProductRailTab } from "./rail-tabs";

function makeProduct(n: number, overrides: Partial<Product> = {}): Product {
  return {
    id: `p${n}`,
    slug: `product-${n}`,
    name: `Product ${n}`,
    description: "",
    priceCents: 1000 + n,
    currency: "USD",
    imageUrl: `/images/p${n}.jpg`,
    stock: 10,
    ...overrides,
  };
}

const products = [1, 2, 3].map((n) => makeProduct(n));

const TABS: ProductRailTab[] = [
  { id: "best-sellers", label: "Best sellers", href: "/?rail=best-sellers#top-picks" },
  { id: "deals", label: "Deals", href: "/?rail=deals#top-picks" },
  { id: "new-arrivals", label: "New arrivals", href: "/?rail=new-arrivals#top-picks" },
  { id: "top-rated", label: "Top rated", href: "/?rail=top-rated#top-picks" },
];

const addToCart: CartActionFn = async () => null;

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

function TopPicks(props: Partial<Parameters<typeof ProductRail>[0]>) {
  return (
    <ProductRail
      id="top-picks"
      title="Top picks"
      products={products}
      tabs={TABS}
      activeId="deals"
      quickAdd={{ action: addToCart }}
      {...props}
    />
  );
}

describe("ProductRail tabs (T153 AC2, contract H-14)", () => {
  test("a named nav of plain links in caller order with caller hrefs; current one has aria-current=page", () => {
    render(<TopPicks />);
    const nav = screen.getByRole("navigation", { name: railTabsLabel("Top picks") });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Best sellers", "Deals", "New arrivals", "Top rated"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(TABS.map((t) => t.href));
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual([null, "page", null, null]);
    expect(nav.querySelector('[role="tab"], [role="tablist"], [role="tabpanel"]')).toBeNull();
    expect(nav.querySelectorAll("ul > li")).toHaveLength(4);
  });

  test("works without JS: static markup has real anchors with the hrefs", () => {
    const html = renderToStaticMarkup(<TopPicks />);
    for (const tab of TABS) expect(html).toContain(`href="${tab.href.replace(/&/g, "&amp;")}"`);
    expect(html).toMatch(/<a[^>]*aria-current="page"[^>]*>Deals<\/a>/);
  });

  test("current tab is marked by more than colour (bottom bar) and every tab is a 44px target", () => {
    render(<TopPicks />);
    const nav = screen.getByRole("navigation");
    for (const a of within(nav).getAllByRole("link")) {
      expect(a).toHaveClass("min-h-touch");
      expect(a).toHaveClass("border-b-2");
    }
    expect(within(nav).getByRole("link", { name: "Deals" })).toHaveClass("border-accent");
    expect(within(nav).getByRole("link", { name: "Top rated" })).toHaveClass("border-transparent");
  });

  test("unknown activeId marks the first tab current", () => {
    render(<TopPicks activeId="__proto__" />);
    expect(screen.getByRole("link", { name: "Best sellers" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  test("invalid tabs are dropped with a dev warning; the rest still render", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    render(
      <TopPicks
        tabs={[
          ...TABS.slice(0, 2),
          { id: "evil", label: "Evil", href: "javascript:alert(1)" },
          { id: "ext", label: "External", href: "https://evil.example/" },
          { id: "deals", label: "Deals again", href: "/?rail=deals#top-picks" },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation");
    expect(within(nav).getAllByRole("link").map((a) => a.textContent)).toEqual(["Best sellers", "Deals"]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  test("hostile tab labels render as text", () => {
    const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { container } = render(<TopPicks tabs={[{ id: "x", label: evil, href: "/?rail=x#top-picks" }]} activeId="x" />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(screen.getByRole("navigation")).toHaveTextContent(evil);
    const html = renderToStaticMarkup(<TopPicks tabs={[{ id: "x", label: evil, href: "/?rail=x" }]} />);
    // (React's own form-action bootstrap <script> is expected; the hostile one is not.)
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
  });

  test("custom nav label", () => {
    render(<TopPicks tabsLabel="Choose a list" />);
    expect(screen.getByRole("navigation", { name: "Choose a list" })).toBeInTheDocument();
  });

  test("no tabs prop: no nav (existing rails unchanged)", () => {
    render(<ProductRail title="Rail" products={products} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("ProductRail section and anchor (T153 AC5)", () => {
  test("section root takes the id (anchor target) and is named by its heading", () => {
    render(<TopPicks />);
    const section = document.getElementById("top-picks");
    expect(section?.tagName).toBe("SECTION");
    expect(screen.getByRole("region", { name: "Top picks" })).toBe(section as HTMLElement);
    expect(section?.getAttribute("aria-labelledby")).toBe("top-picks-heading");
    // The tabs come before the cards inside the section.
    const nav = screen.getByRole("navigation");
    const scroller = screen.getByRole("region", { name: "Top picks: Deals, product list" });
    expect(nav.compareDocumentPosition(scroller) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("no Previous / Next arrows in server HTML (rendered only once JS measures the rail can scroll; ScrollRail U01)", () => {
    const html = renderToStaticMarkup(<TopPicks />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const name of ["Previous", "Next"]) {
      expect(doc.querySelector(`button[aria-label="${name}"]`)).toBeNull();
    }
    // The tab links and product links still work without JS.
    expect(doc.querySelectorAll("a").length).toBeGreaterThan(0);
  });

  test("heading level prop: card names sit one level below", () => {
    const { rerender } = render(<TopPicks />);
    expect(screen.getByRole("heading", { level: 2, name: "Top picks" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    rerender(<TopPicks headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Top picks" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(3);
  });

  test("eyebrow renders as text above the heading; blank eyebrow omitted", () => {
    const { container, rerender } = render(<TopPicks eyebrow="  Picked for you  " />);
    expect(container.querySelector("[data-eyebrow]")?.textContent).toBe("Picked for you");
    rerender(<TopPicks eyebrow="   " />);
    expect(container.querySelector("[data-eyebrow]")).toBeNull();
  });
});

describe("ProductRail cards and quick add (T153 AC4)", () => {
  test("every card is compact with a '+ Add' form posting productId and quantity=1 only", () => {
    render(<TopPicks />);
    const scroller = screen.getByRole("region", { name: "Top picks: Deals, product list" });
    const items = within(scroller).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    items.forEach((li, i) => {
      expect(li.querySelector("article")?.getAttribute("data-variant")).toBe("compact");
      const form = li.querySelector("form");
      expect(form).not.toBeNull();
      const inputs = [...(form?.querySelectorAll("input") ?? [])].map((el) => [el.name, el.value]);
      expect(inputs).toEqual([
        ["productId", `p${i + 1}`],
        ["quantity", "1"],
      ]);
      const button = within(li).getByRole("button", { name: `Add to cart: Product ${i + 1}` });
      expect(button).toHaveTextContent("Add");
      // The quick add is a sibling of the single product link, never nested in it.
      expect(li.querySelectorAll("a")).toHaveLength(1);
      expect(li.querySelector("a form, a button")).toBeNull();
    });
  });

  test("out-of-stock card shows a disabled 'Out of stock' and no form", () => {
    render(<TopPicks products={[makeProduct(1, { stock: 0 })]} />);
    const scroller = screen.getByRole("region", { name: "Top picks: Deals, product list" });
    const li = within(scroller).getAllByRole("listitem")[0] as HTMLElement;
    expect(li.querySelector("form")).toBeNull();
    expect(within(li).getByRole("button", { name: /Out of stock/ })).toBeDisabled();
  });

  test("without quickAdd the cards have no form (PDP/cart rails unchanged)", () => {
    const { container } = render(<ProductRail title="Rail" products={products} />);
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("ProductRail empty states (T153 AC3, contract H row 9)", () => {
  test("no tabs and no products: nothing at all", () => {
    expect(renderToStaticMarkup(<ProductRail title="Rail" products={[]} />)).toBe("");
  });

  test("tabs with an empty active tab: heading and tab links stay, no rail, a short status text", () => {
    render(<TopPicks products={[]} />);
    expect(screen.getByRole("heading", { level: 2, name: "Top picks" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getAllByRole("link")).toHaveLength(4);
    expect(screen.queryByRole("region", { name: /product list/ })).toBeNull();
    expect(screen.queryAllByRole("listitem")).toHaveLength(4); // the tab items only
    expect(screen.getByRole("status")).toHaveTextContent(PRODUCT_RAIL_EMPTY_TAB_TEXT);
  });

  test("tabs that are all invalid and no products: nothing at all", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const html = renderToStaticMarkup(
      <TopPicks products={[]} tabs={[{ id: "x", label: "X", href: "https://evil.example" }]} />,
    );
    expect(html).toBe("");
  });
});

describe("ProductRail 320px layout (T153, R9)", () => {
  test("tabs scroll inside their own nav; section and nav are min-w-0; list is content-width", () => {
    render(<TopPicks />);
    const section = document.getElementById("top-picks") as HTMLElement;
    expect(section).toHaveClass("min-w-0");
    const nav = screen.getByRole("navigation");
    expect(nav).toHaveClass("min-w-0");
    expect(nav).toHaveClass("overflow-x-auto");
    const ul = nav.querySelector("ul") as HTMLElement;
    expect(ul).toHaveClass("w-max");
    expect(ul).toHaveClass("min-w-full");
    for (const a of within(nav).getAllByRole("link")) expect(a).toHaveClass("whitespace-nowrap");
  });

  test("rail-tabs.ts and ProductRail.tsx: no client directive, arbitrary values, inline styles or hex", () => {
    for (const file of ["ProductRail.tsx", "rail-tabs.ts"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).not.toMatch(/^["']use client["']/m);
      expect(src).not.toMatch(/-\[[^\]]+\]/);
      expect(src).not.toMatch(/style=\{/);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});
