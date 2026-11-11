import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { StockAlertView } from "@/server/alerts/stock-alert-service";
import {
  ACCOUNT_HUB_CARDS,
  buildAccountHubCards,
  isPostableAlertId,
  normalizeCounts,
  pluralize,
  productHref,
  safeCount,
  toBackInStockItems,
  type AccountHubCounts,
} from "./account-hub-model";

const ZERO: AccountHubCounts = {
  orders: 0,
  lists: 0,
  addresses: 0,
  history: 0,
  reviews: 0,
  questions: 0,
  alerts: 0,
  messages: 0,
};

const warnSpies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  while (warnSpies.length > 0) warnSpies.pop()?.mockRestore();
});

describe("safeCount / pluralize / normalizeCounts", () => {
  test("safeCount clamps bad values to 0 and floors", () => {
    expect(safeCount(Number.NaN)).toBe(0);
    expect(safeCount(-1)).toBe(0);
    expect(safeCount(Number.POSITIVE_INFINITY)).toBe(0);
    expect(safeCount("3")).toBe(0);
    expect(safeCount(undefined)).toBe(0);
    expect(safeCount(3.99)).toBe(3);
    expect(safeCount(7)).toBe(7);
  });

  test("pluralize", () => {
    expect(pluralize(0, "order", "orders")).toBe("0 orders");
    expect(pluralize(1, "order", "orders")).toBe("1 order");
    expect(pluralize(2, "order", "orders")).toBe("2 orders");
    expect(pluralize(1000, "order", "orders")).toBe("1,000 orders");
    expect(pluralize(Number.NaN, "order", "orders")).toBe("0 orders");
  });

  test("normalizeCounts sanitises every field", () => {
    expect(normalizeCounts({ ...ZERO, orders: -5, lists: Number.NaN, messages: 2 })).toEqual({ ...ZERO, messages: 2 });
  });
});

describe("buildAccountHubCards", () => {
  test("every default href is allowed: eight cards", () => {
    expect(buildAccountHubCards(ZERO).map((c) => c.key)).toEqual(ACCOUNT_HUB_CARDS.map((d) => d.key));
  });

  test("contributions: both counts once either is non-zero", () => {
    const card = buildAccountHubCards({ ...ZERO, questions: 1 }).find((c) => c.key === "contributions");
    expect(card?.description).toBe("0 reviews, 1 question");
  });

  test("disallowed hrefs are dropped with a dev warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    warnSpies.push(warn);
    const defs = [
      ...ACCOUNT_HUB_CARDS.slice(0, 1),
      { ...ACCOUNT_HUB_CARDS[1]!, href: "https://evil.example/lists" },
      { ...ACCOUNT_HUB_CARDS[2]!, href: "//evil.example" },
      { ...ACCOUNT_HUB_CARDS[3]!, href: "/not-a-route" },
    ];
    const cards = buildAccountHubCards(ZERO, defs);
    expect(cards.map((c) => c.key)).toEqual(["orders"]);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]?.[0])).toContain("AccountHub");
  });
});

describe("productHref / isPostableAlertId", () => {
  test("productHref accepts slugs only", () => {
    expect(productHref("blue-mug")).toBe("/products/blue-mug");
    expect(productHref("Blue Mug")).toBeNull();
    expect(productHref("../x")).toBeNull();
    expect(productHref("a/b")).toBeNull();
    expect(productHref("")).toBeNull();
    expect(productHref("a".repeat(101))).toBeNull();
  });

  test("isPostableAlertId", () => {
    expect(isPostableAlertId("1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b")).toBe(true);
    expect(isPostableAlertId("")).toBe(false);
    expect(isPostableAlertId('"><x')).toBe(false);
  });
});

describe("toBackInStockItems", () => {
  test("maps views and drops alerts with no product", () => {
    const base = { productId: "p1", createdAt: "2026-01-01T00:00:00.000Z", acknowledgedAt: null, status: "back_in_stock" as const };
    const product = { id: "p1", slug: "blue-mug", name: "Blue Mug", imageUrl: "/x.png", priceCents: 100, currency: "USD", stock: 3 };
    const views = [
      { ...base, id: "a1", product },
      { ...base, id: "a2", product: null },
    ] as unknown as StockAlertView[];
    expect(toBackInStockItems(views)).toEqual([{ alertId: "a1", productSlug: "blue-mug", productName: "Blue Mug" }]);
  });

  test("D-T98-4: an unavailable product maps to slug \"\" + available false; available true keeps the plain shape", () => {
    const base = { productId: "p1", createdAt: "2026-01-01T00:00:00.000Z", acknowledgedAt: null, status: "back_in_stock" as const };
    const product = { id: "p1", slug: "blue-mug", name: "Blue Mug", imageUrl: "/x.png", priceCents: 100, currency: "USD", stock: 3 };
    const views: StockAlertView[] = [
      { ...base, id: "a1", product, available: false },
      { ...base, id: "a2", product, available: true },
    ];
    const items = toBackInStockItems(views);
    expect(items).toEqual([
      { alertId: "a1", productSlug: "", productName: "Blue Mug", available: false },
      { alertId: "a2", productSlug: "blue-mug", productName: "Blue Mug" },
    ]);
    expect(Object.keys(items[1] ?? {}).sort()).toEqual(["alertId", "productName", "productSlug"]);
  });
});
