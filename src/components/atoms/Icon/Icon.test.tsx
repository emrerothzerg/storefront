import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { Icon, ICON_NAMES, type IconName } from "./Icon";

const REQUIRED: ReadonlyArray<IconName> = [
  "search", "cart", "heart", "heart-filled", "star", "star-filled", "star-half",
  "chevron-down", "chevron-up", "chevron-left", "chevron-right", "close", "menu",
  "user", "check", "check-circle", "minus", "plus", "share", "zoom-in", "trash",
  "info", "warning", "error-circle", "external-link", "filter", "sort", "list",
  "package", "location", "truck", "lock", "copy", "print", "arrow-up",
  "arrow-right", "question-circle", "thumbs-up", "columns", "refresh", "clock",
  "tag", "gift", "home", "grid", "eye", "eye-off", "mail", "phone",
];

describe("Icon", () => {
  test("ICON_NAMES contains every required name exactly once", () => {
    for (const name of REQUIRED) expect(ICON_NAMES).toContain(name);
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  test("every icon renders a 24x24 currentColor svg with at least one shape", () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
      expect(svg).toHaveAttribute("stroke", "currentColor");
      expect(svg).toHaveAttribute("fill", "none");
      expect(svg).toHaveAttribute("stroke-width", "2");
      expect(svg).toHaveAttribute("stroke-linecap", "round");
      expect(svg).toHaveAttribute("stroke-linejoin", "round");
      expect(svg).toHaveAttribute("data-icon", name);
      expect(svg?.querySelectorAll("path, circle, rect, polygon").length).toBeGreaterThan(0);
      // No hard-coded colours anywhere in the markup.
      expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      unmount();
    }
  });

  test("filled icons fill with currentColor; star-half fills only one half", () => {
    for (const name of ["heart-filled", "star-filled"] as const) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelector('[fill="currentColor"]')).not.toBeNull();
      unmount();
    }
    const { container } = render(<Icon name="star-half" />);
    const shapes = container.querySelectorAll("polygon");
    expect(shapes).toHaveLength(2);
    expect(shapes[0]).toHaveAttribute("fill", "currentColor");
    expect(shapes[1]).not.toHaveAttribute("fill");
    expect(container.innerHTML).not.toMatch(/gradient/i);
  });

  test("circle / circle-dot are appended at the end (order is stable)", () => {
    expect(ICON_NAMES.slice(-2)).toEqual(["circle", "circle-dot"]);
    expect(ICON_NAMES.indexOf("phone")).toBe(48);
    const { container, unmount } = render(<Icon name="circle" />);
    expect(container.querySelector('[fill="currentColor"]')).toBeNull();
    unmount();
    const dot = render(<Icon name="circle-dot" />).container;
    const circles = dot.querySelectorAll("circle");
    expect(circles).toHaveLength(2);
    expect(circles[1]).toHaveAttribute("fill", "currentColor");
  });

  test("outline icons do not fill", () => {
    const { container } = render(<Icon name="star" />);
    expect(container.querySelector('[fill="currentColor"]')).toBeNull();
  });

  test("decorative by default: aria-hidden, focusable=false, no role", () => {
    const { container } = render(<Icon name="cart" />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).not.toHaveAttribute("role");
    expect(svg?.querySelector("title")).toBeNull();
  });

  test("with title: role=img, <title>, labelled, not hidden", () => {
    render(<Icon name="warning" title="Warning" />);
    const img = screen.getByRole("img", { name: "Warning" });
    expect(img).not.toHaveAttribute("aria-hidden");
    const title = img.querySelector("title");
    expect(title).toHaveTextContent("Warning");
    expect(img).toHaveAttribute("aria-labelledby", title?.id);
  });

  test("whitespace-only title is treated as decorative", () => {
    const { container } = render(<Icon name="info" title="  " />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  test("sizes map to token classes (16/20/24px), default md", () => {
    const { container, rerender } = render(<Icon name="plus" />);
    expect(container.querySelector("svg")).toHaveClass("size-5");
    rerender(<Icon name="plus" size="sm" />);
    expect(container.querySelector("svg")).toHaveClass("size-4");
    rerender(<Icon name="plus" size="lg" />);
    expect(container.querySelector("svg")).toHaveClass("size-6");
  });

  test("merges className last and forwards ref", () => {
    const ref = createRef<SVGSVGElement>();
    const { container } = render(<Icon name="plus" className="text-accent" ref={ref} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")?.split(" ").at(-1)).toBe("text-accent");
    expect(ref.current).toBe(svg);
  });
});
