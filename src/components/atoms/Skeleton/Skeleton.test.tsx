import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render } from "@testing-library/react";
import { SKELETON_MAX_LINES, Skeleton } from "./Skeleton";

describe("Skeleton", () => {
  test("defaults to a single aria-hidden text line", () => {
    const { container } = render(<Skeleton />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("aria-hidden", "true");
    expect(root).toHaveAttribute("data-variant", "text");
    expect(root.querySelectorAll("[data-skeleton-line]")).toHaveLength(1);
  });

  test("renders N lines with a shorter last line", () => {
    const { container } = render(<Skeleton lines={3} />);
    const lines = container.querySelectorAll("[data-skeleton-line]");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toHaveClass("w-full");
    expect(lines[2]).toHaveClass("w-2/3");
  });

  test("clamps lines to at least 1", () => {
    const { container } = render(<Skeleton lines={0} />);
    expect(container.querySelectorAll("[data-skeleton-line]")).toHaveLength(1);
  });

  test("textSize maps to a token height", () => {
    const { container } = render(<Skeleton textSize="heading" />);
    expect(container.querySelector("[data-skeleton-line]")).toHaveClass("h-6");
  });

  test("rect maps width and height props to token classes", () => {
    const { container } = render(<Skeleton variant="rect" width="1/2" height="lg" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("w-1/2", "h-32", "rounded-md");
    expect(root).toHaveAttribute("aria-hidden", "true");
  });

  test("rect square uses aspect-square", () => {
    const { container } = render(<Skeleton variant="rect" height="square" />);
    expect(container.firstElementChild).toHaveClass("aspect-square", "w-full");
  });

  test("circle uses size classes and rounded-full", () => {
    const { container } = render(<Skeleton variant="circle" size="lg" />);
    expect(container.firstElementChild).toHaveClass("size-16", "rounded-full");
  });

  test("pulses only when motion is allowed", () => {
    const { container } = render(<Skeleton variant="rect" />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("bg-skeleton", "motion-safe:animate-pulse");
    expect(root).not.toHaveClass("animate-pulse");
  });

  test("forwards ref and merges className last", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<Skeleton ref={ref} variant="circle" className="mx-auto" />);
    expect(ref.current).toBe(container.firstElementChild as HTMLDivElement);
    expect(ref.current?.className.endsWith("mx-auto")).toBe(true);
  });

  test("is not focusable and has no accessible content", () => {
    const { container } = render(<Skeleton lines={2} />);
    expect(container.querySelector("[tabindex]")).toBeNull();
    expect(container.textContent).toBe("");
  });

  test("hostile lines: NaN -> 1, Infinity/huge -> capped at SKELETON_MAX_LINES", () => {
    const { container, rerender } = render(<Skeleton lines={Number.NaN} />);
    expect(container.querySelectorAll("[data-skeleton-line]")).toHaveLength(1);
    rerender(<Skeleton lines={Number.POSITIVE_INFINITY} />);
    expect(container.querySelectorAll("[data-skeleton-line]")).toHaveLength(SKELETON_MAX_LINES);
    rerender(<Skeleton lines={1e9} />);
    expect(container.querySelectorAll("[data-skeleton-line]")).toHaveLength(SKELETON_MAX_LINES);
  });
});
