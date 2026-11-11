import { describe, expect, test } from "bun:test";
import {
  CARD_BADGE_MAX,
  CARD_BADGE_NEW_DAYS,
  CARD_BADGE_TOP_PICK_MIN_RATING,
  CARD_BADGE_TOP_PICK_MIN_REVIEWS,
  PRODUCT_CARD_BADGES,
  type CardBadgeProduct,
  type ProductCardBadge,
  cardBadges,
  normalizeCardBadges,
} from "./card-badges";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-08T12:00:00.000Z");

function daysAgo(days: number, extraMs = 0): string {
  return new Date(NOW.getTime() - days * DAY - extraMs).toISOString();
}

const plain: CardBadgeProduct = { priceCents: 1250 };

function p(over: Partial<CardBadgeProduct> = {}): CardBadgeProduct {
  return { ...plain, ...over };
}

describe("cardBadges(product, now): constants", () => {
  test("documented thresholds", () => {
    expect(CARD_BADGE_MAX).toBe(2);
    expect(CARD_BADGE_NEW_DAYS).toBe(30);
    expect(CARD_BADGE_TOP_PICK_MIN_RATING).toBe(4.5);
    expect(CARD_BADGE_TOP_PICK_MIN_REVIEWS).toBe(5);
  });

  test("labels are text from {Sale, New, Top pick}", () => {
    expect(PRODUCT_CARD_BADGES.sale.label).toBe("Sale");
    expect(PRODUCT_CARD_BADGES.new.label).toBe("New");
    expect(PRODUCT_CARD_BADGES.top_pick.label).toBe("Top pick");
  });
});

describe("cardBadges(product, now): Sale", () => {
  test("no list price: no badge", () => {
    expect(cardBadges(p(), NOW)).toEqual([]);
    expect(cardBadges(p({ listPriceCents: null }), NOW)).toEqual([]);
  });

  test("list price equal to price: no Sale", () => {
    expect(cardBadges(p({ listPriceCents: 1250 }), NOW)).toEqual([]);
  });

  test("list price below price: no Sale", () => {
    expect(cardBadges(p({ listPriceCents: 1000 }), NOW)).toEqual([]);
  });

  test("list price above price: Sale", () => {
    expect(cardBadges(p({ listPriceCents: 1251 }), NOW)).toEqual(["sale"]);
    expect(cardBadges(p({ listPriceCents: 1900 }), NOW)).toEqual(["sale"]);
  });

  test.each([Number.NaN, -1, 1900.5, Number.POSITIVE_INFINITY])("invalid list price %p: no Sale", (list) => {
    expect(cardBadges(p({ listPriceCents: list }), NOW)).toEqual([]);
  });

  test("invalid price: no Sale", () => {
    expect(cardBadges(p({ priceCents: Number.NaN, listPriceCents: 1900 }), NOW)).toEqual([]);
  });
});

describe("cardBadges(product, now): New (published within 30 days, inclusive)", () => {
  test("day 0 (published now) is New", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(0) }), NOW)).toEqual(["new"]);
  });

  test("day 29 is New", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(29) }), NOW)).toEqual(["new"]);
  });

  test("day 30 exactly is New (boundary inclusive)", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(30) }), NOW)).toEqual(["new"]);
  });

  test("1 ms past day 30 is not New", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(30, 1) }), NOW)).toEqual([]);
  });

  test("day 31 is not New", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(31) }), NOW)).toEqual([]);
  });

  test("future-dated (not yet published) is not New", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(-1) }), NOW)).toEqual([]);
  });

  test.each(["", "not a date", "2026-13-45T00:00:00Z"])("unparseable publishedAt %p: not New", (publishedAt) => {
    expect(cardBadges(p({ publishedAt }), NOW)).toEqual([]);
  });

  test("invalid now: not New, no throw", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(1) }), new Date(Number.NaN))).toEqual([]);
  });

  test("result depends on now, not the wall clock", () => {
    const product = p({ publishedAt: "2020-01-10T00:00:00.000Z" });
    expect(cardBadges(product, new Date("2020-01-20T00:00:00.000Z"))).toEqual(["new"]);
    expect(cardBadges(product, new Date("2020-03-01T00:00:00.000Z"))).toEqual([]);
  });
});

describe("cardBadges(product, now): Top pick (rating >= 4.5 and >= 5 reviews)", () => {
  test("rating 4.5 with 4 reviews: no Top pick", () => {
    expect(cardBadges(p({ ratingAvg: 4.5, ratingCount: 4 }), NOW)).toEqual([]);
  });

  test("rating 4.5 with 5 reviews: Top pick", () => {
    expect(cardBadges(p({ ratingAvg: 4.5, ratingCount: 5 }), NOW)).toEqual(["top_pick"]);
  });

  test("rating 4.4 with 500 reviews: no Top pick", () => {
    expect(cardBadges(p({ ratingAvg: 4.4, ratingCount: 500 }), NOW)).toEqual([]);
  });

  test.each([
    [Number.NaN, 10],
    [4.8, Number.NaN],
    [4.8, 5.5],
    [4.8, undefined],
    [undefined, 10],
  ])("invalid rating avg %p / count %p: no Top pick", (ratingAvg, ratingCount) => {
    expect(cardBadges(p({ ratingAvg, ratingCount }), NOW)).toEqual([]);
  });
});

describe("cardBadges(product, now): priority and cap", () => {
  const all = p({ listPriceCents: 1900, publishedAt: daysAgo(3), ratingAvg: 4.9, ratingCount: 40 });

  test("more than 2 qualifying: only two, in order sale > new > top pick", () => {
    expect(cardBadges(all, NOW)).toEqual(["sale", "new"]);
  });

  test("new + top pick", () => {
    expect(cardBadges(p({ publishedAt: daysAgo(3), ratingAvg: 4.9, ratingCount: 40 }), NOW)).toEqual(["new", "top_pick"]);
  });

  test("sale + top pick", () => {
    expect(cardBadges(p({ listPriceCents: 1900, ratingAvg: 4.9, ratingCount: 40 }), NOW)).toEqual(["sale", "top_pick"]);
  });

  test("pure: same output on repeat calls and the input is not mutated", () => {
    const frozen = Object.freeze({ ...all });
    const first = cardBadges(frozen, NOW);
    expect(cardBadges(frozen, NOW)).toEqual(first);
    expect(frozen).toEqual(all);
  });
});

describe("normalizeCardBadges (explicit list) and the deprecated cardBadges(list) form", () => {
  test("known keys only, first occurrence wins, order kept, capped at 2", () => {
    const raw = ["deal", "deal", "bogus", "toString", "__proto__", "constructor", "new", "top_pick"] as unknown as ProductCardBadge[];
    expect(normalizeCardBadges(raw)).toEqual(["deal", "new"]);
    expect(cardBadges(raw)).toEqual(["deal", "new"]);
  });

  test("undefined and non-arrays give []", () => {
    expect(normalizeCardBadges(undefined)).toEqual([]);
    expect(cardBadges(undefined)).toEqual([]);
    expect(normalizeCardBadges("sale" as unknown as ProductCardBadge[])).toEqual([]);
  });
});
