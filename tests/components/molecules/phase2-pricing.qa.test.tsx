// QA (T70 / QA-W3-molecules-A): T61 PriceBlock, DeliveryEstimate, StockUrgency.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { PriceBlock, computeSavings } from "@/components/molecules/PriceBlock";
import { DeliveryEstimate, formatDeliveryRange } from "@/components/molecules/DeliveryEstimate";
import { StockUrgency, getStockUrgency } from "@/components/molecules/StockUrgency";

const ROOT = join(import.meta.dir, "../../../src/components/molecules");
const SOURCES = ["PriceBlock", "DeliveryEstimate", "StockUrgency"].map((n) => ({
  name: n,
  src: readFileSync(join(ROOT, n, `${n}.tsx`), "utf8"),
}));

/** Suppress the Price atom's dev warnings for intentionally invalid input. */
function quiet<T>(fn: () => T): T {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
}

describe("T61 cross-cutting", () => {
  for (const { name, src } of SOURCES) {
    test(`${name}: server-safe (no 'use client'), no style=, no runtime server import, no any/ts-ignore`, () => {
      expect(src.startsWith('"use client"')).toBe(false);
      expect(src).not.toContain("style=");
      expect(src).not.toMatch(/\bany\b(?![a-z ]*function)/);
      expect(src).not.toMatch(/@ts-(ignore|expect-error)/);
      for (const line of src.split("\n").filter((l) => l.includes("@/server/"))) {
        expect(line).toMatch(/^import type /);
      }
    });
  }
});

describe("T61 computeSavings (integer cents)", () => {
  const cases: Array<[number, number | null | undefined, { savingsCents: number; percent: number } | null]> = [
    [1999, 2999, { savingsCents: 1000, percent: 33 }],
    [6667, 10000, { savingsCents: 3333, percent: 33 }],
    [1, 3, { savingsCents: 2, percent: 66 }], // 66.67 floors to 66
    [999, 1000, { savingsCents: 1, percent: 0 }],
    [0, 500, { savingsCents: 500, percent: 100 }],
    [1000, 1000, null],
    [1001, 1000, null],
    [1000, null, null],
    [1000, undefined, null],
    [1000, Number.NaN, null],
    [1000, 1500.5, null],
    [-1, 1000, null],
    [1000, Number.POSITIVE_INFINITY, null],
    [1000, Number.MAX_SAFE_INTEGER + 2, null],
  ];
  for (const [price, list, want] of cases) {
    test(`(${price}, ${String(list)}) -> ${JSON.stringify(want)}`, () => {
      expect(computeSavings(price, list)).toEqual(want);
    });
  }

  test("exact near MAX_SAFE_INTEGER (no float drift)", () => {
    const list = Number.MAX_SAFE_INTEGER;
    const price = list - 3;
    expect(computeSavings(price, list)).toEqual({ savingsCents: 3, percent: 0 });
    const half = Math.floor(list / 2);
    const r = computeSavings(half, list)!;
    expect(r.savingsCents).toBe(list - half);
    expect(r.percent).toBe(50);
  });
});

describe("T61 PriceBlock rendering", () => {
  test("savings shown: struck list price with hidden 'List price:' prefix and 'You save $X (Y%)'", () => {
    const { container } = render(<PriceBlock priceCents={1999} listPriceCents={2999} currency="USD" showDealBadge />);
    const s = container.querySelector("s")!;
    expect(s).not.toBeNull();
    expect(s.textContent).toBe("List price: $29.99");
    const hidden = Array.from(s.querySelectorAll("span")).find((el) => el.textContent === "List price: ");
    expect(hidden?.className).toMatch(/sr-only/);
    expect(screen.getByText("You save $10.00 (33%)")).toBeInTheDocument();
    expect(screen.getByText("Deal")).toBeInTheDocument();
  });

  test("percent under 1% never prints 0%", () => {
    const { container } = render(<PriceBlock priceCents={999} listPriceCents={1000} currency="USD" />);
    expect(container.textContent).toContain("You save $0.01");
    expect(container.textContent).not.toMatch(/\(0%\)|0%/);
  });

  for (const list of [1999, 1000, 0, -500, Number.NaN, 2500.5, null, undefined, Number.POSITIVE_INFINITY]) {
    test(`list ${String(list)} vs price 1999: plain price, no savings, no strike, no Deal, never negative`, () => {
      const { container } = quiet(() =>
        render(<PriceBlock priceCents={1999} listPriceCents={list} currency="USD" showDealBadge />),
      );
      expect(container.textContent).toContain("$19.99");
      expect(container.querySelector("s")).toBeNull();
      expect(container.textContent).not.toMatch(/save|Deal|-\$|NaN/);
    });
  }

  for (const [label, props] of [
    ["NaN price", { priceCents: Number.NaN, currency: "USD" }],
    ["negative price", { priceCents: -1, currency: "USD" }],
    ["fractional price", { priceCents: 10.5, currency: "USD" }],
    ["bad currency", { priceCents: 100, currency: "XX" }],
    ["empty currency", { priceCents: 100, currency: "" }],
  ] as const) {
    test(`invalid input (${label}) renders nothing and does not throw`, () => {
      const html = quiet(() => renderToStaticMarkup(<PriceBlock {...props} listPriceCents={5000} />));
      expect(html).toBe("");
    });
  }

  test("JPY formatting (zero-decimal currency)", () => {
    const { container } = render(<PriceBlock priceCents={1500} listPriceCents={2000} currency="JPY" />);
    expect(container.textContent).toContain("¥1,500");
    expect(container.textContent).toContain("List price: ¥2,000");
    expect(container.textContent).toContain("You save ¥500 (25%)");
  });

  test("Deal badge needs a real saving; coupon line rendered as text (hostile code inert)", () => {
    const { container } = render(
      <PriceBlock
        priceCents={1000}
        currency="USD"
        showDealBadge
        coupon={{ code: "<b>X</b>", description: "<img src=x onerror=alert(1)>" }}
      />,
    );
    expect(screen.queryByText("Deal")).toBeNull();
    expect(container.querySelector("b, img")).toBeNull();
    expect(container.textContent).toContain("Save with code <b>X</b>: <img src=x onerror=alert(1)>");
  });

  test("blank coupon code/description renders no coupon line", () => {
    const { container } = render(<PriceBlock priceCents={1000} currency="USD" coupon={{ code: " ", description: "x" }} />);
    expect(container.textContent).not.toContain("Save with code");
  });
});

