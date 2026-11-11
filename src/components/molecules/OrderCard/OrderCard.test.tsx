import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import type { FulfillmentStatus } from "@/lib/types";
import {
  MAX_THUMBNAILS,
  ORDER_STATUS_PRESENTATION,
  OrderCard,
  defaultOrderHrefs,
  formatPlacedDate,
  getStatusPresentation,
  orderActionSuffix,
  orderShortRef,
  productHref,
  safeOrderHref,
  type OrderCardData,
  type OrderCardItem,
} from ".";

function item(n: number, overrides: Partial<OrderCardItem> = {}): OrderCardItem {
  return {
    productId: `p${n}`,
    productSlug: `product-${n}`,
    name: `Product ${n}`,
    imageUrl: `/images/products/product-${n}.svg`,
    quantity: 1,
    ...overrides,
  };
}

const base: OrderCardData = {
  id: "ord_123abc",
  createdAt: "2026-11-03T10:42:00.000Z",
  totalCents: 4598,
  currency: "USD",
  shipToName: "Jane Doe",
  fulfillmentStatus: "shipped",
  items: [item(1), item(2)],
};

/** Hidden per-order context appended to every action name for `base` (consistency bb). */
const CTX = " for order ord_123abc";

function hrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
}

describe("helpers", () => {
  test("formatPlacedDate: en-US UTC, invalid -> null", () => {
    expect(formatPlacedDate("2026-11-03T10:42:00.000Z")).toBe("November 3, 2026");
    expect(formatPlacedDate("2026-11-03T23:30:00-05:00")).toBe("November 4, 2026");
    expect(formatPlacedDate("nope")).toBeNull();
    expect(formatPlacedDate("")).toBeNull();
    expect(formatPlacedDate(undefined)).toBeNull();
  });

  test("getStatusPresentation covers every status; unknown falls back to processing", () => {
    const all: FulfillmentStatus[] = ["processing", "packed", "shipped", "out_for_delivery", "delivered", "cancelled"];
    for (const s of all) expect(getStatusPresentation(s)).toBe(ORDER_STATUS_PRESENTATION[s]);
    expect(getStatusPresentation("bogus").label).toBe("Processing");
    expect(getStatusPresentation(undefined).label).toBe("Processing");
    expect(getStatusPresentation("toString").label).toBe("Processing");
  });

  test("productHref encodes and rejects slugs that would leave the route set", () => {
    expect(productHref("desk-lamp")).toBe("/products/desk-lamp");
    expect(productHref("desk-lamp", "#write-review")).toBe("/products/desk-lamp#write-review");
    expect(productHref("a b")).toBe("/products/a%20b");
    expect(productHref("..")).toBeNull();
    expect(productHref("../admin")).toBeNull();
    expect(productHref("it's")).toBeNull();
    expect(productHref("")).toBeNull();
    expect(productHref(null)).toBeNull();
  });

  test("defaultOrderHrefs are planned routes, even for hostile ids", () => {
    expect(defaultOrderHrefs("ord_1")).toEqual({
      order: "/orders/ord_1",
      help: "/contact?topic=ordering&order=ord_1",
    });
    const hostile = defaultOrderHrefs("ord 1<x>&y=2");
    expect(hostile.order).toBe("/orders/ord%201%3Cx%3E%26y%3D2");
    expect(hostile.help).toBe("/contact?topic=ordering&order=ord%201%3Cx%3E%26y%3D2");
    expect(isAllowedInternalHref(hostile.order)).toBe(true);
    expect(isAllowedInternalHref(hostile.help)).toBe(true);
  });
});

