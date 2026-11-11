import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { VisuallyHidden } from "./VisuallyHidden";

describe("VisuallyHidden", () => {
  test("renders a sr-only span that stays in the accessibility tree", () => {
    render(<VisuallyHidden>4 items in cart</VisuallyHidden>);
    const el = screen.getByText("4 items in cart");
    expect(el.tagName).toBe("SPAN");
    expect(el).toHaveClass("sr-only");
    expect(el).not.toHaveAttribute("aria-hidden");
  });

  test("as changes the element", () => {
    render(<VisuallyHidden as="h2">Filters</VisuallyHidden>);
    expect(screen.getByRole("heading", { level: 2, name: "Filters" })).toHaveClass("sr-only");
  });

  test("focusable skip link: anchor, focusable, becomes visible on focus", () => {
    render(
      <VisuallyHidden as="a" href="#main" focusable>
        Skip to main content
      </VisuallyHidden>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(link).toHaveAttribute("href", "#main");
    expect(link).toHaveClass("sr-only", "focus:not-sr-only", "focus:bg-surface-raised", "focus:z-toast");
    link.focus();
    expect(link).toHaveFocus();
  });

  test("without focusable there are no focus classes", () => {
    render(<VisuallyHidden>x</VisuallyHidden>);
    expect(screen.getByText("x").className).toBe("sr-only");
  });

  test("merges className last, passes attributes and ref", () => {
    const ref = createRef<HTMLElement>();
    render(
      <VisuallyHidden id="desc" className="extra" ref={ref}>
        y
      </VisuallyHidden>,
    );
    const el = screen.getByText("y");
    expect(el).toHaveAttribute("id", "desc");
    expect(el.className.split(" ").at(-1)).toBe("extra");
    expect(ref.current).toBe(el);
  });
});
