import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import { BenefitsStrip, normaliseBenefits, safeBenefitHref, type BenefitItem } from "./BenefitsStrip";

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

const ITEMS: readonly BenefitItem[] = [
  { id: "ship", label: "Free shipping over $35", icon: "truck", href: "/shipping" },
  { id: "track", label: "Track your order", icon: "package", href: "/orders" },
  { id: "returns", label: "Easy returns", icon: "refresh", href: "/returns" },
  { id: "help", label: "Help centre", icon: "question-circle", href: "/help" },
];

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("BenefitsStrip rendering", () => {
  test("renders a labelled <ul> with one <li> per item, links to the given hrefs", () => {
    render(<BenefitsStrip items={ITEMS} label="Store benefits" />);
    const list = screen.getByRole("list", { name: "Store benefits" });
    expect(list.tagName).toBe("UL");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/shipping", "/orders", "/returns", "/help"]);
    expect(screen.getByRole("link", { name: "Track your order" })).toBeTruthy();
  });

  test("every rendered href passes isAllowedInternalHref", () => {
    const { container } = render(<BenefitsStrip items={ITEMS} label="Benefits" />);
    const anchors = Array.from(container.querySelectorAll("a"));
    expect(anchors.length).toBe(4);
    for (const a of anchors) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("empty items render nothing", () => {
    expect(renderToStaticMarkup(<BenefitsStrip items={[]} label="Benefits" />)).toBe("");
  });

  test("items with only blank labels render nothing", () => {
    expect(renderToStaticMarkup(<BenefitsStrip items={[{ label: "   " }, { label: "" }]} label="Benefits" />)).toBe("");
  });

  test("no copy is hardcoded: the text content is exactly the item labels", () => {
    const { container } = render(<BenefitsStrip items={ITEMS} label="Benefits" />);
    expect(container.textContent).toBe(ITEMS.map((i) => i.label).join(""));
  });

  test("hostile label renders as text, never as HTML", () => {
    const hostile = `<img src=x onerror="alert(1)"><script>alert(2)</script>`;
    const html = renderToStaticMarkup(<BenefitsStrip items={[{ label: hostile, href: "/orders" }]} label="Benefits" />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    render(<BenefitsStrip items={[{ label: hostile }]} label="Benefits" />);
    expect(screen.getByText(hostile)).toBeTruthy();
  });

  test("icons are decorative (aria-hidden) and unknown icon names render no icon", () => {
    const { container } = render(
      <BenefitsStrip
        items={[...ITEMS, { label: "Bad icon", icon: "nope" as unknown as BenefitItem["icon"] }]}
        label="Benefits"
      />,
    );
    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs).toHaveLength(4);
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("BenefitsStrip links are optional and allow-listed", () => {
  test.each([
    "javascript:alert(1)",
    "//evil.example/orders",
    "https://evil.example",
    "/not-a-route",
    "orders",
    "/orders/",
  ])("disallowed href %p renders the item as text without a link and warns", (href) => {
    render(<BenefitsStrip items={[{ label: "Track your order", href }]} label="Benefits" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Track your order")).toBeTruthy();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("items without href are plain text; no warning", () => {
    render(<BenefitsStrip items={[{ label: "Free shipping over $35", icon: "truck" }]} label="Benefits" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("mixed: only items with valid hrefs become links", () => {
    render(
      <BenefitsStrip
        items={[{ label: "A" }, { label: "B", href: "/returns" }, { label: "C", href: "javascript:void(0)" }]}
        label="Benefits"
      />,
    );
    expect(screen.getAllByRole("link").map((a) => a.textContent)).toEqual(["B"]);
  });

  test("query strings and fragments on allowed paths are kept", () => {
    expect(safeBenefitHref("/help?topic=shipping#top")).toBe("/help?topic=shipping#top");
    expect(safeBenefitHref(null)).toBeNull();
    expect(safeBenefitHref(undefined)).toBeNull();
    expect(safeBenefitHref("")).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("BenefitsStrip keyboard and nesting", () => {
  test("no nested interactive elements inside links; scroller is not focusable when links exist", () => {
    const { container } = render(<BenefitsStrip items={ITEMS} label="Benefits" />);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(a.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    }
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(screen.queryByRole("region")).toBeNull();
  });

  test("without links the scroll container is a focusable named region (keyboard can scroll)", () => {
    const { container } = render(
      <BenefitsStrip items={[{ label: "Free shipping" }, { label: "Easy returns" }]} label="Store benefits" />,
    );
    const region = screen.getByRole("region", { name: "Store benefits" });
    expect(region.getAttribute("tabindex")).toBe("0");
    // the name is not announced twice
    expect(container.querySelector("ul")?.hasAttribute("aria-label")).toBe(false);
    expect(region.querySelectorAll(FOCUSABLE)).toHaveLength(0);
  });
});

describe("BenefitsStrip layout class audit", () => {
  function classesOf(el: Element | null | undefined): string[] {
    return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }

  test("single row that never wraps; scrolls inside its own container", () => {
    const { container } = render(<BenefitsStrip items={ITEMS} label="Benefits" className="extra" />);
    const scroller = container.firstElementChild;
    const ul = container.querySelector("ul");
    expect(classesOf(scroller)).toEqual(
      expect.arrayContaining(["overflow-x-auto", "max-w-full", "min-w-0", "w-full", "extra"]),
    );
    expect(classesOf(ul)).toEqual(
      expect.arrayContaining(["flex", "flex-nowrap", "w-max", "min-w-full", "lg:justify-between"]),
    );
    for (const li of Array.from(container.querySelectorAll("li"))) {
      expect(classesOf(li)).toContain("shrink-0");
      expect(classesOf(li.firstElementChild)).toContain("whitespace-nowrap");
    }
    expect(container.innerHTML).not.toMatch(/flex-wrap(?!-)|\bwrap\b/);
    expect(container.innerHTML).not.toMatch(/(^|\s)(sm|md|lg|xl):flex-wrap/);
  });

  test("focus room: the list is padded inside the scroller (p-1 = 4px >= 2px outline + 2px offset)", () => {
    const { container } = render(<BenefitsStrip items={ITEMS} label="Benefits" />);
    expect(classesOf(container.querySelector("ul"))).toContain("p-1");
  });

  test("targets are at least 44px tall (links and text items)", () => {
    const { container } = render(
      <BenefitsStrip items={[{ label: "A", href: "/orders" }, { label: "B" }]} label="Benefits" />,
    );
    for (const li of Array.from(container.querySelectorAll("li"))) {
      expect(classesOf(li.firstElementChild)).toContain("min-h-touch");
    }
  });

  test("only role tokens, no arbitrary values", () => {
    const html = renderToStaticMarkup(<BenefitsStrip items={ITEMS} label="Benefits" />);
    expect(html).not.toMatch(/-\[/);
  });
});

describe("normaliseBenefits", () => {
  test("trims, drops blanks, non-arrays and malformed entries", () => {
    expect(normaliseBenefits(null)).toEqual([]);
    expect(normaliseBenefits(undefined)).toEqual([]);
    const malformed = [null, { label: 3 }, { label: "  Hi  ", id: " x " }] as unknown as BenefitItem[];
    expect(normaliseBenefits(malformed)).toEqual([{ key: "2:x", label: "Hi", icon: null, href: null }]);
  });

  test("duplicate labels still get unique keys", () => {
    const keys = normaliseBenefits([{ label: "Same" }, { label: "Same" }]).map((b) => b.key);
    expect(new Set(keys).size).toBe(2);
  });
});
