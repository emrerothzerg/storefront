import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { PriceBlock, computeSavings } from "./PriceBlock";

describe("computeSavings", () => {
  test("exact integer savings and floored percent", () => {
    expect(computeSavings(6667, 10000)).toEqual({ savingsCents: 3333, percent: 33 });
    expect(computeSavings(1999, 2999)).toEqual({ savingsCents: 1000, percent: 33 });
    expect(computeSavings(5000, 10000)).toEqual({ savingsCents: 5000, percent: 50 });
    expect(computeSavings(0, 100)).toEqual({ savingsCents: 100, percent: 100 });
  });

  test("percent under 1 floors to 0 (the component hides it)", () => {
    expect(computeSavings(99_999, 100_000)).toEqual({ savingsCents: 1, percent: 0 });
  });

  test("exact near MAX_SAFE_INTEGER (BigInt percent)", () => {
    const list = Number.MAX_SAFE_INTEGER;
    const price = list - 3;
    expect(computeSavings(price, list)).toEqual({ savingsCents: 3, percent: 0 });
    expect(computeSavings(1, list)).toEqual({ savingsCents: list - 1, percent: 99 });
  });

  test.each([
    [1000, 1000],
    [1000, 999],
    [1000, null],
    [1000, undefined],
    [1000, Number.NaN],
    [1000, -5],
    [1000, 1500.5],
    [1000, Number.POSITIVE_INFINITY],
    [Number.NaN, 2000],
    [-1, 2000],
    [10.5, 2000],
    [1000, Number.MAX_SAFE_INTEGER + 2],
  ] as const)("price %p / list %p -> null", (price, list) => {
    expect(computeSavings(price, list)).toBeNull();
  });
});

