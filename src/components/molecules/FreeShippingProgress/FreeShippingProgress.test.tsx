import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { FreeShippingProgress, freeShippingModel } from ".";

describe("FreeShippingProgress", () => {
  test("below threshold: progressbar with value text plus visible 'Add $X more' text", () => {
    render(<FreeShippingProgress subtotalCents={2250} thresholdCents={3500} amountToFreeCents={1250} currency="USD" />);
    const bar = screen.getByRole("progressbar", { name: "Free shipping progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "64");
    expect(bar).toHaveAttribute("aria-valuetext", "$12.50 away from free shipping");
    expect(screen.getByText(/more for free shipping/).textContent).toBe("Add $12.50 more for free shipping");
  });

  test("at/above threshold: success text and a full bar", () => {
    render(<FreeShippingProgress subtotalCents={3500} thresholdCents={3500} amountToFreeCents={0} currency="USD" />);
    expect(screen.getByRole("status")).toHaveTextContent("You've got free shipping!");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });

  test("amountToFreeCents null derives the remaining amount", () => {
    expect(freeShippingModel(1000, 3500, null, "USD")).toEqual({
      kind: "progress",
      percent: 28,
      remainingText: "$25.00",
    });
    expect(freeShippingModel(5000, 3500, null, "USD")).toEqual({ kind: "qualified" });
  });

  test("percent never shows 100 while below threshold", () => {
    expect(freeShippingModel(3499, 3500, 1, "USD")).toMatchObject({ percent: 99 });
  });

  test("renders nothing for zero/invalid values", () => {
    const cases: Array<[number, number | null, number | null, string]> = [
      [0, 3500, 3500, "USD"],
      [1000, null, null, "USD"],
      [1000, 0, null, "USD"],
      [-1, 3500, null, "USD"],
      [10.5, 3500, null, "USD"],
      [Number.NaN, 3500, null, "USD"],
      [1000, Number.POSITIVE_INFINITY, null, "USD"],
      [1000, 3500, -5, "USD"],
      [1000, 3500, 1.5, "USD"],
      [1000, 3500, null, "NOT-A-CURRENCY"],
    ];
    for (const [s, t, a, c] of cases) {
      expect(freeShippingModel(s, t, a, c)).toBeNull();
      expect(
        renderToStaticMarkup(<FreeShippingProgress subtotalCents={s} thresholdCents={t} amountToFreeCents={a} currency={c} />),
      ).toBe("");
    }
  });

  test("server-safe: no 'use client' and no runtime server import", () => {
    const src = readFileSync(join(import.meta.dir, "FreeShippingProgress.tsx"), "utf8");
    expect(src).not.toContain("use client");
    expect(src).not.toMatch(/from "@\/server/);
  });
});
