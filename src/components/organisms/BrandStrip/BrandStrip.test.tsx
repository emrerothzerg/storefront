import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import {
  BRAND_STRIP_DEFAULT_TITLE,
  BRAND_STRIP_LIST_CLASSES,
  BRAND_STRIP_SCROLLER_CLASSES,
  BrandStrip,
  brandHref,
  brandStripItems,
  type BrandStripItem,
} from "./BrandStrip";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

const brands: BrandStripItem[] = [
  { slug: "acme", name: "Acme" },
  { slug: "globex", name: "Globex", logo: "/images/brands/globex.png" },
  { slug: "initech", name: "Initech", logo: "   " },
];

describe("BrandStrip: empty", () => {
  test("empty array returns null", () => {
    expect(renderToStaticMarkup(<BrandStrip brands={[]} />)).toBe("");
  });

  test("only invalid entries returns null", () => {
    expect(
      renderToStaticMarkup(
        <BrandStrip
          brands={[
            { slug: "", name: "No slug" },
            { slug: "x", name: "" },
            { slug: "../x", name: "Traversal" },
          ]}
        />,
      ),
    ).toBe("");
  });

  test("non-array input never throws", () => {
    const notArray = undefined as unknown as readonly BrandStripItem[];
    expect(renderToStaticMarkup(<BrandStrip brands={notArray} />)).toBe("");
  });
});

describe("BrandStrip: structure", () => {
  test("section labelled by its heading with one link per brand to /brand/<slug>", () => {
    render(<BrandStrip brands={brands} id="brands" />);
    const region = screen.getByRole("region", { name: BRAND_STRIP_DEFAULT_TITLE });
    expect(region.getAttribute("aria-labelledby")).toBe("brands-heading");
    expect(within(region).getByRole("heading", { level: 2 }).id).toBe("brands-heading");
    const links = within(region).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/brand/acme", "/brand/globex", "/brand/initech"]);
    for (const link of links) expect(isAllowedInternalHref(link.getAttribute("href") ?? "")).toBe(true);
  });

  test("logo brands are named by the logo alt; others by text; blank logo falls back to text", () => {
    render(<BrandStrip brands={brands} />);
    expect(screen.getByRole("link", { name: "Acme" })).toHaveTextContent("Acme");
    const globex = screen.getByRole("link", { name: "Globex" });
    expect(globex.querySelector("img")?.getAttribute("alt")).toBe("Globex");
    expect(screen.getByRole("link", { name: "Initech" })).toHaveTextContent("Initech");
  });

  test("custom title and heading level", () => {
    render(<BrandStrip brands={brands} title="Top brands" headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Top brands" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  test("blank title falls back to the default heading", () => {
    render(<BrandStrip brands={brands} title="   " />);
    expect(screen.getByRole("heading", { level: 2, name: BRAND_STRIP_DEFAULT_TITLE })).toBeInTheDocument();
  });

  // T155 (was: "wrapping list" pinned `flex-wrap` on the ul). Now a no-wrap
  // row scrolling inside its own container below `sm`, wrapping from `sm`.
  test("scroll row at 320px: list is no-wrap inside an overflow-x container; wraps from sm", () => {
    const { container } = render(<BrandStrip brands={brands} />);
    const list = container.querySelector("ul");
    const scroller = list?.parentElement;
    expect(list?.className).toBe(BRAND_STRIP_LIST_CLASSES);
    expect(list?.className.split(" ")).toEqual(expect.arrayContaining(["flex-nowrap", "w-max", "min-w-full", "sm:flex-wrap"]));
    expect(scroller?.className).toBe(BRAND_STRIP_SCROLLER_CLASSES);
    expect(scroller?.className.split(" ")).toEqual(expect.arrayContaining(["overflow-x-auto", "max-w-full"]));
    for (const li of container.querySelectorAll("li")) expect(li.className.split(" ")).toContain("shrink-0");
  });

  test("44px rounded tiles built from role tokens only", () => {
    render(<BrandStrip brands={brands} />);
    for (const link of screen.getAllByRole("link")) {
      const classes = link.className.split(" ");
      expect(classes).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch", "rounded-lg", "bg-surface-raised", "border-border-default"]));
      expect(link.className).not.toMatch(/\[|-(?:gray|white|black|blue|red)\b/);
    }
  });

  test("duplicates render once; slugs encoded", () => {
    const items = brandStripItems([
      { slug: "acme", name: "Acme" },
      { slug: "acme", name: "Acme 2" },
      { slug: "çà", name: "Encoded" },
    ]);
    expect(items.map((i) => i.href)).toEqual(["/brand/acme", brandHref("çà")]);
    expect(brandHref("çà")).toBe("/brand/%C3%A7%C3%A0");
  });
});

describe("BrandStrip: hostile text and markup", () => {
  test("hostile names render as text (also as logo alt)", () => {
    const html = renderToStaticMarkup(
      <BrandStrip brands={[{ slug: "x", name: HOSTILE }, { slug: "y", name: HOSTILE, logo: "/l.png" }]} title={HOSTILE} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
  });

  test("no script tags; no inline style outside the Image atom", () => {
    const html = renderToStaticMarkup(<BrandStrip brands={[{ slug: "acme", name: "Acme" }]} />);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/style="/);
  });

  test("no use client directive", () => {
    const src = readFileSync(join(import.meta.dir, "BrandStrip.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
  });
});
