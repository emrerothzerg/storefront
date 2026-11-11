import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { Price, splitPrice } from "./Price";

const visible = (root: Element): string =>
  root.querySelector('[data-slot="price-superscript"]')?.textContent ?? "";

describe("splitPrice", () => {
  test.each([
    [550, "USD", { prefix: "$", whole: "5", fraction: "50", suffix: "" }],
    [1000, "USD", { prefix: "$", whole: "10", fraction: "00", suffix: "" }],
    [129999, "USD", { prefix: "$", whole: "1,299", fraction: "99", suffix: "" }],
    [1999, "JPY", { prefix: "¥", whole: "1,999", fraction: "", suffix: "" }],
    [0, "USD", { prefix: "$", whole: "0", fraction: "00", suffix: "" }],
  ] as const)("%i %s", (cents, currency, expected) => {
    expect(splitPrice(cents, currency)).toEqual(expected);
  });

  test("invalid input returns null", () => {
    expect(splitPrice(-1, "USD")).toBeNull();
    expect(splitPrice(1.5, "USD")).toBeNull();
    expect(splitPrice(100, "NOPE!")).toBeNull();
  });
});

describe('Price display="superscript"', () => {
  test("raised cents; the whole formatted price is the accessible text", () => {
    const { container } = render(<Price amountCents={550} display="superscript" />);
    const sup = container.querySelector('[data-slot="price-superscript"]');
    expect(sup?.getAttribute("aria-hidden")).toBe("true");
    expect(visible(container)).toBe("$550");
    expect(screen.getByText("$5.50").className).toBe("sr-only");
    const minor = sup?.querySelectorAll("span") ?? [];
    expect(minor[0]?.textContent).toBe("$");
    expect(minor[1]?.textContent).toBe("5");
    expect(minor[2]?.textContent).toBe("50");
    expect(minor[0]?.className).toContain("text-caption");
    expect(minor[1]?.className).toContain("text-h3");
  });

  test("whole amounts drop .00 visually but keep it for assistive tech", () => {
    const { container } = render(<Price amountCents={1000} display="superscript" />);
    expect(visible(container)).toBe("$10");
    expect(screen.getByText("$10.00").className).toBe("sr-only");
  });

  test("zero-decimal currencies render without cents", () => {
    const { container } = render(<Price amountCents={1999} currency="JPY" display="superscript" />);
    expect(visible(container)).toBe("¥1,999");
  });

  test.each([
    ["body", "text-h3"],
    ["h3", "text-price"],
    ["h2", "text-price-lg"],
  ] as const)("size %s -> whole units %s", (size, cls) => {
    const html = renderToStaticMarkup(<Price amountCents={1299} size={size} display="superscript" />);
    expect(html).toContain(`class="${cls}`);
  });

  test("sale: Now/Was announced, compare-at struck through in standard form", () => {
    const { container } = render(<Price amountCents={1999} compareAtCents={2999} display="superscript" />);
    expect(screen.getByText("Now").className).toBe("sr-only");
    expect(screen.getByText("$19.99").className).toBe("sr-only");
    expect(container.querySelector("s")?.textContent).toBe("Was $29.99");
  });

  test("invalid input still renders nothing", () => {
    const html = renderToStaticMarkup(<Price amountCents={-5} display="superscript" />);
    expect(html).toBe("");
  });
});

describe("Price tone", () => {
  test('tone="deal" colours the current price only', () => {
    const { container } = render(<Price amountCents={1999} compareAtCents={2999} tone="deal" />);
    const current = container.firstElementChild?.firstElementChild;
    expect(current?.className).toBe("text-body text-deal");
    expect(container.querySelector("s")?.className).toContain("text-text-secondary");
  });

  test("default display/tone markup is unchanged", () => {
    expect(renderToStaticMarkup(<Price amountCents={500} />)).toBe(
      '<span class="inline-flex flex-wrap items-baseline gap-x-2"><span class="text-body text-text-primary">$5.00</span></span>',
    );
  });
});
