import { describe, expect, test } from "bun:test";

import { invoiceHeading, invoiceTitle, orderBreadcrumb, orderHref, orderTitle, ordersBreadcrumb } from "./page-parts";
import { isOrderIdShape, parseOrderDetailParams, parseOrdersListParams, shortOrderNumber } from "./params";

const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SHORT = ID.slice(0, 8).toUpperCase();

describe("parseOrdersListParams (page-parser rule: garbage -> defaults)", () => {
  const cases: [string, Record<string, string | string[] | undefined>, ReturnType<typeof parseOrdersListParams>][] = [
    ["empty", {}, { tab: "orders", range: "3m", query: "", page: 1 }],
    ["all valid", { tab: "cancelled", range: "1y", q: " tote ", page: "3" }, { tab: "cancelled", range: "1y", query: "tote", page: 3 }],
    ["buy again", { tab: "buy-again" }, { tab: "buy-again", range: "3m", query: "", page: 1 }],
    ["not shipped", { tab: "not-shipped", range: "all" }, { tab: "not-shipped", range: "all", query: "", page: 1 }],
    ["service tab names are not UI tabs", { tab: "not_shipped", range: "3M" }, { tab: "orders", range: "3m", query: "", page: 1 }],
    ["garbage", { tab: "<script>", range: "999d", q: "\u0000\u0007", page: "-1" }, { tab: "orders", range: "3m", query: "", page: 1 }],
    ["page zero / float / huge", { page: "0" }, { tab: "orders", range: "3m", query: "", page: 1 }],
    ["page float", { page: "2.5" }, { tab: "orders", range: "3m", query: "", page: 1 }],
    ["page huge", { page: "99999999999999" }, { tab: "orders", range: "3m", query: "", page: 1 }],
    ["repeated params: first wins", { tab: ["cancelled", "orders"], range: ["6m", "x"] }, { tab: "cancelled", range: "6m", query: "", page: 1 }],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(parseOrdersListParams(input)).toEqual(expected);
    });
  }

  test("query is capped at 100 characters and whitespace collapsed", () => {
    expect(parseOrdersListParams({ q: "a".repeat(500) }).query).toHaveLength(100);
    expect(parseOrdersListParams({ q: "a \n\t b" }).query).toBe("a b");
  });

  test("null/undefined input", () => {
    expect(parseOrdersListParams(undefined)).toEqual({ tab: "orders", range: "3m", query: "", page: 1 });
    expect(parseOrdersListParams(null)).toEqual({ tab: "orders", range: "3m", query: "", page: 1 });
  });
});

describe("parseOrderDetailParams", () => {
  test("only an exact single placed=1 selects the confirmation variant", () => {
    expect(parseOrderDetailParams({ placed: "1" }).variant).toBe("confirmation");
    for (const placed of [undefined, "0", "true", "yes", " 1", "11", ["1"], ["1", "1"]]) {
      expect(parseOrderDetailParams({ placed }).variant).toBe("detail");
    }
    expect(parseOrderDetailParams(undefined).variant).toBe("detail");
  });

  test("notice: known checkout tokens only", () => {
    expect(parseOrderDetailParams({ notice: "address_full" }).notice).toBe("address_full");
    expect(parseOrderDetailParams({ notice: "address_not_saved" }).notice).toBe("address_not_saved");
    for (const notice of [undefined, "", "<b>hi</b>", "ADDRESS_FULL", ["address_full"]]) {
      expect(parseOrderDetailParams({ notice }).notice).toBeNull();
    }
  });
});

describe("order id shape + titles", () => {
  test("isOrderIdShape: canonical lower-case UUID v4 only", () => {
    expect(isOrderIdShape(ID)).toBe(true);
    for (const bad of [ID.toUpperCase(), `${ID} `, "not-a-uuid", "", "' OR 1=1 --", 42, null, undefined, "a".repeat(10_000)]) {
      expect(isOrderIdShape(bad)).toBe(false);
    }
  });

  test("short number, titles, heading", () => {
    expect(shortOrderNumber(ID)).toBe(SHORT);
    expect(shortOrderNumber("<script>")).toBeNull();
    expect(orderTitle(ID)).toBe(`Order #${SHORT}`);
    expect(orderTitle("<script>alert(1)</script>")).toBe("Order");
    expect(invoiceTitle(ID)).toBe(`Invoice · Order #${SHORT}`);
    expect(invoiceTitle("nope")).toBe("Invoice · Order");
    expect(invoiceHeading(ID)).toBe(`Invoice for order #${SHORT}`);
    expect(invoiceHeading("nope")).toBe("Invoice");
  });

  test("hrefs and breadcrumbs", () => {
    expect(orderHref(ID)).toBe(`/orders/${ID}`);
    expect(orderHref("../etc")).toBeNull();
    expect(ordersBreadcrumb()).toEqual([{ label: "Home", href: "/" }, { label: "Your Orders" }]);
    expect(orderBreadcrumb(ID)).toEqual([
      { label: "Home", href: "/" },
      { label: "Your Orders", href: "/orders" },
      { label: `Order #${SHORT}` },
    ]);
  });
});