describe("PriceBlock", () => {
  test("plain price when there is no list price", () => {
    const { container } = render(<PriceBlock priceCents={1999} currency="USD" />);
    expect(container).toHaveTextContent("$19.99");
    expect(container.querySelector("s")).toBeNull();
    expect(screen.queryByText(/You save/)).toBeNull();
  });

  test("list price struck with hidden 'List price:' prefix, savings and percent", () => {
    const { container } = render(<PriceBlock priceCents={6667} listPriceCents={10000} currency="USD" />);
    const s = container.querySelector("s");
    expect(s).toHaveTextContent("List price: $100.00");
    expect(screen.getByText("List price:")).toHaveClass("sr-only");
    expect(screen.getByText("You save $33.33 (33%)")).toHaveClass("text-success");
    expect(container).toHaveTextContent("$66.67");
  });

  test("savings under 1% shows the amount without a 0% percent", () => {
    render(<PriceBlock priceCents={99_999} listPriceCents={100_000} currency="USD" />);
    expect(screen.getByText("You save $0.01")).toBeInTheDocument();
    expect(screen.queryByText(/\(0%\)/)).toBeNull();
  });

  test.each([1999, 1000, Number.NaN, -1, 2500.5, null, Number.POSITIVE_INFINITY])(
    "invalid or non-greater list price %p renders the plain price only",
    (list) => {
      const { container } = render(
        <PriceBlock priceCents={1999} listPriceCents={list} currency="USD" showDealBadge />,
      );
      expect(container).toHaveTextContent("$19.99");
      expect(container.querySelector("s")).toBeNull();
      expect(screen.queryByText(/You save/)).toBeNull();
      expect(screen.queryByText("Deal")).toBeNull();
    },
  );

  test.each([Number.NaN, -1, 1.5])("invalid price %p renders nothing and does not throw", (price) => {
    const { container } = render(<PriceBlock priceCents={price} listPriceCents={5000} currency="USD" />);
    expect(container.innerHTML).toBe("");
  });

  test("invalid currency renders nothing", () => {
    const { container } = render(<PriceBlock priceCents={100} currency="NOPE!" />);
    expect(container.innerHTML).toBe("");
  });

  test("Deal badge only with showDealBadge and a real saving", () => {
    const { rerender } = render(<PriceBlock priceCents={500} listPriceCents={1000} currency="USD" showDealBadge />);
    expect(screen.getByText("Deal")).toHaveClass("bg-danger-subtle");
    rerender(<PriceBlock priceCents={500} listPriceCents={1000} currency="USD" />);
    expect(screen.queryByText("Deal")).toBeNull();
  });

  test("large amounts are exact", () => {
    render(<PriceBlock priceCents={123_456_789} listPriceCents={223_456_789} currency="USD" />);
    expect(screen.getByText("$1,234,567.89")).toBeInTheDocument();
    expect(screen.getByText("You save $1,000,000.00 (44%)")).toBeInTheDocument();
  });

  test("zero-decimal currency (JPY)", () => {
    const { container } = render(<PriceBlock priceCents={7500} listPriceCents={10000} currency="JPY" />);
    expect(container).toHaveTextContent("¥7,500");
    expect(container.querySelector("s")).toHaveTextContent("¥10,000");
    expect(screen.getByText("You save ¥2,500 (25%)")).toBeInTheDocument();
  });

  test("coupon banner as text; blank coupon fields render no banner", () => {
    const { container, rerender } = render(
      <PriceBlock priceCents={1000} currency="USD" coupon={{ code: "WELCOME10", description: "10% off" }} />,
    );
    expect(container).toHaveTextContent("Save with code WELCOME10: 10% off");
    expect(screen.getByText("WELCOME10")).toHaveClass("font-mono");
    rerender(<PriceBlock priceCents={1000} currency="USD" coupon={{ code: " ", description: "10% off" }} />);
    expect(container).not.toHaveTextContent("Save with code");
    rerender(<PriceBlock priceCents={1000} currency="USD" coupon={null} />);
    expect(container).not.toHaveTextContent("Save with code");
  });

  test("coupon text is rendered as text, never markup (SR3)", () => {
    const { container } = render(
      <PriceBlock priceCents={1000} currency="USD" coupon={{ code: "X<b>", description: "<img src=x>" }} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container).toHaveTextContent("Save with code X<b>: <img src=x>");
  });

  test("unit label and sizes", () => {
    const { container, rerender } = render(<PriceBlock priceCents={250} currency="USD" unitLabel="each" size="lg" />);
    expect(screen.getByText("each")).toHaveClass("text-small");
    expect(screen.getByText("$2.50")).toHaveClass("text-h2");
    rerender(<PriceBlock priceCents={250} currency="USD" size="sm" />);
    expect(screen.getByText("$2.50")).toHaveClass("text-body");
    rerender(<PriceBlock priceCents={250} currency="USD" />);
    expect(screen.getByText("$2.50")).toHaveClass("text-h3");
    expect(container).not.toHaveTextContent("each");
  });

  test("className merges and extra props pass through", () => {
    render(<PriceBlock priceCents={250} currency="USD" className="mt-2" data-testid="pb" />);
    expect(screen.getByTestId("pb")).toHaveClass("flex", "mt-2");
  });

  test("renderToStaticMarkup works with no inline styles", () => {
    const html = renderToStaticMarkup(
      <PriceBlock
        priceCents={6667}
        listPriceCents={10000}
        currency="USD"
        showDealBadge
        coupon={{ code: "WELCOME10", description: "10% off" }}
      />,
    );
    expect(html).toContain("You save $33.33 (33%)");
    expect(html).toContain("<s>");
    expect(html).not.toContain("style=");
  });
});

