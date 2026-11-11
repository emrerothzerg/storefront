import { describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import type { Product } from "@/lib/types";
import { ProductRail } from "./ProductRail";

// FIX-card-now: the rail forwards the page's single `now` to every compact
// card and never reads the clock itself.

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
describe("ProductRail: one clock (FIX-card-now)", () => {
  test("rail with now: every compact card gets it (New on all), 0 clock reads", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(<ProductRail title="Best sellers" products={SIX} now={NOW} />);
    });
    expect(reads).toBe(0);
    expect(html).toContain('data-variant="compact"');
    expect(cardBadgeTexts(html)).toEqual(["SaleNew", "NewTop pick", "New", "New", "New", "New"]);
  });

  test("rail without now: 0 clock reads, no New badge (Sale / Top pick kept)", () => {
    let html = "";
    const reads = countClockReads(() => {
      html = renderToStaticMarkup(<ProductRail title="Best sellers" products={SIX} />);
    });
    expect(reads).toBe(0);
    expect(cardBadgeTexts(html)).toEqual(["Sale", "Top pick", "", "", "", ""]);
  });

  test("tabbed rail with quick add and now: 0 clock reads", () => {
    const addToCart: CartActionFn = async () => null;
    const reads = countClockReads(() => {
      renderToStaticMarkup(
        <ProductRail
          title="Top picks"
          products={SIX}
          now={NOW}
          quickAdd={{ action: addToCart }}
          tabs={[
            { id: "a", label: "A", href: "/?rail=a#top-picks" },
            { id: "b", label: "B", href: "/?rail=b#top-picks" },
          ]}
          activeId="b"
        />,
      );
    });
    expect(reads).toBe(0);
  });
});
