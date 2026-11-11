import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { STORE_BADGE_DEFAULT_LABEL, StoreBadge, type StoreBadgeSize } from "./index";
import { PaymentMark } from "../PaymentMark";
import { TRADEMARK_RE, TRADEMARK_TERMS, scanFolders } from "./trademark-scan";

const ATOMS = join(import.meta.dir, "..");
const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

/** No link, button, form control, role, tabindex, image or handler in the markup. */
function expectNonInteractive(container: HTMLElement): void {
  expect(container.querySelectorAll("a, button, input, select, textarea, details, img, [href]").length).toBe(0);
  expect(container.querySelectorAll("[role]").length).toBe(0);
  expect(container.querySelectorAll("[tabindex]").length).toBe(0);
  for (const el of container.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) expect(attr).not.toMatch(/^on/i);
  }
}

describe("StoreBadge", () => {
  test("defaults: readable text 'Mobile app coming soon' in a neutral outlined pill", () => {
    const { container } = render(<StoreBadge />);
    expect(STORE_BADGE_DEFAULT_LABEL).toBe("Mobile app coming soon");
    const root = container.firstElementChild!;
    expect(root.tagName).toBe("SPAN");
    expect(root.textContent).toBe("Mobile app coming soon");
    for (const c of [
      "inline-flex", "rounded-full", "border", "border-border-strong", "bg-surface-raised",
      "text-text-primary", "text-small", "px-3",
    ]) expect(list(root)).toContain(c);
  });

  test("phone icon is a decorative svg from the Icon atom (aria-hidden, no title)", () => {
    const html = renderToStaticMarkup(<StoreBadge />);
    expect(html).toMatch(/^<span[^>]*><svg[^>]*aria-hidden="true"/);
    expect(html).not.toContain("<title");
    expect(html).not.toContain("<img");
  });

  test("label prop replaces the text; it is trimmed", () => {
    render(<StoreBadge label="  App for phones: coming soon  " />);
    expect(screen.getByText("App for phones: coming soon")).toBeTruthy();
  });

  test.each(["", "   ", "\n\t"])("blank label %j falls back to the default", (label) => {
    const { container } = render(<StoreBadge label={label} />);
    expect(container.textContent).toBe(STORE_BADGE_DEFAULT_LABEL);
  });

  test.each<[StoreBadgeSize, string[]]>([
    ["sm", ["text-caption", "px-2", "py-0.5", "gap-1"]],
    ["md", ["text-small", "px-3", "py-1", "gap-1.5"]],
  ])("size %s", (size, classes) => {
    const { container } = render(<StoreBadge size={size} />);
    const root = container.firstElementChild!;
    for (const c of classes) expect(list(root)).toContain(c);
  });

  test("className merges last; id and ref reach the span", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(<StoreBadge id="app" className="mt-2" ref={ref} />);
    const root = container.firstElementChild!;
    expect(list(root).at(-1)).toBe("mt-2");
    expect(root.id).toBe("app");
    expect(ref.current).toBe(root as HTMLSpanElement);
  });

  test("non-interactive: no link, button, role, tabindex, image or handler", () => {
    const { container } = render(<StoreBadge />);
    expectNonInteractive(container);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("not in the tab order: a span with no tabindex", () => {
    const { container } = render(<StoreBadge />);
    // A span with no tabindex is not in the sequential focus order.
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe("SPAN");
    expect(root.hasAttribute("tabindex")).toBe(false);
    expect(root.hasAttribute("contenteditable")).toBe(false);
  });

  test("hostile labels render as escaped text, never as markup or links", () => {
    const hostile = [
      "<script>alert(1)</script>",
      '"><img src=x onerror=alert(1)>',
      "javascript:alert(1)",
      "{{constructor.constructor('x')()}}",
    ];
    for (const label of hostile) {
      const html = renderToStaticMarkup(<StoreBadge label={label} />);
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("href=");
      const { container, unmount } = render(<StoreBadge label={label} />);
      expect(container.textContent).toBe(label);
      expectNonInteractive(container);
      unmount();
    }
  });

  test("wraps at 320px: shrinkable, wraps long words, no fixed width or touch sizing", () => {
    const long = "A".repeat(120);
    const { container } = render(
      <ul className="flex flex-wrap gap-2">
        <li><StoreBadge label={long} /></li>
        <li><PaymentMark label="Card" /></li>
      </ul>,
    );
    const root = container.querySelector("li > span")!;
    for (const c of ["max-w-full", "min-w-0", "wrap-anywhere"]) expect(list(root)).toContain(c);
    for (const c of list(root)) expect(c).not.toMatch(/^(w|min-w-touch|min-h-touch|size|whitespace-nowrap|truncate)(-|$)/);
    expect(container.textContent).toContain(long);
  });
});

describe("T132 AC2: no store or payment trademarks", () => {
  test("the runtime-built pattern does match the forbidden terms (self-check)", () => {
    expect(TRADEMARK_TERMS.length).toBe(7);
    for (const term of TRADEMARK_TERMS) {
      expect(TRADEMARK_RE.test(term)).toBe(true);
      expect(TRADEMARK_RE.test(term.toUpperCase())).toBe(true);
    }
    expect(TRADEMARK_RE.test("Mobile app coming soon")).toBe(false);
    expect(TRADEMARK_RE.test("Pay later: coming soon")).toBe(false);
  });

  test("finds nothing in the StoreBadge and PaymentMark folders' source (incl. tests)", () => {
    const { files, hits } = scanFolders([join(ATOMS, "StoreBadge"), join(ATOMS, "PaymentMark")]);
    expect(files).toBeGreaterThanOrEqual(6);
    expect(hits).toEqual([]);
  });

  test("default rendered text has no trademark", () => {
    expect(TRADEMARK_RE.test(renderToStaticMarkup(<StoreBadge />))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contrast (T132 AC4 and request bv), recomputed from globals.css and checked
// against the numbers stated in the atoms README.
// ---------------------------------------------------------------------------
const CSS = readFileSync(join(ATOMS, "..", "..", "app", "globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const ROOT_BLOCK = CSS.match(/^:root\s*\{([\s\S]*?)\}/m)?.[1] ?? "";
const README = readFileSync(join(ATOMS, "README.md"), "utf8");
const VARS: Record<string, string> = {};
for (const m of ROOT_BLOCK.matchAll(/--([a-z-]+):\s*\S([0-9a-fA-F]{6})\s*;/g)) VARS[m[1]!] = m[2]!;

function lum(hex6: string): number {
  const [r, g, b] = [0, 2, 4]
    .map((i) => Number.parseInt(hex6.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function ratio(fg: string, bg: string): number {
  const a = VARS[fg];
  const b = VARS[bg];
  if (!a || !b) throw new Error(`missing --${fg} or --${bg}`);
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("contrast pairs documented in the atoms README", () => {
  test.each<[string, string, number, number]>([
    ["text-primary", "surface-raised", 17.72, 4.5], // StoreBadge / PaymentMark text on their own fill
    ["border-strong", "surface-raised", 4.83, 3], // pill / rectangle edge
    ["border-strong", "surface-sunken", 4.4, 3], // edge on a grey footer band
    ["focus-ring", "accent-subtle", 4.75, 3], // (bv) FeedbackBlock band
  ])("%s on %s = %d (min %d)", (fg, bg, stated, min) => {
    const r = ratio(fg, bg);
    expect(r).toBeGreaterThanOrEqual(min);
    expect(r.toFixed(2)).toBe(stated.toFixed(2));
  });

  test("README rows exist for the placeholder atoms and the bv focus-ring pair", () => {
    expect(README).toMatch(/StoreBadge, PaymentMark text \| `?surface-raised`? \(own fill\) \| 17\.72/);
    expect(README).toMatch(/focus-ring \| accent-subtle \(FeedbackBlock band\) \| 4\.75/);
    expect(README).toContain("placeholder — replace with approved brand assets later");
  });
});
