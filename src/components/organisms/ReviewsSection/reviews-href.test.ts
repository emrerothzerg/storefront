import { describe, expect, test } from "bun:test";
import { DEFAULT_REVIEW_SORT } from "@/server/reviews/review-service";
import { DEFAULT_REVIEWS_SORT, buildReviewsHref } from "./reviews-href";

const base = "/products/desk-lamp";

describe("buildReviewsHref", () => {
  test("default sort mirrors the service", () => {
    expect(DEFAULT_REVIEWS_SORT).toBe(DEFAULT_REVIEW_SORT);
  });

  test("all defaults -> bare path with #reviews (no '?')", () => {
    expect(buildReviewsHref(base, { sort: "helpful" }, {})).toBe(`${base}#reviews`);
    expect(buildReviewsHref(base, { sort: "helpful", verifiedOnly: false, rpage: 1 })).toBe(`${base}#reviews`);
  });

  test("stable key order sort, stars, verified, rpage", () => {
    expect(buildReviewsHref(base, { sort: "recent", stars: 4, verifiedOnly: true, rpage: 3 })).toBe(
      `${base}?sort=recent&stars=4&verified=1&rpage=3#reviews`,
    );
    // Patch order does not matter.
    expect(
      buildReviewsHref(base, { sort: "helpful" }, { rpage: 2, verifiedOnly: true, stars: 1, sort: "recent" }),
    ).toBe(`${base}?sort=recent&stars=1&verified=1&rpage=2#reviews`);
  });

  test("filter or sort change drops rpage; explicit rpage keeps it", () => {
    const q = { sort: "recent" as const, stars: 4 as const, rpage: 5 };
    expect(buildReviewsHref(base, q, { stars: 2 })).toBe(`${base}?sort=recent&stars=2#reviews`);
    expect(buildReviewsHref(base, q, { stars: undefined })).toBe(`${base}?sort=recent#reviews`);
    expect(buildReviewsHref(base, q, { verifiedOnly: true })).toBe(`${base}?sort=recent&stars=4&verified=1#reviews`);
    expect(buildReviewsHref(base, q, { sort: "helpful" })).toBe(`${base}?stars=4#reviews`);
    expect(buildReviewsHref(base, q, { rpage: 6 })).toBe(`${base}?sort=recent&stars=4&rpage=6#reviews`);
    expect(buildReviewsHref(base, q, { stars: 3, rpage: 2 })).toBe(`${base}?sort=recent&stars=3&rpage=2#reviews`);
    // No patch keeps the current page.
    expect(buildReviewsHref(base, q)).toBe(`${base}?sort=recent&stars=4&rpage=5#reviews`);
  });

  test("invalid values are dropped, never emitted", () => {
    const bad = { sort: "evil" as unknown as "helpful", stars: 9 as unknown as 1, rpage: Number.NaN };
    expect(buildReviewsHref(base, bad)).toBe(`${base}#reviews`);
    expect(buildReviewsHref(base, { sort: "helpful" }, { rpage: 2.5 })).toBe(`${base}#reviews`);
    expect(buildReviewsHref(base, { sort: "helpful" }, { rpage: -3 })).toBe(`${base}#reviews`);
    expect(buildReviewsHref(base, { sort: "helpful" }, { rpage: Infinity })).toBe(`${base}#reviews`);
  });

  test("output is URL-safe and existing query/fragment on basePath is discarded", () => {
    const href = buildReviewsHref("/products/x?stars=1&evil=%3Cscript%3E#top", { sort: "recent" }, { stars: 5 });
    expect(href).toBe("/products/x?sort=recent&stars=5#reviews");
    const url = new URL(href, "https://shop.test");
    expect(url.searchParams.get("sort")).toBe("recent");
    expect(url.searchParams.get("stars")).toBe("5");
    expect(url.hash).toBe("#reviews");
    expect(href).not.toMatch(/[<>"' ]/);
  });

  test("does not mutate its inputs", () => {
    const q = Object.freeze({ sort: "recent" as const, stars: 2 as const, rpage: 2 });
    const patch = Object.freeze({ stars: undefined });
    expect(() => buildReviewsHref(base, q, patch)).not.toThrow();
    expect(q).toEqual({ sort: "recent", stars: 2, rpage: 2 });
  });
});
