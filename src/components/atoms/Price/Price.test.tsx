import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Price } from "./Price";

describe("Price", () => {
  let warn: Mock<typeof console.warn>;

  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test("renders 1999 USD as $19.99", () => {
    const { container } = render(<Price amountCents={1999} />);
    expect(container).toHaveTextContent("$19.99");
    expect(container.textContent).toBe("$19.99");
    expect(warn).not.toHaveBeenCalled();
  });

  test("renders 0 as $0.00", () => {
    const { container } = render(<Price amountCents={0} currency="USD" />);
    expect(container.textContent).toBe("$0.00");
  });

  test("respects the currency's minor units", () => {
    const { container } = render(<Price amountCents={1999} currency="JPY" />);
    expect(container.textContent).toBe("¥1,999");
  });

  test.each([
    ["negative", -1],
    ["non-integer", 19.99],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("%s amount renders nothing and warns once", (_label, amount) => {
    const { container } = render(<Price amountCents={amount} />);
    expect(container).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("amountCents must be a non-negative safe integer");
  });

  test("invalid compareAtCents renders nothing and warns", () => {
    const { container } = render(<Price amountCents={1000} compareAtCents={-5} />);
    expect(container).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("compareAtCents");
  });

  test("invalid currency renders nothing and warns instead of throwing", () => {
    const { container } = render(<Price amountCents={1000} currency="NOPE!" />);
    expect(container).toBeEmptyDOMElement();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("currency");
  });

  test("does not warn in production", () => {
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const { container } = render(<Price amountCents={-1} />);
      expect(container).toBeEmptyDOMElement();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      env.NODE_ENV = original;
    }
  });

  test("compare-at higher than price announces 'Was' text, not only strikethrough", () => {
    const { container } = render(<Price amountCents={1999} compareAtCents={2999} />);
    expect(container.textContent).toBe("Now $19.99Was $29.99");
    const struck = container.querySelector("s");
    expect(struck).not.toBeNull();
    expect(struck).toHaveTextContent("Was $29.99");
    expect(screen.getByText("Was")).toHaveClass("sr-only");
    expect(screen.getByText("Now")).toHaveClass("sr-only");
  });

  test.each([1999, 1000])("compare-at %i <= price is ignored", (compareAt) => {
    const { container } = render(<Price amountCents={1999} compareAtCents={compareAt} />);
    expect(container.textContent).toBe("$19.99");
    expect(container.querySelector("s")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test.each([
    ["body", "text-body"],
    ["h3", "text-h3"],
    ["h2", "text-h2"],
  ] as const)("size %s uses %s", (size, cls) => {
    render(<Price amountCents={500} size={size} />);
    expect(screen.getByText("$5.00")).toHaveClass(cls);
  });

  test("merges className last and forwards rest props", () => {
    render(<Price amountCents={500} className="ml-2" data-testid="p" />);
    const el = screen.getByTestId("p");
    expect(el.className.endsWith("ml-2")).toBe(true);
  });
});
