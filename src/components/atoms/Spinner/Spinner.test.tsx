import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Spinner } from "./Spinner";

describe("Spinner", () => {
  test("renders role=status with a visually hidden default label", () => {
    render(<Spinner />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading");
    const label = screen.getByText("Loading");
    expect(label).toHaveClass("sr-only");
  });

  test("accepts a custom label", () => {
    render(<Spinner label="Adding to cart" />);
    expect(screen.getByRole("status")).toHaveTextContent("Adding to cart");
  });

  test("icon is aria-hidden, spins, and is static under reduced motion", () => {
    render(<Spinner />);
    const icon = screen.getByTestId("spinner-icon");
    expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(icon).toHaveClass("animate-spin");
    expect(icon).toHaveClass("motion-reduce:animate-none");
  });

  test("applies size classes", () => {
    const { rerender } = render(<Spinner size="sm" />);
    expect(screen.getByTestId("spinner-icon")).toHaveClass("size-4");
    rerender(<Spinner size="lg" />);
    expect(screen.getByTestId("spinner-icon")).toHaveClass("size-8");
  });

  test("merges className last on the root", () => {
    render(<Spinner className="text-accent" />);
    expect(screen.getByRole("status").className.endsWith("text-accent")).toBe(true);
  });
});
