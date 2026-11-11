import { describe, expect, test } from "bun:test";
import { isAllowedInternalHref } from "@/content/routes";
import { ORDERS_RANGES, ORDERS_TABS, type OrderView } from "@/server/orders/order-service";
import { IDEMPOTENCY_KEY, makeOrderView } from "../OrderDetail/order-view.fixtures";
import {
  DEFAULT_ORDER_RANGE,
  ORDER_RANGES,
  ORDER_TABS,
  buildOrdersHref,
  dedupeBuyAgainProducts,
  normaliseBasePath,
  ordersEmptyState,
  parseOrderPage,
  parseOrderQuery,
  parseOrderRange,
  parseOrderTab,
  toOrderCardData,
  toServiceTab,
  type BuyAgainProduct,
  type OrdersListOrder,
} from "./orders-list-model";

describe("parseOrderRange (criterion 4)", () => {
  test("accepts every listed range", () => {
    for (const range of ORDER_RANGES) expect(parseOrderRange(range)).toBe(range);
  });
  test("garbage falls back to 3m", () => {
    for (const bad of ["", "2y", "3M", " 3m", "all ", null, undefined, 42, {}, ["nope"], "<script>"]) {
      expect(parseOrderRange(bad)).toBe("3m");
    }
    expect(DEFAULT_ORDER_RANGE).toBe("3m");
  });
  test("first value of a repeated search param wins", () => {
    expect(parseOrderRange(["1y", "6m"])).toBe("1y");
  });
  test("matches the order service's range list", () => {
    expect([...ORDER_RANGES]).toEqual([...ORDERS_RANGES]);
  });
});

describe("parseOrderTab", () => {
  test("known tabs and fallback", () => {
    expect(parseOrderTab("buy-again")).toBe("buy-again");
    expect(parseOrderTab("not-shipped")).toBe("not-shipped");
    expect(parseOrderTab("cancelled")).toBe("cancelled");
    expect(parseOrderTab("not_shipped")).toBe("orders");
    expect(parseOrderTab(undefined)).toBe("orders");
    expect(parseOrderTab(["cancelled"])).toBe("cancelled");
  });
  test("service tab mapping uses only the service's tab values", () => {
    for (const tab of ORDER_TABS) {
      const mapped = toServiceTab(tab.value);
      if (tab.value === "buy-again") expect(mapped).toBeNull();
      else expect((ORDERS_TABS as readonly string[]).includes(mapped ?? "")).toBe(true);
    }
    expect(toServiceTab("orders")).toBe("all");
    expect(toServiceTab("not-shipped")).toBe("not_shipped");
  });
});

describe("parseOrderQuery / parseOrderPage", () => {
  test("query trimmed, collapsed, control chars removed, max 100", () => {
    expect(parseOrderQuery("  trail \n\t mug  ")).toBe("trail mug");
    expect(parseOrderQuery("a\u0000b")).toBe("a b");
    expect(parseOrderQuery("x".repeat(150))).toHaveLength(100);
    expect(parseOrderQuery(undefined)).toBe("");
    expect(parseOrderQuery(["mug", "x"])).toBe("mug");
  });
  test("page digits only", () => {
    expect(parseOrderPage("3")).toBe(3);
    expect(parseOrderPage(2)).toBe(2);
    for (const bad of ["0", "-1", "1.5", "abc", "1e3", "", undefined, "99999999999"]) {
      expect(parseOrderPage(bad)).toBe(1);
    }
  });
});

describe("buildOrdersHref", () => {
  test("drops defaults", () => {
    expect(buildOrdersHref("/orders")).toBe("/orders");
    expect(buildOrdersHref("/orders", { tab: "orders", range: "3m", q: "", page: 1 })).toBe("/orders");
  });
  test("keeps and encodes non-defaults in a stable order", () => {
    expect(buildOrdersHref("/orders", { page: 2, q: "trail mug & co", range: "1y", tab: "cancelled" })).toBe(
      "/orders?tab=cancelled&range=1y&q=trail+mug+%26+co&page=2",
    );
  });
  test("strips query and fragment from basePath; invalid basePath -> /orders", () => {
    expect(buildOrdersHref("/orders?tab=x#frag", { tab: "buy-again" })).toBe("/orders?tab=buy-again");
    expect(normaliseBasePath("https://evil.example/orders")).toBe("/orders");
    expect(normaliseBasePath("//evil.example")).toBe("/orders");
    expect(normaliseBasePath("/account/history")).toBe("/account/history");
    expect(normaliseBasePath(undefined)).toBe("/orders");
  });
  test("garbage params are re-parsed", () => {
    expect(buildOrdersHref("/orders", { tab: "evil", range: "10y", page: "-3" })).toBe("/orders");
  });
  test("every built href is an allowed internal href", () => {
    for (const tab of ORDER_TABS) {
      for (const range of ORDER_RANGES) {
        expect(isAllowedInternalHref(buildOrdersHref("/orders", { tab: tab.value, range, q: "<x>", page: 4 }))).toBe(true);
      }
    }
  });
});

describe("toOrderCardData", () => {
  test("OrderView fits and only card fields are copied", () => {
    const view: OrderView = makeOrderView();
    const input: OrdersListOrder = view;
    const card = toOrderCardData(input);
    expect(card.shipToName).toBe("Jane Doe");
    expect(card.items).toHaveLength(2);
    const json = JSON.stringify(card);
    expect("idempotencyKey" in view).toBe(false);
    expect(json).not.toContain(IDEMPOTENCY_KEY);
    expect(json).not.toContain(view.address.email);
  });
});

describe("dedupeBuyAgainProducts (criterion 3)", () => {
  const p = (id: string, name = `P ${id}`): BuyAgainProduct => ({
    productId: id,
    slug: `p-${id}`,
    name,
    imageUrl: null,
    priceCents: 100,
    currency: "USD",
    inStock: true,
  });
  test("each product once, first wins, invalid dropped", () => {
    const out = dedupeBuyAgainProducts([p("a", "First"), p("b"), p("a", "Second"), p(""), p("c", " ")]);
    expect(out.map((x) => x.productId)).toEqual(["a", "b"]);
    expect(out[0]?.name).toBe("First");
  });
});

describe("ordersEmptyState (criterion 2)", () => {
  const opts = { basePath: "/orders", range: "3m" as const, query: "" };
  test("next-step links per tab", () => {
    expect(ordersEmptyState("orders", opts).links.map((l) => l.href)).toEqual(["/products"]);
    expect(ordersEmptyState("buy-again", opts).links.map((l) => l.href)).toEqual(["/products"]);
    expect(ordersEmptyState("not-shipped", opts).links.map((l) => l.href)).toEqual(["/orders"]);
    expect(ordersEmptyState("cancelled", opts).links.map((l) => l.href)).toEqual(["/help/ordering"]);
  });
  test("filtered tabs offer clearing the search", () => {
    const state = ordersEmptyState("cancelled", { basePath: "/orders", range: "1y", query: "mug" });
    expect(state.links[0]).toEqual({ href: "/orders?tab=cancelled", label: "Clear search and filters" });
    expect(ordersEmptyState("orders", { ...opts, query: "mug" }).title).toBe("No orders found");
  });
});
