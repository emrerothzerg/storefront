import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Product } from "@/lib/types";
import { PRODUCT_CARD_IMAGE_SIZES, ProductCard } from "./ProductCard";

// FIX-card-now: one clock per page. The card never reads the clock; the page
// loader reads `now` once and passes it down.

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
function renderCards(now: Date | undefined): string {
  return SIX.map((product) => renderToStaticMarkup(<ProductCard product={product} now={now} />)).join("");
}

describe("ProductCard: one clock (FIX-card-now)", () => {
  test("N cards with a now read the clock 0 times and show New", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderCards(NOW);
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html)).toEqual(["SaleNew", "NewTop pick", "New", "New", "New", "New"]);
  });

  test("N cards without now read the clock 0 times; no New badge, Sale and Top pick kept", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderCards(undefined);
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html)).toEqual(["Sale", "Top pick", "", "", "", ""]);
  });

  test("compact and list variants without now read the clock 0 times", () => {
    const reads = countClockReads(() => {
      for (const product of SIX) {
        renderToStaticMarkup(<ProductCard product={product} variant="compact" />);
        renderToStaticMarkup(<ProductCard product={product} layout="list" />);
      }
    });
    expect(reads).toBe(0);
  });

  test("explicit badges still win and read no clock", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(<ProductCard product={SIX[0] as Product} badges={["new"]} />);
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html)).toEqual(["New"]);
  });

  test("the counter does see a clock read (guards against a blind spy)", () => {
    const sink: unknown[] = [];
    expect(countClockReads(() => void sink.push(Date.now()))).toBeGreaterThan(0);
    expect(countClockReads(() => void sink.push(new Date()))).toBe(1);
    expect(countClockReads(() => void sink.push(new Date(0)))).toBe(0);
    expect(sink).toHaveLength(3);
  });

  test("grid image sizes: 50vw on phones (2-column grid), never 100vw", () => {
    expect(PRODUCT_CARD_IMAGE_SIZES).toBe("(min-width: 1024px) 25vw, (min-width: 768px) 33vw, 50vw");
    expect(PRODUCT_CARD_IMAGE_SIZES).not.toContain("100vw");
  });
});
