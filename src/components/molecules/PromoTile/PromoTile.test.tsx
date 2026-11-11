import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { DELIVERY_PROMO_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import {
  PROMO_TILE_SPAN_CLASSES,
  PromoTile,
  normalisePromoTileSpan,
  promoTileSpanClass,
  promoTileToneStyle,
  type PromoTileProps,
  type PromoTileSpan,
  type PromoTone,
} from "./index";

const FOCUSABLE =
  "a[href], button, input, select, textarea, summary, iframe, [tabindex]:not([tabindex='-1']), [contenteditable='true']";

const BASE: PromoTileProps = {
  heading: "Today's deals",
  blurb: "Fresh markdowns across every department.",
  cta: { label: "Shop deals", href: "/deals" },
  image: DELIVERY_PROMO_ART,
};

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

describe("PromoTile structure", () => {
  test("article named by its h3 heading, blurb, one CTA, decorative image", () => {
    const { container } = render(<PromoTile {...BASE} />);
    const article = screen.getByRole("article", { name: BASE.heading });
    expect(article.tagName).toBe("ARTICLE");
    expect(screen.getByRole("heading", { level: 3, name: BASE.heading })).toBeTruthy();
    expect(article.textContent).toContain(BASE.blurb ?? "");
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Shop deals" }).getAttribute("href")).toBe("/deals");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  test("one focusable element, no nested links, stretched overlay covers the tile", () => {
    const { container } = render(<PromoTile {...BASE} />);
    expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(1);
    expect(container.querySelector("a a")).toBeNull();
    const link = container.querySelector("a");
    expect(classesOf(link)).toEqual(expect.arrayContaining(["after:absolute", "after:inset-0"]));
    expect(classesOf(container.firstElementChild)).toContain("relative");
    expect(link?.getAttribute("aria-describedby")).toBe(container.querySelector("h3")?.id ?? "missing");
  });

  test("fits a product-grid cell: full height/width, min-w-0, equal-height rows", () => {
    const { container } = render(<PromoTile {...BASE} />);
    expect(classesOf(container.firstElementChild)).toEqual(
      expect.arrayContaining(["h-full", "w-full", "min-w-0", "flex", "flex-col"]),
    );
  });

  test("contract L-17: one link that passes isAllowedInternalHref; never h1/h2 by default", () => {
    const html = renderToStaticMarkup(<PromoTile {...BASE} />);
    expect(html).not.toMatch(/<h[12]/);
    const { container } = render(<PromoTile {...BASE} />);
    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(1);
    expect(isAllowedInternalHref(links[0]?.getAttribute("href") ?? "")).toBe(true);
  });
});

describe("PromoTile span", () => {
  test("span helpers: 1 and 2 only, junk → 1", () => {
    expect(normalisePromoTileSpan(1)).toBe(1);
    expect(normalisePromoTileSpan(2)).toBe(2);
    for (const bad of [0, 3, 4, -1, "2", null, undefined, Number.NaN]) expect(normalisePromoTileSpan(bad)).toBe(1);
    expect(promoTileSpanClass(2)).toBe("col-span-2");
    expect(promoTileSpanClass("x")).toBe("col-span-1");
    expect(PROMO_TILE_SPAN_CLASSES).toEqual({ 1: "col-span-1", 2: "col-span-2" });
  });

  test("as li: is a list item carrying its own column span", () => {
    const { container } = render(
      <ul>
        <PromoTile {...BASE} as="li" span={2} />
        <PromoTile {...BASE} as="li" />
      </ul>,
    );
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(classesOf(items[0])).toContain("col-span-2");
    expect(classesOf(items[1])).toContain("col-span-1");
    expect(container.querySelector("article")).toBeNull();
    expect(items[0]?.getAttribute("data-promo-span")).toBe("2");
  });

  test("as article: no column-span class (the caller's cell gets promoTileSpanClass)", () => {
    const { container } = render(<PromoTile {...BASE} span={2} />);
    const root = classesOf(container.firstElementChild);
    expect(root).not.toContain("col-span-2");
    expect(container.firstElementChild?.getAttribute("data-promo-span")).toBe("2");
  });

  test("span 2 with an image sits side by side from sm; span 1 stays stacked", () => {
    const wide = render(<PromoTile {...BASE} span={2} />);
    expect(classesOf(wide.container.firstElementChild)).toContain("sm:flex-row");
    expect(classesOf(wide.container.querySelector("[data-promo-image]"))).toContain("sm:w-1/2");
    wide.unmount();
    const narrow = render(<PromoTile {...BASE} />);
    expect(classesOf(narrow.container.firstElementChild)).not.toContain("sm:flex-row");
  });

  test("span 2 with art: art and copy vertically centred, roomier padding, CTA right under the copy (T178)", () => {
    const wide = render(<PromoTile {...BASE} span={2} />);
    expect(classesOf(wide.container.firstElementChild)).toContain("sm:items-center");
    const body = wide.container.querySelector("[data-promo-body]");
    expect(classesOf(body)).toEqual(expect.arrayContaining(["justify-center", "sm:p-6"]));
    expect(classesOf(wide.container.querySelector("a"))).toContain("mt-2");
    expect(classesOf(wide.container.querySelector("a"))).not.toContain("mt-auto");
    wide.unmount();
    for (const props of [{ span: 1 as const }, { span: 2 as const, image: null }]) {
      const r = render(<PromoTile {...BASE} {...props} />);
      expect(classesOf(r.container.firstElementChild)).not.toContain("sm:items-center");
      expect(classesOf(r.container.querySelector("a"))).toContain("mt-auto");
      r.unmount();
    }
  });

  test("unknown span renders as 1 without throwing", () => {
    const bogus = 3 as unknown as PromoTileSpan;
    const { container } = render(<PromoTile {...BASE} as="li" span={bogus} />);
    expect(classesOf(container.firstElementChild)).toContain("col-span-1");
  });
});

describe("PromoTile tones", () => {
  test.each([
    ["primary", "bg-accent"],
    ["primary-subtle", "bg-accent-subtle"],
    ["neutral", "bg-surface-sunken"],
    ["accent", "bg-promo"],
  ] as const)("%s → %s", (tone, bg) => {
    const { container } = render(<PromoTile {...BASE} tone={tone} />);
    expect(classesOf(container.firstElementChild)).toContain(bg);
    expect(classesOf(container.querySelector("a"))).toContain(tone === "primary" ? "bg-surface-raised" : "bg-accent");
  });

  test("primary is the brand-blue surface with white heading/text and the white CTA pill, never near-black (T178)", () => {
    const { container } = render(<PromoTile {...BASE} tone="primary" span={2} />);
    const root = container.firstElementChild;
    expect(root?.getAttribute("data-promo-tone")).toBe("accent");
    expect(classesOf(root)).not.toContain("bg-surface-inverse");
    expect(classesOf(container.querySelector("h3"))).toContain("text-text-inverse");
    expect(promoTileToneStyle("primary")).toEqual({ card: "accent", heading: "inverse", text: "inverse", cta: "inverse", inverse: true });
    expect(promoTileToneStyle("accent").card).toBe("promo");
    expect(promoTileToneStyle("bogus").card).toBe("sunken");
  });

  test("default tone is primary-subtle; unknown tone → neutral, no throw", () => {
    const def = render(<PromoTile {...BASE} />);
    expect(classesOf(def.container.firstElementChild)).toContain("bg-accent-subtle");
    def.unmount();
    const bogus = "neon" as unknown as PromoTone;
    const { container } = render(<PromoTile {...BASE} tone={bogus} />);
    expect(classesOf(container.firstElementChild)).toContain("bg-surface-sunken");
  });
});

describe("PromoTile CTA, heading and image edge cases", () => {
  test.each(["https://evil.example", "//evil.example", "javascript:alert(1)", "/not-a-route", ""])(
    "invalid href %p: tile still renders, no link",
    (href) => {
      const { container } = render(<PromoTile {...BASE} cta={{ label: "Shop deals", href }} />);
      expect(screen.getByRole("heading", { name: BASE.heading })).toBeTruthy();
      expect(container.querySelectorAll(FOCUSABLE)).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    },
  );

  test("heading level prop: 4 honoured, 1 coerced to 3", () => {
    expect(renderToStaticMarkup(<PromoTile heading="A" headingLevel={4} />)).toContain("<h4");
    const one = 1 as unknown as 3;
    const html = renderToStaticMarkup(<PromoTile heading="A" headingLevel={one} />);
    expect(html).not.toContain("<h1");
    expect(html).toContain("<h3");
  });

  test("no image: text body fills the tile; span 2 without image does not switch to row", () => {
    const { container } = render(<PromoTile {...BASE} image={null} span={2} />);
    expect(container.querySelector("img")).toBeNull();
    expect(classesOf(container.firstElementChild)).not.toContain("sm:flex-row");
    expect(classesOf(container.querySelector("[data-promo-body]"))).toEqual(expect.arrayContaining(["flex-1", "min-w-0"]));
  });

  test("hostile text renders as text; blank heading renders nothing", () => {
    const hostile = `<script>alert("x")</script><a href="https://evil.example">x</a>`;
    const html = renderToStaticMarkup(<PromoTile heading={hostile} blurb={hostile} cta={{ label: hostile, href: "/deals" }} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain('href="https://evil.example"');
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(renderToStaticMarkup(<PromoTile heading="  " cta={BASE.cta} />)).toBe("");
  });

  test("320px: heading, blurb and CTA wrap", () => {
    const { container } = render(<PromoTile {...BASE} />);
    expect(classesOf(container.querySelector("h3"))).toContain("break-words");
    expect(classesOf(container.querySelector("p"))).toContain("break-words");
    expect(classesOf(container.querySelector("a"))).toEqual(expect.arrayContaining(["break-words", "max-w-full"]));
  });
});
