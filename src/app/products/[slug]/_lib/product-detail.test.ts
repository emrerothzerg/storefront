import { describe, expect, mock, test } from "bun:test";
import type { Product } from "@/lib/types";
import { MAX_SLUG_LENGTH, isValidSlug, loadProduct, productTitle } from "./product-detail";

const PRODUCT: Product = {
  id: "prod_x",
  slug: "x",
  name: "Thing X",
  description: "d",
  priceCents: 100,
  currency: "USD",
  imageUrl: "/x.svg",
  stock: 1,
};

function spyRepo(result: Product | null = PRODUCT) {
  return { getBySlug: mock((): Product | null => result) };
}

describe("isValidSlug", () => {
  test.each(["a", "canvas-tote-bag", "limited-print-no-1", "a1-b2", "x".repeat(MAX_SLUG_LENGTH)])(
    "accepts %p",
    (slug) => {
      expect(isValidSlug(slug)).toBe(true);
    },
  );

  test.each([
    "",
    "Canvas",
    "-lead",
    "trail-",
    "double--dash",
    "with space",
    "under_score",
    "' OR 1=1 --",
    "../../etc/passwd",
    "%27",
    "café",
    "x".repeat(MAX_SLUG_LENGTH + 1),
  ])("rejects %p", (slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });

  test.each<[unknown]>([[undefined], [null], [1], [{}], [["a"]]])("rejects non-string %p", (value) => {
    expect(isValidSlug(value)).toBe(false);
  });
});

describe("loadProduct", () => {
  test("queries the repository for a valid slug", () => {
    const repo = spyRepo();
    expect(loadProduct("x", repo)).toBe(PRODUCT);
    expect(repo.getBySlug).toHaveBeenCalledTimes(1);
    expect(repo.getBySlug).toHaveBeenCalledWith("x");
  });

  test("returns null for an unknown valid slug", () => {
    const repo = spyRepo(null);
    expect(loadProduct("nope", repo)).toBeNull();
    expect(repo.getBySlug).toHaveBeenCalledTimes(1);
  });

  test.each(["' OR 1=1 --", "a".repeat(200), "../../etc/passwd", ""])(
    "returns null without a query for %p",
    (slug) => {
      const repo = spyRepo();
      expect(loadProduct(slug, repo)).toBeNull();
      expect(repo.getBySlug).not.toHaveBeenCalled();
    },
  );
});

describe("productTitle", () => {
  test("uses the product name, or a not-found title", () => {
    expect(productTitle(PRODUCT)).toBe("Thing X");
    expect(productTitle(null)).toBe("Product not found");
  });
});