describe("PriceBlock display and inline layout (T137)", () => {
  test('display="superscript" keeps the full amount as the accessible text', () => {
    const { container } = render(<PriceBlock priceCents={1250} currency="USD" display="superscript" />);
    expect(screen.getByText("$12.50")).toHaveClass("sr-only");
    expect(container.querySelector('[data-slot="price-superscript"]')).toHaveAttribute("aria-hidden", "true");
  });

  test('inline sale: "$12.50" without a "Now" prefix, struck "Was $19.00", "N% off", deal colour', () => {
    const { container } = render(
      <PriceBlock priceCents={1250} listPriceCents={1900} currency="USD" layout="inline" display="superscript" size="sm" />,
    );
    const root = container.firstElementChild!;
    expect(root).toHaveAttribute("data-layout", "inline");
    expect(root).toHaveClass("flex-wrap", "items-baseline");
    expect(screen.getByText("$12.50").parentElement).toHaveClass("text-deal");
    expect(container.textContent).not.toContain("Now");
    expect(container.querySelector("s")?.textContent).toBe("Was $19.00");
    expect(screen.getByText("Was")).toHaveClass("sr-only");
    expect(screen.getByText("34% off")).toHaveClass("text-deal");
    expect(container.textContent).not.toContain("You save");
  });

  test("inline without a saving: plain price, no strike, default colour", () => {
    const { container } = render(<PriceBlock priceCents={1250} listPriceCents={1250} currency="USD" layout="inline" />);
    expect(container.querySelector("s")).toBeNull();
    expect(container.textContent).not.toContain("% off");
    expect(screen.getByText("$12.50")).toHaveClass("text-text-primary");
  });

  test("inline saving under 1%: strike shown, no '0% off'", () => {
    const { container } = render(<PriceBlock priceCents={99_950} listPriceCents={100_000} currency="USD" layout="inline" />);
    expect(container.querySelector("s")?.textContent).toBe("Was $1,000.00");
    expect(container.textContent).not.toContain("% off");
  });

  test("showPercentOff defaults to true (inline 'N% off', stacked '(Y%)')", () => {
    const inline = render(<PriceBlock priceCents={1250} listPriceCents={1900} currency="USD" layout="inline" />);
    expect(inline.container.textContent).toContain("34% off");
    inline.unmount();
    const stacked = render(<PriceBlock priceCents={1250} listPriceCents={1900} currency="USD" />);
    expect(stacked.container.textContent).toContain("You save $6.50 (34%)");
  });

  test("showPercentOff={false}: inline keeps price + struck 'Was', drops 'N% off'", () => {
    const { container } = render(
      <PriceBlock priceCents={1250} listPriceCents={1900} currency="USD" layout="inline" display="superscript" showPercentOff={false} />,
    );
    expect(container.querySelector("s")?.textContent).toBe("Was $19.00");
    expect(screen.getByText("$12.50").parentElement).toHaveClass("text-deal");
    expect(container.textContent).not.toContain("%");
  });

  test("showPercentOff={false}: stacked keeps 'You save $X' without the percent", () => {
    const { container } = render(
      <PriceBlock priceCents={1250} listPriceCents={1900} currency="USD" showPercentOff={false} />,
    );
    expect(container.textContent).toContain("You save $6.50");
    expect(container.textContent).not.toContain("%");
  });

  test("showPercentOff={false} without a saving is a plain price", () => {
    const { container } = render(
      <PriceBlock priceCents={1250} listPriceCents={null} currency="USD" layout="inline" showPercentOff={false} />,
    );
    expect(container.querySelector("s")).toBeNull();
    expect(container.textContent).toBe("$12.50");
  });

  test("inline ignores the deal badge and coupon (stacked only)", () => {
    const { container } = render(
      <PriceBlock
        priceCents={1250}
        listPriceCents={1900}
        currency="USD"
        layout="inline"
        showDealBadge
        coupon={{ code: "SAVE10", description: "10% off" }}
      />,
    );
    expect(container.textContent).not.toContain("Deal");
    expect(container.textContent).not.toContain("SAVE10");
  });

  test.each([
    [Number.NaN, "USD"],
    [-1, "USD"],
    [1250, "NOPE"],
  ])("inline invalid price %p / currency %p renders nothing", (priceCents, currency) => {
    const { container } = render(<PriceBlock priceCents={priceCents} currency={currency} layout="inline" />);
    expect(container.innerHTML).toBe("");
  });

  test("stacked layout keeps the 'List price:' prefix (default unchanged)", () => {
    const { container } = render(<PriceBlock priceCents={1250} listPriceCents={1900} currency="USD" display="superscript" />);
    expect(container.querySelector("s")?.textContent).toBe("List price: $19.00");
  });
});
