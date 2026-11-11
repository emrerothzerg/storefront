import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import {
  SERVICE_TILES_GRID_CLASSES,
  ServiceTiles,
  normaliseServiceTiles,
  safeServiceHref,
  type ServiceTileItem,
  type ServiceTilesTone,
} from "./ServiceTiles";

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

const TILES: readonly ServiceTileItem[] = [
  { label: "Track my order", href: "/orders", icon: "package" },
  { label: "Returns", href: "/returns", icon: "refresh" },
  { label: "Shipping", href: "/shipping", icon: "truck" },
  { label: "Help centre", href: "/help", icon: "info" },
  { label: "FAQ", href: "/faq", icon: "question-circle" },
  { label: "Contact us", href: "/contact", icon: "mail" },
];

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

function classesOf(el: Element | null | undefined): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

describe("ServiceTiles rendering", () => {
  test("renders a <ul> of tiles; each tile is one link to its service page", () => {
    render(<ServiceTiles tiles={TILES} />);
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("UL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(6);
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/orders",
      "/returns",
      "/shipping",
      "/help",
      "/faq",
      "/contact",
    ]);
    expect(screen.getByRole("link", { name: "Track my order" })).toBeTruthy();
    for (const li of within(list).getAllByRole("listitem")) {
      expect(li.querySelectorAll("a")).toHaveLength(1);
    }
  });

  test("every rendered href passes isAllowedInternalHref", () => {
    const { container } = render(<ServiceTiles tiles={TILES} />);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
  });

  test("empty tiles render nothing (even with a heading)", () => {
    expect(renderToStaticMarkup(<ServiceTiles tiles={[]} heading="Customer services" />)).toBe("");
  });

  test("no copy is hardcoded: without a heading the text is exactly the tile labels", () => {
    const { container } = render(<ServiceTiles tiles={TILES} />);
    expect(container.textContent).toBe(TILES.map((t) => t.label).join(""));
    expect(container.querySelector("h1, h2, h3, h4, section")).toBeNull();
  });

  test("hostile labels and headings render as text", () => {
    const hostile = `<img src=x onerror="alert(1)"><b>x</b>`;
    const html = renderToStaticMarkup(
      <ServiceTiles tiles={[{ label: hostile, href: "/faq", icon: "info" }]} heading={hostile} />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
    render(<ServiceTiles tiles={[{ label: hostile, href: "/faq" }]} />);
    expect(screen.getByRole("link", { name: hostile })).toBeTruthy();
  });

  test("icons are decorative; unknown icon names render no icon", () => {
    const { container } = render(
      <ServiceTiles
        tiles={[...TILES, { label: "Odd", href: "/about", icon: "nope" as unknown as ServiceTileItem["icon"] }]}
      />,
    );
    const svgs = Array.from(container.querySelectorAll("svg"));
    expect(svgs).toHaveLength(6);
    for (const svg of svgs) expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("link", { name: "Odd" })).toBeTruthy();
  });
});

