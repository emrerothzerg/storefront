import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { join } from "node:path";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { PaymentMark, type PaymentMarkSize } from "./index";
import { TRADEMARK_RE, scanFolders } from "../StoreBadge/trademark-scan";

const ATOMS = join(import.meta.dir, "..");
const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

function expectNonInteractive(container: HTMLElement): void {
  expect(container.querySelectorAll("a, button, input, select, textarea, details, img, svg, [href]").length).toBe(0);
  expect(container.querySelectorAll("[role]").length).toBe(0);
  expect(container.querySelectorAll("[tabindex]").length).toBe(0);
  for (const el of container.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) expect(attr).not.toMatch(/^on/i);
  }
}

describe("PaymentMark", () => {
  let warn: Mock<typeof console.warn>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test.each(["Card", "Gift card", "Pay later: coming soon"])("renders %j as plain text in a neutral rounded rectangle", (label) => {
    const html = renderToStaticMarkup(<PaymentMark label={label} />);
    expect(html).toMatch(new RegExp(`^<span class="[^"]*">${label}</span>$`));
    const { container } = render(<PaymentMark label={label} />);
    const root = container.firstElementChild!;
    for (const c of [
      "inline-flex", "rounded-md", "border", "border-border-strong", "bg-surface-raised",
      "text-text-primary", "font-semibold",
    ]) expect(list(root)).toContain(c);
    expect(list(root)).not.toContain("rounded-full");
  });

  test.each<[PaymentMarkSize, string[]]>([
    ["sm", ["text-caption", "px-2", "py-0.5"]],
    ["md", ["text-small", "px-3", "py-1"]],
  ])("size %s", (size, classes) => {
    const { container } = render(<PaymentMark label="Card" size={size} />);
    for (const c of classes) expect(list(container.firstElementChild!)).toContain(c);
  });

  test("default size is md", () => {
    const { container } = render(<PaymentMark label="Card" />);
    expect(list(container.firstElementChild!)).toContain("text-small");
  });

  test("label is trimmed", () => {
    const { container } = render(<PaymentMark label="  Gift card " />);
    expect(container.textContent).toBe("Gift card");
  });

  test.each(["", "  ", "\t\n"])("blank label %j renders nothing and warns in development", (label) => {
    expect(renderToStaticMarkup(<PaymentMark label={label} />)).toBe("");
    expect(warn).toHaveBeenCalled();
  });

  test("className merges last; id and ref reach the span", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(<PaymentMark label="Card" id="pm" className="mt-1" ref={ref} />);
    const root = container.firstElementChild!;
    expect(list(root).at(-1)).toBe("mt-1");
    expect(root.id).toBe("pm");
    expect(ref.current).toBe(root as HTMLSpanElement);
  });

  test("non-interactive: no link, button, role, tabindex, image, icon or handler; not focusable", () => {
    const { container } = render(<PaymentMark label="Card" />);
    expectNonInteractive(container);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    // A span with no tabindex is not in the sequential focus order.
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("SPAN");
    expect(root.hasAttribute("tabindex")).toBe(false);
    expect(root.hasAttribute("contenteditable")).toBe(false);
  });

  test("hostile labels render as escaped text", () => {
    for (const label of ["<script>alert(1)</script>", '"><img src=x onerror=alert(1)>', "javascript:alert(1)"]) {
      const html = renderToStaticMarkup(<PaymentMark label={label} />);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("href=");
      const { container, unmount } = render(<PaymentMark label={label} />);
      expect(container.textContent).toBe(label);
      expectNonInteractive(container);
      unmount();
    }
  });

  test("wraps in a flex list at 320px: shrinkable, long words wrap, no fixed width", () => {
    const { container } = render(
      <ul className="flex flex-wrap gap-2" aria-label="Ways to pay">
        {["Card", "Gift card", "Pay later: coming soon", "B".repeat(100)].map((l) => (
          <li key={l}><PaymentMark label={l} /></li>
        ))}
      </ul>,
    );
    expect(screen.getAllByRole("listitem").length).toBe(4);
    for (const el of container.querySelectorAll("li > span")) {
      for (const c of ["max-w-full", "min-w-0", "wrap-anywhere"]) expect(list(el)).toContain(c);
      for (const c of list(el)) expect(c).not.toMatch(/^(w|size|min-w-touch|whitespace-nowrap|truncate)(-|$)/);
    }
  });

  test("T132 AC2: runtime-built trademark pattern finds nothing in either folder", () => {
    const { hits } = scanFolders([join(ATOMS, "PaymentMark"), join(ATOMS, "StoreBadge")]);
    expect(hits).toEqual([]);
    expect(TRADEMARK_RE.test(renderToStaticMarkup(<PaymentMark label="Pay later: coming soon" />))).toBe(false);
  });
});
