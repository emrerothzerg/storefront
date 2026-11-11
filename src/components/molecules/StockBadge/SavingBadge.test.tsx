import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { SavingBadge, savingLabel } from "./index";

describe("savingLabel", () => {
  test("amount and floored percent (contract P-6: 1999 vs 2499 -> Save $5.00 (20%))", () => {
    expect(savingLabel(1999, 2499, "USD")).toBe("Save $5.00 (20%)");
    expect(savingLabel(1000, 3000, "USD")).toBe("Save $20.00 (66%)");
  });

  test("saving under 1% drops the percent", () => {
    expect(savingLabel(99_950, 100_000, "USD")).toBe("Save $0.50");
  });

  test.each([
    ["no list price", 1999, null],
    ["undefined list price", 1999, undefined],
    ["list equals price", 1999, 1999],
    ["list below price", 1999, 1500],
    ["negative list", 1999, -1],
    ["fractional list", 1999, 2499.5],
    ["NaN list", 1999, Number.NaN],
    ["negative price", -1, 2499],
  ])("%s -> null", (_label, price, list) => {
    expect(savingLabel(price, list, "USD")).toBeNull();
  });

  test("invalid currency -> null, never throws", () => {
    expect(savingLabel(1999, 2499, "NOT-A-CODE")).toBeNull();
  });

  test("zero-decimal currency", () => {
    expect(savingLabel(800, 1000, "JPY")).toBe("Save ¥200 (20%)");
  });
});

describe("SavingBadge", () => {
  test("solid deal pill with text and a decorative tag icon", () => {
    const { container } = render(<SavingBadge priceCents={1999} listPriceCents={2499} currency="USD" />);
    const badge = screen.getByText("Save $5.00 (20%)");
    expect(badge).toHaveClass("rounded-full", "bg-deal", "text-text-on-accent", "text-small");
    expect(badge).toHaveAttribute("data-saving-badge");
    const svg = container.querySelector('svg[data-icon="tag"]');
    expect(svg?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  test("no saving renders nothing", () => {
    expect(renderToStaticMarkup(<SavingBadge priceCents={1999} listPriceCents={null} currency="USD" />)).toBe("");
    expect(renderToStaticMarkup(<SavingBadge priceCents={1999} listPriceCents={1000} currency="USD" />)).toBe("");
    expect(renderToStaticMarkup(<SavingBadge priceCents={1999} listPriceCents={2499} currency="??" />)).toBe("");
  });

  test("className merges; server-safe static markup without inline styles", () => {
    const html = renderToStaticMarkup(
      <SavingBadge priceCents={1999} listPriceCents={2499} currency="USD" className="self-start" shape="square" size="sm" />,
    );
    expect(html).toContain("self-start");
    expect(html).toContain("rounded-sm");
    expect(html).toContain("text-caption");
    expect(html).not.toContain("style=");
  });
});