describe("ServiceTiles heading", () => {
  test("heading (default h2) names the section; id passes through", () => {
    const { container } = render(<ServiceTiles tiles={TILES} heading="Customer services" id="home-services" />);
    const heading = screen.getByRole("heading", { level: 2, name: "Customer services" });
    const section = container.querySelector("section#home-services");
    expect(section).not.toBeNull();
    expect(section?.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(screen.getByRole("region", { name: "Customer services" })).toBe(section as HTMLElement);
  });

  test("visually hidden h3 with explicit headingId", () => {
    render(<ServiceTiles tiles={TILES} heading="Customer services" headingLevel={3} headingVisuallyHidden headingId="svc-h" />);
    const heading = screen.getByRole("heading", { level: 3, name: "Customer services" });
    expect(heading.id).toBe("svc-h");
    expect(classesOf(heading)).toContain("sr-only");
  });

  test("blank heading is treated as no heading", () => {
    const { container } = render(<ServiceTiles tiles={TILES} heading="   " />);
    expect(container.querySelector("section, h2")).toBeNull();
  });
});

describe("ServiceTiles href allowlist", () => {
  test.each(["javascript:alert(1)", "//evil.example", "https://evil.example/faq", "/nope", "faq", "/faq/"])(
    "tile with disallowed href %p is dropped and warns",
    (href) => {
      render(<ServiceTiles tiles={[{ label: "Bad", href }, { label: "FAQ", href: "/faq" }]} />);
      expect(screen.queryByText("Bad")).toBeNull();
      expect(screen.getAllByRole("link")).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    },
  );

  test("all tiles invalid renders nothing", () => {
    expect(renderToStaticMarkup(<ServiceTiles tiles={[{ label: "Bad", href: "javascript:alert(1)" }]} />)).toBe("");
  });

  test("safeServiceHref keeps query/fragment, rejects non-strings", () => {
    expect(safeServiceHref("/help?topic=returns#a")).toBe("/help?topic=returns#a");
    expect(safeServiceHref(42)).toBeNull();
    expect(safeServiceHref(undefined)).toBeNull();
  });
});

describe("ServiceTiles keyboard, nesting and layout", () => {
  test("no nested interactive elements and no extra tab stops", () => {
    const { container } = render(<ServiceTiles tiles={TILES} heading="Customer services" />);
    const anchors = Array.from(container.querySelectorAll("a"));
    for (const a of anchors) expect(a.querySelectorAll(FOCUSABLE)).toHaveLength(0);
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(anchors.length);
  });

  test("grid: 2 columns base, 3 at sm (640), 6 at lg (1024); no other column counts", () => {
    const { container } = render(<ServiceTiles tiles={TILES} />);
    const ul = container.querySelector("ul");
    expect(classesOf(ul)).toEqual(expect.arrayContaining(["grid", "grid-cols-2", "sm:grid-cols-3", "lg:grid-cols-6"]));
    expect(classesOf(ul).filter((c) => /grid-cols-/.test(c)).sort()).toEqual(
      ["grid-cols-2", "lg:grid-cols-6", "sm:grid-cols-3"],
    );
    expect(ul?.getAttribute("class")).toBe(SERVICE_TILES_GRID_CLASSES);
  });

  test("tile links fill the tile and have a >= 44px hit area", () => {
    const { container } = render(<ServiceTiles tiles={TILES} />);
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(classesOf(a)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch", "w-full", "h-full"]));
    }
  });

  test.each([
    ["accent-subtle", "bg-accent-subtle"],
    ["sunken", "bg-surface-sunken"],
  ] as const)("tone %p uses band token %p", (tone, cls) => {
    const { container } = render(<ServiceTiles tiles={TILES} tone={tone} className="extra" />);
    expect(classesOf(container.firstElementChild)).toEqual(expect.arrayContaining([cls, "extra", "w-full"]));
  });

  test("default band is accent-subtle; unknown runtime tone falls back to it", () => {
    const a = render(<ServiceTiles tiles={TILES} />);
    expect(classesOf(a.container.firstElementChild)).toContain("bg-accent-subtle");
    a.unmount();
    const b = render(<ServiceTiles tiles={TILES} tone={"neon" as unknown as ServiceTilesTone} />);
    expect(classesOf(b.container.firstElementChild)).toContain("bg-accent-subtle");
  });

  test("only role tokens, no arbitrary values", () => {
    expect(renderToStaticMarkup(<ServiceTiles tiles={TILES} heading="Services" />)).not.toMatch(/-\[/);
  });
});

describe("normaliseServiceTiles", () => {
  test("trims labels, drops blanks/malformed, unique keys for duplicates", () => {
    expect(normaliseServiceTiles(null)).toEqual([]);
    const input = [
      null,
      { label: "  ", href: "/faq" },
      { label: " FAQ ", href: "/faq", icon: "info" },
      { label: "FAQ", href: "/faq" },
    ] as unknown as ServiceTileItem[];
    const out = normaliseServiceTiles(input);
    expect(out.map((t) => t.label)).toEqual(["FAQ", "FAQ"]);
    expect(out[0]).toEqual({ key: "2:/faq", label: "FAQ", href: "/faq", icon: "info" });
    expect(new Set(out.map((t) => t.key)).size).toBe(2);
  });
});
