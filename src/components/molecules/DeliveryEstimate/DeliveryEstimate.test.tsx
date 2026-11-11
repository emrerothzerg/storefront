import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveryEstimate, formatDeliveryDay, formatDeliveryRange } from "./DeliveryEstimate";

const RANGE = { start: "2026-11-10T00:00:00.000Z", end: "2026-11-12T23:59:00.000Z" };
const NOW = Date.parse("2026-11-09T15:00:00.000Z");

describe("formatDeliveryRange", () => {
  test("en-US UTC weekday, month, day", () => {
    expect(formatDeliveryRange(RANGE)).toEqual({ start: "Tue, Nov 10", end: "Thu, Nov 12" });
  });

  test("uses UTC regardless of the ISO offset", () => {
    // 23:30 at -05:00 is 04:30 UTC on Nov 11.
    expect(formatDeliveryRange({ start: "2026-11-10T23:30:00-05:00", end: "2026-11-11T05:00:00Z" })).toEqual({
      start: "Wed, Nov 11",
      end: null,
    });
  });

  test("same UTC day collapses to a single date", () => {
    expect(formatDeliveryRange({ start: "2026-11-10T01:00:00Z", end: "2026-11-10T22:00:00Z" })).toEqual({
      start: "Tue, Nov 10",
      end: null,
    });
  });

  test("Tomorrow label when the day after now", () => {
    expect(formatDeliveryRange(RANGE, NOW)).toEqual({ start: "Tomorrow, Nov 10", end: "Thu, Nov 12" });
    expect(formatDeliveryDay(Date.parse("2026-11-10T12:00:00Z"), NOW)).toBe("Tomorrow, Nov 10");
    expect(formatDeliveryDay(Date.parse("2026-11-10T12:00:00Z"), Number.NaN)).toBe("Tue, Nov 10");
  });

  test.each([
    null,
    undefined,
    { start: "not a date", end: RANGE.end },
    { start: RANGE.start, end: "" },
    { start: RANGE.end, end: RANGE.start },
    { start: 42 as unknown as string, end: RANGE.end },
  ])("invalid estimate %p -> null", (estimate) => {
    expect(formatDeliveryRange(estimate)).toBeNull();
  });
});

describe("DeliveryEstimate", () => {
  test("renders 'Arrives start – end' with a decorative truck icon", () => {
    const { container } = render(<DeliveryEstimate estimate={RANGE} inStock />);
    expect(container).toHaveTextContent(/^Arrives Tue, Nov 10 – to Thu, Nov 12$/);
    const icon = container.querySelector('svg[data-icon="truck"]');
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("to")).toHaveClass("sr-only");
  });

  test("single date when start and end share a day", () => {
    const { container } = render(
      <DeliveryEstimate estimate={{ start: RANGE.start, end: "2026-11-10T20:00:00Z" }} inStock />,
    );
    expect(container).toHaveTextContent(/^Arrives Tue, Nov 10$/);
  });

  test("out of stock renders nothing (criterion 3)", () => {
    const { container } = render(
      <DeliveryEstimate estimate={RANGE} inStock={false} methodName="Standard" isFree freeShippingNote="Note" />,
    );
    expect(container.innerHTML).toBe("");
  });

  test.each([null, { start: "garbage", end: "2026-11-12" }, { start: RANGE.end, end: RANGE.start }])(
    "invalid or missing estimate %p renders nothing, no crash",
    (estimate) => {
      const { container } = render(<DeliveryEstimate estimate={estimate} inStock methodName="Standard" />);
      expect(container.innerHTML).toBe("");
    },
  );

  test("method name, Free and free-shipping note as text", () => {
    const { container } = render(
      <DeliveryEstimate
        estimate={RANGE}
        inStock
        methodName="Standard Shipping"
        isFree
        freeShippingNote="Free shipping on orders of $35 or more"
      />,
    );
    expect(container).toHaveTextContent("Free Standard Shipping");
    expect(screen.getByText("Free")).toHaveClass("text-success");
    expect(screen.getByText("Free shipping on orders of $35 or more")).toHaveClass("text-text-secondary");
  });

  test("Free without a method name reads 'Free delivery'; nothing extra when neither", () => {
    const { container, rerender } = render(<DeliveryEstimate estimate={RANGE} inStock isFree />);
    expect(container).toHaveTextContent("Free delivery");
    rerender(<DeliveryEstimate estimate={RANGE} inStock methodName="  " freeShippingNote="   " />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  test("Tomorrow label with now", () => {
    const { container } = render(<DeliveryEstimate estimate={RANGE} inStock now={NOW} />);
    expect(container).toHaveTextContent("Arrives Tomorrow, Nov 10");
  });

  test("user-ish text is rendered as text (SR3)", () => {
    const { container } = render(<DeliveryEstimate estimate={RANGE} inStock methodName="<img src=x>" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent("<img src=x>");
  });

  test("className merges and renderToStaticMarkup works without inline styles", () => {
    render(<DeliveryEstimate estimate={RANGE} inStock className="mt-2" data-testid="de" />);
    expect(screen.getByTestId("de")).toHaveClass("flex", "mt-2");
    const html = renderToStaticMarkup(<DeliveryEstimate estimate={RANGE} inStock methodName="Standard" isFree />);
    expect(html).toContain("Tue, Nov 10");
    expect(html).toContain("Thu, Nov 12");
    expect(html).not.toContain("style=");
  });
});

describe("strict ISO parsing (D-T61-1)", () => {
  test.each([
    ["impossible calendar date", { start: "2026-02-31T08:00:00Z", end: "2026-03-05T08:00:00Z" }],
    ["no zone (local time)", { start: "2026-11-10T08:00:00", end: "2026-11-12T08:00:00Z" }],
    ["date only", { start: "2026-11-10", end: "2026-11-12T08:00:00Z" }],
    ["end Apr 31", { start: "2026-04-28T08:00:00Z", end: "2026-04-31T08:00:00Z" }],
  ])("%s renders nothing", (_label, estimate) => {
    expect(formatDeliveryRange(estimate)).toBeNull();
    expect(renderToStaticMarkup(<DeliveryEstimate estimate={estimate} inStock />)).toBe("");
  });
});

describe("DeliveryEstimate Phase 3 look (T145)", () => {
  test("accent truck icon; Free is a success pill with text; detail lines indented under the date", () => {
    const { container } = render(
      <DeliveryEstimate estimate={RANGE} inStock methodName="Standard Shipping" isFree freeShippingNote="Note" />,
    );
    expect(container.querySelector('svg[data-icon="truck"]')).toHaveClass("text-accent");
    expect(screen.getByText("Free")).toHaveClass("rounded-full", "bg-success-subtle", "text-success", "font-semibold");
    const lines = container.querySelectorAll("p");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toHaveClass("pl-7");
    expect(lines[2]).toHaveClass("pl-7", "text-text-secondary");
  });
});
