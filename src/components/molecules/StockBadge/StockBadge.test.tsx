import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { LOW_STOCK_THRESHOLD, StockBadge, getStockStatus } from "./StockBadge";

describe("getStockStatus", () => {
  test("threshold constant is 5", () => {
    expect(LOW_STOCK_THRESHOLD).toBe(5);
  });

  test("0 is out of stock", () => {
    expect(getStockStatus(0, 5)).toEqual({ status: "out", label: "Out of stock" });
  });

  test.each([-1, -100, Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, 2.5, 0.1])(
    "invalid stock %p is treated as out of stock",
    (stock) => {
      expect(getStockStatus(stock, 5).status).toBe("out");
    },
  );

  test.each([1, 2, 3, 4, 5])("%p is low stock with 'Only N left'", (stock) => {
    expect(getStockStatus(stock, LOW_STOCK_THRESHOLD)).toEqual({
      status: "low",
      label: `Only ${stock} left`,
    });
  });

  test.each([6, 7, 100, 1_000_000])("%p is in stock", (stock) => {
    expect(getStockStatus(stock, LOW_STOCK_THRESHOLD)).toEqual({
      status: "in",
      label: "In stock",
    });
  });

  test("threshold defaults to LOW_STOCK_THRESHOLD", () => {
    expect(getStockStatus(5).status).toBe("low");
    expect(getStockStatus(6).status).toBe("in");
  });

  test("custom threshold moves the low/in boundary", () => {
    expect(getStockStatus(10, 10).status).toBe("low");
    expect(getStockStatus(11, 10).status).toBe("in");
    expect(getStockStatus(1, 0).status).toBe("in");
  });

  test("invalid threshold falls back to the default", () => {
    expect(getStockStatus(5, Number.NaN).status).toBe("low");
    expect(getStockStatus(5, -3).status).toBe("low");
    expect(getStockStatus(6, 2.5).status).toBe("in");
  });
});

describe("StockBadge", () => {
  test("0 renders 'Out of stock' with the danger tone", () => {
    render(<StockBadge stock={0} />);
    expect(screen.getByText("Out of stock")).toHaveClass("bg-danger-subtle", "text-danger");
  });

  test("negative stock renders 'Out of stock'", () => {
    render(<StockBadge stock={-4} />);
    expect(screen.getByText("Out of stock")).toHaveClass("text-danger");
  });

  test("1..5 renders 'Only N left' with the warning tone", () => {
    for (let n = 1; n <= LOW_STOCK_THRESHOLD; n++) {
      const { unmount } = render(<StockBadge stock={n} />);
      expect(screen.getByText(`Only ${n} left`)).toHaveClass("bg-warning-subtle", "text-warning");
      unmount();
    }
  });

  test("above the threshold renders 'In stock' with the success tone", () => {
    render(<StockBadge stock={LOW_STOCK_THRESHOLD + 1} />);
    expect(screen.getByText("In stock")).toHaveClass("bg-success-subtle", "text-success");
  });

  test("honours a custom lowStockThreshold", () => {
    render(<StockBadge stock={8} lowStockThreshold={10} />);
    expect(screen.getByText("Only 8 left")).toBeInTheDocument();
  });

  test("passes extra props through to the Badge", () => {
    render(<StockBadge stock={3} className="self-start" data-testid="sb" />);
    const el = screen.getByTestId("sb");
    expect(el).toHaveClass("self-start");
    expect(el).toHaveAttribute("data-stock-status", "low");
  });
});

describe("StockBadge Phase 3 look (T145)", () => {
  test.each([
    [0, "Out of stock", "bg-danger-subtle", "text-danger", "error-circle"],
    [3, "Only 3 left", "bg-warning-subtle", "text-warning", "warning"],
    [9, "In stock", "bg-success-subtle", "text-success", "check-circle"],
  ])("stock %p: pill with role tint, decorative %s icon, status as text", (stock, label, bg, text, icon) => {
    const { container } = render(<StockBadge stock={stock} />);
    const badge = screen.getByText(label);
    expect(badge).toHaveClass("rounded-full", bg, text);
    expect(badge).toHaveTextContent(new RegExp(`^${label}$`));
    const svg = container.querySelector(`svg[data-icon="${icon}"]`);
    expect(svg).not.toBeNull();
    expect(svg?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  test("shape can still be overridden (square tags)", () => {
    render(<StockBadge stock={9} shape="square" />);
    expect(screen.getByText("In stock")).toHaveClass("rounded-sm");
  });
});
