import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { LIFESTYLE_ART, LIFESTYLE_THREE_COLUMN_KEYS, type LifestyleArtKey } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import {
  LIFESTYLE_BANNERS_DEFAULT_HEADING,
  LIFESTYLE_BANNERS_GRID_CLASSES,
  LifestyleBanners,
  lifestyleBannerItems,
  normaliseLifestyleColumns,
  type LifestyleBannerItem,
} from "./LifestyleBanners";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>&amp; "q" ‮evil`;

const SLUGS: Record<LifestyleArtKey, string> = {
  living: "home-kitchen",
  dining: "home-kitchen",
  outdoor: "sports-outdoors",
  wardrobe: "clothing",
};

const item = (key: LifestyleArtKey): LifestyleBannerItem => ({
  blurb: `Ideas for ${key}.`,
  cta: { label: `Shop ${key}`, href: `/category/${SLUGS[key]}` },
  image: LIFESTYLE_ART[key],
});

const FOUR: LifestyleBannerItem[] = (["living", "dining", "outdoor", "wardrobe"] as const).map(item);
const THREE: LifestyleBannerItem[] = LIFESTYLE_THREE_COLUMN_KEYS.map(item);

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");
const hrefs = (d: ParentNode) => [...d.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");

let warn: ReturnType<typeof spyOn> | null = null;
function silence() {
  warn = spyOn(console, "warn").mockImplementation(() => {});
}
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

describe("LifestyleBanners: structure", () => {
  test("4 columns: section id, eyebrow + h2, ul of 4 li cards, one link each to /category/<slug>", () => {
    const d = parse(
      renderToStaticMarkup(
        <LifestyleBanners items={FOUR} columns={4} heading="Explore the season" eyebrow="Fresh ideas" id="home-lifestyle-cards" />,
      ),
    );
    const section = d.getElementById("home-lifestyle-cards");
    expect(section?.tagName).toBe("SECTION");
    expect(section?.getAttribute("aria-labelledby")).toBe("home-lifestyle-cards-heading");
    expect(d.getElementById("home-lifestyle-cards-heading")?.tagName).toBe("H2");
    expect(d.querySelector("h2")?.textContent).toBe("Explore the season");
    const eyebrow = d.querySelector("[data-eyebrow]");
    expect(eyebrow?.textContent).toBe("Fresh ideas");
    // eyebrow sits before the heading in DOM order
    expect(eyebrow?.compareDocumentPosition(d.querySelector("h2") as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    const lis = section?.querySelectorAll("ul > li") ?? [];
    expect(lis).toHaveLength(4);
    for (const li of lis) expect(li.querySelectorAll("a")).toHaveLength(1);
    expect(hrefs(d)).toEqual(["/category/home-kitchen", "/category/home-kitchen", "/category/sports-outdoors", "/category/clothing"]);
    for (const img of d.querySelectorAll("img")) {
      expect(img.getAttribute("alt")).toBe("");
      expect(img.getAttribute("width")).not.toBeNull();
      expect(img.getAttribute("height")).not.toBeNull();
      expect(img.getAttribute("loading")).toBe("lazy");
    }
  });

  test("grid degrades 4/2/1 and 3/2/1 (base one column for 320px)", () => {
    const four = parse(renderToStaticMarkup(<LifestyleBanners items={FOUR} columns={4} />)).querySelector("ul");
    expect(four?.className).toBe(LIFESTYLE_BANNERS_GRID_CLASSES[4]);
    expect(four?.className).toContain("grid-cols-1");
    expect(four?.className).toContain("sm:grid-cols-2");
    expect(four?.className).toContain("lg:grid-cols-4");
    expect(four?.className).toContain("min-w-0");
    const three = parse(renderToStaticMarkup(<LifestyleBanners items={THREE} columns={3} />)).querySelector("ul");
    expect(three?.className).toContain("grid-cols-1");
    expect(three?.className).toContain("sm:grid-cols-2");
    expect(three?.className).toContain("lg:grid-cols-3");
    expect(three?.getAttribute("data-columns")).toBe("3");
  });

  test("columns caps the card count (no second row); junk columns → 4", () => {
    expect(parse(renderToStaticMarkup(<LifestyleBanners items={FOUR} columns={3} />)).querySelectorAll("li")).toHaveLength(3);
    const junk = parse(renderToStaticMarkup(<LifestyleBanners items={[...FOUR, item("living")]} columns={7 as 4} />));
    expect(junk.querySelectorAll("li")).toHaveLength(4);
    expect(junk.querySelector("ul")?.getAttribute("data-columns")).toBe("4");
    for (const c of [0, 5, "3", null, undefined, Number.NaN]) expect(normaliseLifestyleColumns(c)).toBe(4);
    expect(normaliseLifestyleColumns(3)).toBe(3);
  });

  test("default heading when blank; no eyebrow element when blank; headingLevel 3 → card h4", () => {
    render(
      <LifestyleBanners
        items={FOUR.map((i, n) => ({ ...i, heading: `Card ${n}` }))}
        columns={4}
        heading="  "
        eyebrow="   "
        headingLevel={3}
      />,
    );
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(LIFESTYLE_BANNERS_DEFAULT_HEADING);
    expect(screen.getAllByRole("heading", { level: 4 })).toHaveLength(4);
    expect(document.querySelector("[data-eyebrow]")).toBeNull();
  });

  test("card headings default to h3 under the h2; never an h1", () => {
    const d = parse(
      renderToStaticMarkup(<LifestyleBanners items={FOUR.map((i) => ({ ...i, heading: "Living" }))} columns={4} headingLevel={1 as 2} />),
    );
    expect(d.querySelector("h1")).toBeNull();
    expect(d.querySelectorAll("h2")).toHaveLength(1);
    expect(d.querySelectorAll("h3")).toHaveLength(4);
  });

  test("blank id is ignored; heading id still unique per instance", () => {
    const d = parse(
      renderToStaticMarkup(
        <>
          <LifestyleBanners items={FOUR} columns={4} id="  " />
          <LifestyleBanners items={THREE} columns={3} />
        </>,
      ),
    );
    expect(d.querySelector("[id='']")).toBeNull();
    const ids = [...d.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of d.querySelectorAll("section")) {
      expect(d.getElementById(s.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
    }
  });
});

describe("LifestyleBanners: omit / validation (T154 AC2)", () => {
  test("cards with invalid hrefs are dropped; remaining ≥ 2 still render", () => {
    silence();
    const items: LifestyleBannerItem[] = [
      { ...FOUR[0]!, cta: { label: "Bad", href: "javascript:alert(1)" } },
      FOUR[1]!,
      { ...FOUR[2]!, cta: { label: "Ext", href: "https://evil.example/x" } },
      FOUR[3]!,
    ];
    const d = parse(renderToStaticMarkup(<LifestyleBanners items={items} columns={4} id="home-lifestyle-cards" />));
    expect(d.querySelectorAll("li")).toHaveLength(2);
    expect(hrefs(d)).toEqual(["/category/home-kitchen", "/category/clothing"]);
    for (const h of hrefs(d)) expect(isAllowedInternalHref(h)).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  test("renders nothing under 2 valid cards, for empty / non-array / junk input", () => {
    silence();
    const cases: unknown[] = [
      [],
      null,
      undefined,
      "cards",
      { length: 4 },
      [FOUR[0]],
      [FOUR[0], { ...FOUR[1]!, cta: { label: "x", href: "//evil.example" } }],
      [FOUR[0], { ...FOUR[1]!, cta: { label: "   ", href: "/deals" } }],
      [FOUR[0], { ...FOUR[1]!, cta: undefined }],
      [FOUR[0], null, 7, "x"],
    ];
    for (const items of cases) {
      expect(renderToStaticMarkup(<LifestyleBanners items={items as LifestyleBannerItem[]} columns={4} id="home-lifestyle-cards" heading="Explore" />)).toBe("");
      expect(lifestyleBannerItems(items, 4)).toEqual([]);
    }
  });

  test("an unsafe image path drops the image but keeps the card", () => {
    const items = [{ ...FOUR[0]!, image: { path: "javascript:alert(1)", width: 600, height: 450 } }, FOUR[1]!];
    const d = parse(renderToStaticMarkup(<LifestyleBanners items={items} columns={4} />));
    expect(d.querySelectorAll("li")).toHaveLength(2);
    expect(d.querySelectorAll("img")).toHaveLength(1);
  });
});

describe("LifestyleBanners: hostile text and markup", () => {
  test("hostile heading / eyebrow / card copy render as text", () => {
    const items = [{ ...FOUR[0]!, heading: HOSTILE, blurb: HOSTILE, cta: { label: HOSTILE, href: "/deals" } }, FOUR[1]!];
    const html = renderToStaticMarkup(<LifestyleBanners items={items} columns={4} heading={HOSTILE} eyebrow={HOSTILE} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    const d = parse(html);
    expect(d.querySelector("h2")?.textContent).toBe(HOSTILE);
    expect(d.querySelector("[data-eyebrow]")?.textContent).toBe(HOSTILE);
    expect(d.querySelector("a")?.textContent).toBe(HOSTILE);
  });

  test("tone passes through to the card surface; plain by default", () => {
    const d = parse(renderToStaticMarkup(<LifestyleBanners items={[{ ...FOUR[0]!, tone: "neutral" }, FOUR[1]!]} columns={4} />));
    const tones = [...d.querySelectorAll("li")].map((li) => li.getAttribute("data-promo-tone"));
    expect(tones).toEqual(["sunken", "plain"]);
  });

  test("links meet 44px; no inline style except images; no script; server component", () => {
    const html = renderToStaticMarkup(<LifestyleBanners items={FOUR} columns={4} />);
    const d = parse(html);
    for (const a of d.querySelectorAll("a")) expect(a.className).toContain("min-h-touch");
    for (const el of d.querySelectorAll("[style]")) expect(el.tagName).toBe("IMG");
    expect(d.querySelectorAll("script")).toHaveLength(0);
    const src = readFileSync(join(import.meta.dir, "LifestyleBanners.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toMatch(/\bstyle=\{/);
  });
});
