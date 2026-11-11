import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Product } from "@/lib/types";
import { ProductGrid } from "./ProductGrid";

// FIX-card-now: the grid forwards the page's single `now` to every card and
// never reads the clock itself.

/** Counts clock reads (`Date.now()` and argument-less `new Date()`) while `run` executes. */
function countClockReads(run: () => void): number {
  const RealDate = globalThis.Date;
  let reads = 0;
  class CountingDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date>) {
      super(...args);
      const argc: number = args.length;
      if (argc === 0) reads += 1;
    }
    static override now(): number {
      reads += 1;
      return RealDate.now();
    }
  }
  const nowSpy = spyOn(RealDate, "now");
  globalThis.Date = CountingDate as DateConstructor;
  try {
    run();
  } finally {
    globalThis.Date = RealDate;
    reads += nowSpy.mock.calls.length;
    nowSpy.mockRestore();
  }
  return reads;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-08T12:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 3 * DAY).toISOString();

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
    publishedAt: RECENT,
    ...overrides,
  };
}

/** Six recently published products; #1 on sale, #2 a top pick. */
const SIX = [1, 2, 3, 4, 5, 6].map((n) =>
  makeProduct(
    n,
    n === 1 ? { listPriceCents: 5000 } : n === 2 ? { ratingAvg: 4.8, ratingCount: 20 } : {},
  ),
);

/** Badge text per card, in DOM order ("" for a card with no badge row). */
function cardBadgeTexts(html: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  return [...host.querySelectorAll("article")].map(
    (card) => card.querySelector('[data-testid="product-card-badges"]')?.textContent ?? "",
  );
}
describe("ProductGrid: one clock (FIX-card-now)", () => {
  test("grid with now: every card gets it (New on all), 0 clock reads", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(<ProductGrid products={SIX} now={NOW} />);
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html)).toEqual(["SaleNew", "NewTop pick", "New", "New", "New", "New"]);
  });

  test("list layout with now: 0 clock reads, New on every card", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(<ProductGrid products={SIX} now={NOW} layout="list" />);
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html).every((t) => t.includes("New"))).toBe(true);
  });

  test("grid without now: 0 clock reads, no New badge (Sale / Top pick kept)", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(<ProductGrid products={SIX} />);
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html)).toEqual(["Sale", "Top pick", "", "", "", ""]);
  });

  test("cardProps without now: the grid's now still reaches every card", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(
        <ProductGrid products={SIX} now={NOW} cardProps={(_p, i) => ({ rank: i + 1, now: undefined })} />,
      );
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html).every((t) => t.includes("New"))).toBe(true);
  });

  test("cardProps now wins over the grid's now for that card", () => {
    const later = new Date(NOW.getTime() + 60 * DAY);
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(
        <ProductGrid products={SIX} now={NOW} cardProps={(_p, i) => (i === 2 ? { now: later } : {})} />,
      );
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html)).toEqual(["SaleNew", "NewTop pick", "", "New", "New", "New"]);
  });

  test("promo slots with now: 0 clock reads", () => {
    const reads = countClockReads(() => {
      renderToStaticMarkup(
        <ProductGrid products={SIX} now={NOW} promoSlots={[{ afterIndex: 1, tile: { heading: "Deals" } }]} />,
      );
    });
    expect(reads).toBe(0);
  });
});
