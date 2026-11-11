import { describe, expect, test } from "bun:test";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import type { ListItemView } from "@/server/lists/list-service";
import { LIST_SORTS } from "@/server/lists/list-service";
import {
  LIST_SORT_OPTIONS,
  UNKNOWN_ITEM_NAME,
  addableCount,
  describeAddAllResults,
  itemNames,
  listCurrency,
  listHref,
  listTotalText,
  normaliseListSort,
  productHref,
  safeListBase,
  sortHref,
} from "./list-view-model";

const product = (id: string, name: string, currency = "USD"): Product => ({
  id,
  slug: `${id}-slug`,
  name,
  description: "",
  priceCents: 1000,
  currency,
  imageUrl: "/images/x.svg",
  stock: 3,
});

function item(productId: string, overrides: Partial<ListItemView> = {}): ListItemView {
  return {
    listId: "L1",
    productId,
    quantityDesired: 1,
    priority: 1,
    priceAtAddCents: 1000,
    note: null,
    addedAt: "2026-11-01T10:00:00.000Z",
    product: product(productId, `Name ${productId}`),
    priceDroppedByCents: null,
    purchasedSinceAdded: false,
    available: true,
    ...overrides,
  };
}

describe("sort options", () => {
  test("cover exactly the service sorts, default first", () => {
    expect(LIST_SORT_OPTIONS.map((o) => o.value).sort()).toEqual([...LIST_SORTS].sort());
    expect(LIST_SORT_OPTIONS[0]?.value).toBe("added_desc");
  });

  test("normaliseListSort ignores unknown values", () => {
    expect(normaliseListSort("price_asc")).toBe("price_asc");
    expect(normaliseListSort("bogus")).toBe("added_desc");
    expect(normaliseListSort(undefined)).toBe("added_desc");
    expect(normaliseListSort(["price_asc"])).toBe("added_desc");
  });

  test("sortHref omits the default and encodes the value", () => {
    expect(sortHref("/lists/abc", "added_desc")).toBe("/lists/abc");
    expect(sortHref("/lists/abc", "price_desc")).toBe("/lists/abc?sort=price_desc");
    expect(isAllowedInternalHref(sortHref("/lists/shared/tok", "priority"))).toBe(true);
  });
});

describe("hrefs", () => {
  test("safeListBase keeps allowed paths and drops query/hash", () => {
    expect(safeListBase("/lists/abc?sort=x#y", null)).toBe("/lists/abc");
    expect(safeListBase("https://evil.example/lists", "/lists")).toBe("/lists");
    expect(safeListBase("//evil.example", null)).toBeNull();
    expect(safeListBase("/lists/a/b/c", "/lists")).toBe("/lists");
  });

  test("listHref encodes hostile ids or rejects them", () => {
    expect(listHref("abc-123")).toBe("/lists/abc-123");
    expect(listHref("")).toBeNull();
    const hostile = listHref("../../admin");
    if (hostile !== null) expect(isAllowedInternalHref(hostile)).toBe(true);
    expect(listHref("a/b")).not.toBe("/lists/a/b");
  });

  test("productHref", () => {
    expect(productHref("oak-desk")).toBe("/products/oak-desk");
    expect(productHref(" ")).toBeNull();
  });
});

describe("counts and totals", () => {
  test("addableCount counts in-stock items with a product", () => {
    expect(
      addableCount([item("a"), item("b", { available: false }), item("c", { product: null, available: false })]),
    ).toBe(1);
    expect(addableCount([])).toBe(0);
  });

  test("listTotalText", () => {
    expect(listTotalText(3, 4500, "USD")).toBe("3 items · $45.00");
    expect(listTotalText(1, 0, "USD")).toBe("1 item · $0.00");
    expect(listTotalText(2, -5, "USD")).toBe("2 items");
    expect(listTotalText(Number.NaN, 100, "USD")).toBe("0 items · $1.00");
    expect(listTotalText(2, 100, "NOT-A-CURRENCY")).toBe("2 items");
  });

  test("listCurrency uses the first existing product", () => {
    expect(listCurrency([item("a", { product: null }), { ...item("b"), product: product("b", "B", "EUR") }])).toBe(
      "EUR",
    );
    expect(listCurrency([])).toBe("USD");
  });
});

describe("describeAddAllResults", () => {
  const names = itemNames([item("a"), item("b"), item("c"), item("d"), item("gone", { product: null })]);

  test("groups per result in list order", () => {
    expect(
      describeAddAllResults(
        [
          { productId: "a", result: "added" },
          { productId: "c", result: "out_of_stock" },
          { productId: "b", result: "added" },
          { productId: "d", result: "capped" },
          { productId: "gone", result: "unavailable" },
        ],
        names,
      ),
    ).toBe(
      `Added: Name a, Name b. Limited by stock or the cart limit: Name d. Out of stock: Name c. Unavailable: ${UNKNOWN_ITEM_NAME}.`,
    );
  });

  test("empty / missing perItem gives empty text", () => {
    expect(describeAddAllResults(undefined, names)).toBe("");
    expect(describeAddAllResults([], names)).toBe("");
  });
});