describe("OrderCard", () => {
  test("header: placed date, total, ship-to, order number in mono, heading names the article", () => {
    render(<OrderCard order={base} />);
    const article = screen.getByRole("article", { name: "Order # ord_123abc" });
    expect(article).toHaveTextContent("Order placedNovember 3, 2026");
    expect(article).toHaveTextContent("Total$45.98");
    expect(article).toHaveTextContent("Ship toJane Doe");
    const heading = screen.getByRole("heading", { level: 2, name: "Order # ord_123abc" });
    expect(within(heading).getByText("ord_123abc")).toHaveClass("font-mono");
  });

  test("headingLevel 3", () => {
    render(<OrderCard order={base} headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3 })).toBeInTheDocument();
  });

  test("criterion 4: every status is text plus an icon", () => {
    const icons: Record<FulfillmentStatus, string> = {
      processing: "clock",
      packed: "clock",
      shipped: "truck",
      out_for_delivery: "truck",
      delivered: "check-circle",
      cancelled: "error-circle",
    };
    for (const [status, icon] of Object.entries(icons) as [FulfillmentStatus, string][]) {
      const { container, unmount } = render(<OrderCard order={{ ...base, fulfillmentStatus: status }} />);
      const label = ORDER_STATUS_PRESENTATION[status].label;
      const badge = screen.getByText(label);
      expect(badge).toBeVisible();
      expect(ORDER_STATUS_PRESENTATION[status].icon).toBe(icon as never);
      const svg = badge.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg?.closest("[aria-hidden='true']")).not.toBeNull();
      expect(container).toHaveTextContent(label);
      unmount();
    }
  });

  test("criterion 3: thumbnails have alt = item name; > 4 collapses to +N more", () => {
    const items = Array.from({ length: 7 }, (_, i) => item(i + 1));
    render(<OrderCard order={{ ...base, items }} />);
    const imgs = screen.getAllByRole("img");
    expect(imgs).toHaveLength(MAX_THUMBNAILS);
    expect(imgs.map((i) => i.getAttribute("alt") ?? i.getAttribute("aria-label"))).toEqual([
      "Product 1",
      "Product 2",
      "Product 3",
      "Product 4",
    ]);
    expect(screen.getByText("+3 more")).toBeInTheDocument();
    expect(screen.getByText("+3 more").textContent).toBe("+3 more items");
  });

  test("exactly 4 items shows no +N more; missing image uses the named placeholder", () => {
    const items = [item(1, { imageUrl: null }), item(2), item(3), item(4)];
    render(<OrderCard order={{ ...base, items }} />);
    expect(screen.queryByText(/more/)).toBeNull();
    expect(screen.getByRole("img", { name: "Product 1" })).toHaveAttribute("data-placeholder");
  });

  test("criterion 5: default links route to planned paths", () => {
    const { container } = render(<OrderCard order={base} />);
    expect(screen.getByRole("link", { name: `View order details${CTX}` })).toHaveAttribute("href", "/orders/ord_123abc");
    expect(screen.getByRole("link", { name: `Buy it again${CTX}` })).toHaveAttribute("href", "/products/product-1");
    expect(screen.getByRole("link", { name: `Write a review${CTX}` })).toHaveAttribute(
      "href",
      "/products/product-1#write-review",
    );
    expect(screen.getByRole("link", { name: `Get help${CTX}` })).toHaveAttribute(
      "href",
      "/contact?topic=ordering&order=ord_123abc",
    );
    const all = hrefs(container);
    expect(all.length).toBe(4);
    for (const href of all) expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("hrefs override defaults", () => {
    render(<OrderCard order={base} hrefs={{ order: "/orders/x", help: "/help/ordering" }} />);
    expect(screen.getByRole("link", { name: `View order details${CTX}` })).toHaveAttribute("href", "/orders/x");
    expect(screen.getByRole("link", { name: `Get help${CTX}` })).toHaveAttribute("href", "/help/ordering");
  });

  test("review and buy-again links use the first item that has a usable slug", () => {
    const items = [item(1, { productSlug: null }), item(2, { productSlug: "../bad" }), item(3)];
    render(<OrderCard order={{ ...base, items }} />);
    expect(screen.getByRole("link", { name: `Write a review${CTX}` })).toHaveAttribute(
      "href",
      "/products/product-3#write-review",
    );
    expect(screen.getByRole("link", { name: `Buy it again${CTX}` })).toHaveAttribute("href", "/products/product-3");
  });

  test("no slugged items: no review or buy-again link", () => {
    render(<OrderCard order={{ ...base, items: [item(1, { productSlug: null })] }} />);
    expect(screen.queryByRole("link", { name: /^Write a review/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /^Buy it again/ })).toBeNull();
    expect(screen.getByRole("link", { name: `Get help${CTX}` })).toBeInTheDocument();
  });

  test("buyAgainAction renders a form posting a hidden orderId with a submit button", () => {
    const action = async (): Promise<{ ok: boolean }> => ({ ok: true });
    render(<OrderCard order={base} buyAgainAction={action} />);
    const button = screen.getByRole("button", { name: `Buy it again${CTX}` });
    expect(button).toHaveAttribute("type", "submit");
    const form = button.closest("form");
    expect(form).not.toBeNull();
    const hidden = form?.querySelector<HTMLInputElement>("input[type='hidden'][name='orderId']");
    expect(hidden?.value).toBe("ord_123abc");
    expect(screen.queryByRole("link", { name: /^Buy it again/ })).toBeNull();
  });

  test("0 items renders the card without thumbnails, review or buy-again (even with an action)", () => {
    const action = (): void => undefined;
    render(<OrderCard order={{ ...base, items: [] }} buyAgainAction={action} />);
    expect(screen.getByRole("article")).toBeInTheDocument();
    expect(screen.queryAllByRole("img")).toHaveLength(0);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText("Buy it again")).toBeNull();
    expect(screen.getByRole("link", { name: `View order details${CTX}` })).toBeInTheDocument();
  });

  test("hostile names render as text", () => {
    const evil = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const { container } = render(
      <OrderCard order={{ ...base, shipToName: evil, items: [item(1, { name: evil, imageUrl: null })] }} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByText(evil)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: evil })).toBeInTheDocument();
  });

  test("invalid date omits the placed cell; invalid total renders no price but the card still renders", () => {
    render(<OrderCard order={{ ...base, createdAt: "garbage", totalCents: -1 }} />);
    const article = screen.getByRole("article");
    expect(article).not.toHaveTextContent("Order placed");
    expect(article).not.toHaveTextContent("$");
  });

  test("320px-safe: thumbnails and actions wrap; no fixed widths", () => {
    const items = Array.from({ length: 4 }, (_, i) => item(i + 1));
    const { container } = render(<OrderCard order={{ ...base, items }} />);
    expect(screen.getByRole("list")).toHaveClass("flex-wrap");
    const classes = [...container.querySelectorAll("[class]")].flatMap((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/),
    );
    // Unprefixed fixed widths would overflow 320px (size-16 thumbnails wrap).
    expect(classes.filter((c) => /^(w|min-w)-/.test(c) && !/^(min-w-0|min-w-touch|w-full)$/.test(c))).toEqual([]);
  });

  test("server-safe: renderToStaticMarkup with and without an action, tokens only", () => {
    const html = renderToStaticMarkup(<OrderCard order={base} />);
    expect(html).toContain("<article");
    expect(html).toContain("Order # ");
    // next/image adds its own inline style to <img>; everything else is utility classes.
    expect(html.replace(/<img[^>]*>/g, "")).not.toMatch(/style=/);
    expect(html).not.toMatch(/\[#|-\[/);
    const withAction = renderToStaticMarkup(
      <OrderCard order={base} buyAgainAction={async () => undefined} />,
    );
    expect(withAction).toContain('name="orderId"');
    expect(withAction).toContain("Buy it again");
  });

  describe("D-T68-1: href validation", () => {
    let originalWarn: typeof console.warn;
    let warnings: unknown[][];
    beforeEach(() => {
      originalWarn = console.warn;
      warnings = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args);
      };
    });
    afterEach(() => {
      console.warn = originalWarn;
    });

    test("UUID happy path keeps the default hrefs unchanged and does not warn", () => {
      const id = "3f2b8c1e-9a4d-4e2f-b6a1-0c9d8e7f6a5b";
      const { container } = render(<OrderCard order={{ ...base, id, items: [] }} />);
      expect(hrefs(container)).toEqual([`/orders/${id}`, `/contact?topic=ordering&order=${id}`]);
      expect(warnings).toEqual([]);
    });

    test.each(["..", ".", "a/b", "", "a\\b"])("unsafe id %p never renders a disallowed href", (id) => {
      const { container } = render(<OrderCard order={{ ...base, id }} />);
      for (const href of hrefs(container)) expect(isAllowedInternalHref(href)).toBe(true);
      expect(screen.queryByRole("link", { name: /^View order details/ })).toBeNull();
      expect(warnings.length).toBeGreaterThan(0);
      expect(String(warnings[0]?.[0])).toContain("OrderCard: order href");
      // The id still renders as text in the heading.
      expect(screen.getByRole("heading").textContent).toBe(`Order # ${id}`);
    });

    test("override hrefs are validated: hostile overrides are dropped, valid ones used", () => {
      const { container, unmount } = render(
        <OrderCard order={base} hrefs={{ order: "javascript:alert(1)", help: "//evil.example/help" }} />,
      );
      expect(hrefs(container).some((h) => /javascript:|evil/.test(h))).toBe(false);
      expect(screen.queryByRole("link", { name: /^View order details/ })).toBeNull();
      expect(screen.queryByRole("link", { name: /^Get help/ })).toBeNull();
      expect(warnings).toHaveLength(2);
      unmount();
      render(<OrderCard order={base} hrefs={{ order: "/orders/custom", help: "/contact?topic=returns" }} />);
      expect(screen.getByRole("link", { name: `View order details${CTX}` })).toHaveAttribute("href", "/orders/custom");
      expect(screen.getByRole("link", { name: `Get help${CTX}` })).toHaveAttribute("href", "/contact?topic=returns");
    });

    test("safeOrderHref: null for invalid/undefined (warns), passthrough for valid; silent in production", () => {
      expect(safeOrderHref("/orders/abc", "order")).toBe("/orders/abc");
      expect(safeOrderHref(undefined, "help")).toBeNull();
      expect(safeOrderHref("/orders/..", "order")).toBeNull();
      expect(warnings).toHaveLength(2);
      const env = process.env as Record<string, string | undefined>;
      const saved = env.NODE_ENV;
      env.NODE_ENV = "production";
      try {
        expect(safeOrderHref("https://evil.example", "order")).toBeNull();
      } finally {
        env.NODE_ENV = saved;
      }
      expect(warnings).toHaveLength(2);
    });
  });
});