const EST = { start: "2026-11-10T08:00:00.000Z", end: "2026-11-12T20:00:00.000Z" };

describe("T61 DeliveryEstimate", () => {
  test("en-US UTC range 'Arrives Tue, Nov 10 – Thu, Nov 12' with hidden 'to' for AT", () => {
    const { container } = render(<DeliveryEstimate estimate={EST} inStock methodName="Standard Shipping" isFree />);
    const text = container.textContent ?? "";
    expect(text).toContain("Arrives Tue, Nov 10");
    expect(text).toContain("Thu, Nov 12");
    expect(text).toContain("Free Standard Shipping");
  });

  test("UTC, not local: a late-UTC timestamp keeps its UTC day", () => {
    expect(formatDeliveryRange({ start: "2026-11-10T23:59:00Z", end: "2026-11-10T23:59:30Z" })).toEqual({
      start: "Tue, Nov 10",
      end: null,
    });
  });

  test("'Tomorrow' labelling only with now, and only for the next UTC day", () => {
    const now = Date.parse("2026-11-09T22:00:00Z");
    expect(formatDeliveryRange(EST, now)).toEqual({ start: "Tomorrow, Nov 10", end: "Thu, Nov 12" });
    expect(formatDeliveryRange(EST)).toEqual({ start: "Tue, Nov 10", end: "Thu, Nov 12" });
    expect(formatDeliveryRange(EST, Number.NaN)).toEqual({ start: "Tue, Nov 10", end: "Thu, Nov 12" });
  });

  for (const [label, estimate, inStock] of [
    ["out of stock", EST, false],
    ["null estimate", null, true],
    ["unparseable start", { start: "soon", end: EST.end }, true],
    ["empty end", { start: EST.start, end: "" }, true],
    ["end before start", { start: EST.end, end: EST.start }, true],
    ["hour 25", { start: "2026-11-10T25:00:00Z", end: EST.end }, true],
  ] as const) {
    test(`renders nothing: ${label}`, () => {
      const html = renderToStaticMarkup(<DeliveryEstimate estimate={estimate} inStock={inStock} />);
      expect(html).toBe("");
    });
  }

  // DEFECT D-T61-1 (fixed in FIX-mol-A): Date.parse is lenient (JSC rolls 2026-02-31
  // over to Mar 3); the strict ISO parser now rejects impossible calendar dates.
  test("DEFECT D-T61-1: impossible calendar date (2026-02-31) renders nothing", () => {
    const html = renderToStaticMarkup(
      <DeliveryEstimate estimate={{ start: "2026-02-31T08:00:00Z", end: "2026-03-05T08:00:00Z" }} inStock />,
    );
    expect(html).toBe("");
  });
  test("regression D-T61-1: 2026-02-31 is no longer shown as 'Tue, Mar 3'", () => {
    expect(formatDeliveryRange({ start: "2026-02-31T08:00:00Z", end: "2026-03-05T08:00:00Z" })).toBeNull();
  });

  test("hostile method / note render as text", () => {
    const { container } = render(
      <DeliveryEstimate estimate={EST} inStock methodName="<script>x</script>" freeShippingNote="<img src=x>" />,
    );
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain("<script>x</script>");
  });
});

describe("T61 StockUrgency", () => {
  const table: Array<[number, string, string]> = [
    [0, "out", "Out of stock"],
    [-3, "out", "Out of stock"],
    [Number.NaN, "out", "Out of stock"],
    [2.5, "out", "Out of stock"],
    [Number.POSITIVE_INFINITY, "out", "Out of stock"],
    [1, "low", "Only 1 left in stock"],
    [5, "low", "Only 5 left in stock"],
    [6, "in", "In stock"],
    [10_000, "in", "In stock"],
  ];
  for (const [stock, status, label] of table) {
    test(`stock ${stock} -> ${status} '${label}' as text`, () => {
      expect(getStockUrgency(stock)).toEqual({ status: status as "out" | "low" | "in", label });
      const { container } = render(<StockUrgency stock={stock} />);
      expect(container.textContent).toBe(label);
    });
  }

  test("no live region, no status/alert role, no timer-driven markup", () => {
    const html = renderToStaticMarkup(<StockUrgency stock={2} />);
    expect(html).not.toMatch(/aria-live|role="(status|alert|timer)"/);
    expect(html).not.toContain("style=");
  });

  test("custom threshold and invalid threshold fallback", () => {
    expect(getStockUrgency(8, 10).status).toBe("low");
    expect(getStockUrgency(5, Number.NaN).status).toBe("low");
    expect(getStockUrgency(6, -1).status).toBe("in");
  });
});
