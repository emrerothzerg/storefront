import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { STOCK_URGENCY_THRESHOLD, StockUrgency, getStockUrgency } from "./StockUrgency";

describe("getStockUrgency", () => {
  test("default threshold is 5", () => {
    expect(STOCK_URGENCY_THRESHOLD).toBe(5);
    expect(getStockUrgency(5).status).toBe("low");
    expect(getStockUrgency(6).status).toBe("in");
  });

  test("0 is out of stock", () => {
    expect(getStockUrgency(0)).toEqual({ status: "out", label: "Out of stock" });
  });

  test.each([-1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 2.5, 0.1])(
    "invalid stock %p normalises to 0 (out of stock)",
    (stock) => {
      expect(getStockUrgency(stock).status).toBe("out");
    },
  );

  test.each([1, 2, 3, 4, 5])("%p -> 'Only N left in stock'", (n) => {
    expect(getStockUrgency(n)).toEqual({ status: "low", label: `Only ${n} left in stock` });
  });

  test.each([6, 100, 1_000_000])("%p -> In stock", (n) => {
    expect(getStockUrgency(n)).toEqual({ status: "in", label: "In stock" });
  });

  test("custom and invalid thresholds", () => {
    expect(getStockUrgency(10, 10).status).toBe("low");
    expect(getStockUrgency(11, 10).status).toBe("in");
    expect(getStockUrgency(1, 0).status).toBe("in");
    expect(getStockUrgency(5, Number.NaN).status).toBe("low");
    expect(getStockUrgency(5, -1).status).toBe("low");
    expect(getStockUrgency(6, 2.5).status).toBe("in");
  });
});

describe("StockUrgency", () => {
  test("out of stock: danger text with decorative icon", () => {
    const { container } = render(<StockUrgency stock={0} />);
    const p = screen.getByText("Out of stock").parentElement;
    expect(p).toHaveClass("text-danger");
    expect(p).toHaveAttribute("data-stock-status", "out");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("low stock: warning text", () => {
    render(<StockUrgency stock={3} />);
    expect(screen.getByText("Only 3 left in stock").parentElement).toHaveClass("text-warning");
  });

  test("in stock: success text; lowThreshold honoured", () => {
    const { rerender } = render(<StockUrgency stock={8} />);
    expect(screen.getByText("In stock").parentElement).toHaveClass("text-success");
    rerender(<StockUrgency stock={8} lowThreshold={10} />);
    expect(screen.getByText("Only 8 left in stock")).toBeInTheDocument();
  });

  test("invalid stock renders Out of stock, never throws", () => {
    render(<StockUrgency stock={Number.NaN} />);
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });

  test("no timers, no live region (D13)", () => {
    const html = renderToStaticMarkup(<StockUrgency stock={2} className="mt-1" />);
    expect(html).toContain("Only 2 left in stock");
    expect(html).toContain("mt-1");
    expect(html).not.toContain("role=");
    expect(html).not.toContain("aria-live");
    expect(html).not.toContain("style=");
  });
});

describe("StockUrgency Phase 3 look (T145)", () => {
  test.each([
    [0, "Out of stock", "bg-danger-subtle", "text-danger"],
    [4, "Only 4 left in stock", "bg-warning-subtle", "text-warning"],
    [40, "In stock", "bg-success-subtle", "text-success"],
  ])("stock %p: tinted status pill, meaning in text", (stock, label, bg, text) => {
    const { container } = render(<StockUrgency stock={stock} />);
    const p = container.querySelector("p");
    expect(p).toHaveClass("rounded-full", "w-fit", bg, text);
    expect(p?.textContent).toBe(label);
  });
});