describe("consistency bb: per-order context in action names", () => {
  const ID_A = "3f2b8c1e-9a4d-4e2f-b6a1-0c9d8e7f6a5b";
  const ID_B = "7d1c0a9b-2e3f-4a5b-8c6d-1e2f3a4b5c6d";

  test("orderShortRef: first 8 chars upper-cased for a UUID, trimmed id otherwise, null when blank", () => {
    expect(orderShortRef(ID_A)).toBe("3F2B8C1E");
    expect(orderShortRef("  ord_123abc ")).toBe("ord_123abc");
    expect(orderShortRef("")).toBeNull();
    expect(orderShortRef("   ")).toBeNull();
    expect(orderShortRef(42)).toBeNull();
    expect(orderShortRef(null)).toBeNull();
  });

  test("orderActionSuffix: ' for order <ref>' or ''", () => {
    expect(orderActionSuffix(ID_A)).toBe(" for order 3F2B8C1E");
    expect(orderActionSuffix("")).toBe("");
  });

  test("two cards in a list: every action name is unique and carries the order reference", () => {
    const { container } = render(
      <ul>
        <li>
          <OrderCard order={{ ...base, id: ID_A }} buyAgainAction={async () => undefined} />
        </li>
        <li>
          <OrderCard order={{ ...base, id: ID_B }} buyAgainAction={async () => undefined} />
        </li>
      </ul>,
    );
    const names = [
      ...screen.getAllByRole("link").map((el) => el.textContent ?? ""),
      ...screen.getAllByRole("button").map((el) => el.textContent ?? ""),
    ];
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(names.length);
    for (const label of ["View order details", "Write a review", "Get help"]) {
      expect(screen.getByRole("link", { name: `${label} for order 3F2B8C1E` })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: `${label} for order 7D1C0A9B` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Buy it again for order 3F2B8C1E" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Buy it again for order 7D1C0A9B" })).toBeInTheDocument();
    expect(container.querySelectorAll("form")).toHaveLength(2);
  });

  test("visible text is unchanged: the suffix lives in a visually hidden span", () => {
    render(<OrderCard order={{ ...base, id: ID_A }} />);
    for (const label of ["View order details", "Buy it again", "Write a review", "Get help"]) {
      const link = screen.getByRole("link", { name: `${label} for order 3F2B8C1E` });
      const hidden = link.querySelector(".sr-only");
      expect(hidden?.textContent).toBe(" for order 3F2B8C1E");
      expect(link.textContent?.replace(hidden?.textContent ?? "", "")).toBe(label);
      expect(link.hasAttribute("aria-label")).toBe(false);
    }
  });

  test("hostile id in the suffix renders as text only", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const { container } = render(
      <OrderCard order={{ ...base, id: evil }} hrefs={{ order: "/orders/x", help: "/contact?topic=ordering" }} />,
    );
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect(screen.getByRole("link", { name: `View order details for order ${evil}` })).toBeInTheDocument();
  });
});
