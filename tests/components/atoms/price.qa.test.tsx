// QA (T02.2, T02.3): Price adversarial inputs.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Price } from "@/components/atoms/Price";

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
});
afterEach(() => {
  warn.mockRestore();
});

describe("Price valid input", () => {
  test.each([
    [1999, "$19.99"],
    [0, "$0.00"],
    [1, "$0.01"],
    [100, "$1.00"],
    [123456789, "$1,234,567.89"],
  ])("%i cents USD renders %s", (cents, text) => {
    const { container } = render(<Price amountCents={cents} />);
    expect(container.textContent).toBe(text);
    expect(warn).not.toHaveBeenCalled();
  });

  test("-0 renders $0.00 (not -$0.00)", () => {
    const { container } = render(<Price amountCents={-0} />);
    expect(container.textContent).toBe("$0.00");
  });

  test("JPY has no minor digits", () => {
    const { container } = render(<Price amountCents={1999} currency="JPY" />);
    expect(container.textContent).toBe("¥1,999");
  });

  test("lowercase currency code is accepted by Intl (documents behaviour)", () => {
    const { container } = render(<Price amountCents={1999} currency="usd" />);
    expect(container.textContent).toBe("$19.99");
  });
});

describe("Price invalid input renders nothing, warns, never throws", () => {
  test.each([
    ["-1", -1],
    ["1.5", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["MAX_SAFE_INTEGER + 1", Number.MAX_SAFE_INTEGER + 1],
    ["string '1999' (bypassing types)", "1999" as unknown as number],
    ["null (bypassing types)", null as unknown as number],
  ])("amountCents %s", (_label, value) => {
    const { container } = render(
      <div data-testid="host">
        <Price amountCents={value} />
      </div>,
    );
    expect(screen.getByTestId("host")).toBeEmptyDOMElement();
    expect(container.textContent).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("[Price]");
  });

  test.each([["XYZ1"], [""], ["US"], ["DOLLARS"]])("invalid currency %p renders nothing and warns", (currency) => {
    const { container } = render(<Price amountCents={1999} currency={currency} />);
    expect(container.textContent).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each([[-1], [2.5], [Number.NaN]])("invalid compareAtCents %p renders nothing and warns", (compareAt) => {
    const { container } = render(<Price amountCents={1000} compareAtCents={compareAt} />);
    expect(container.textContent).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("Price compare-at (T02.3)", () => {
  test("higher compare-at renders 'Now' + 'Was' accessible text, struck through", () => {
    const { container } = render(<Price amountCents={1500} compareAtCents={2000} />);
    expect(container.textContent).toBe("Now $15.00Was $20.00");
    const s = container.querySelector("s");
    expect(s).not.toBeNull();
    expect(s).toHaveTextContent("Was $20.00");
    expect(screen.getByText("Was")).toHaveClass("sr-only");
    expect(screen.getByText("Now")).toHaveClass("sr-only");
  });

  test("compare-at lower than price is ignored", () => {
    const { container } = render(<Price amountCents={2000} compareAtCents={1500} />);
    expect(container.textContent).toBe("$20.00");
    expect(container.querySelector("s")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("compare-at equal to price is ignored", () => {
    const { container } = render(<Price amountCents={2000} compareAtCents={2000} />);
    expect(container.textContent).toBe("$20.00");
    expect(container.querySelector("s")).toBeNull();
  });

  test("compare-at with price 0 (free) still shows Was", () => {
    const { container } = render(<Price amountCents={0} compareAtCents={500} />);
    expect(container.textContent).toBe("Now $0.00Was $5.00");
  });

  test("size h2 uses text-h2 for current and text-body for compare-at", () => {
    const { container } = render(<Price amountCents={1500} compareAtCents={2000} size="h2" />);
    expect(container.querySelector(".text-h2")).toHaveTextContent("$15.00");
    expect(container.querySelector("s")).toHaveClass("text-body", "text-text-secondary");
  });
});
