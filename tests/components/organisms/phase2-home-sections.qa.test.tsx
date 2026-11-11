// QA (QA-W4-organisms-D / T90): T88 HomeHero, CategoryGrid, BrandStrip, PromoBanner (+ cross-organism landmarks).
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn, CartActionFnV2 } from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import type { StockAlertActionFn } from "@/components/molecules/_contracts/stock-alert-actions";
import { BrandStrip, type BrandStripItem } from "@/components/organisms/BrandStrip";
import { BuyBox } from "@/components/organisms/BuyBox";
// (cj, T174) migrated off the deprecated `CategoryGrid` alias; the folder name stays.
import { CategoryRail, type CategoryRailItem } from "@/components/organisms/CategoryGrid";
import { DEAL_HEADING, HomeHero, parseIsoDate, type HomeHeroBanner, type HomeHeroDeal } from "@/components/organisms/HomeHero";
import { ListView } from "@/components/organisms/ListView";
import { PromoBanner, type PromoBannerCoupon } from "@/components/organisms/PromoBanner";
import { isAllowedInternalHref } from "@/content/routes";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "q" 's' ‮evil`;
const SRC = join(import.meta.dir, "../../../src/components/organisms");

let warn: ReturnType<typeof spyOn> | null = null;
function silence() {
  warn = spyOn(console, "warn").mockImplementation(() => {});
}
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

const html = (el: ReactElement) => renderToStaticMarkup(el);
const doc = (el: ReactElement) => new DOMParser().parseFromString(html(el), "text/html");
const hrefs = (d: ParentNode) => [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");

const BANNER: HomeHeroBanner = {
  title: "Autumn essentials",
  subtitle: "Cosy picks",
  eyebrow: "New season",
  cta: { label: "Shop deals", href: "/deals" },
  secondaryCta: { label: "Best sellers", href: "/best-sellers" },
};
const DEAL: HomeHeroDeal = {
  title: "QA Kettle",
  priceCents: 2999,
  listPriceCents: 3999,
  currency: "USD",
  href: "/products/qa-kettle",
  endsAt: "2026-11-30",
};
const CATS: CategoryRailItem[] = [
  { slug: "kitchen", name: "Kitchen", imageUrl: "/images/c/kitchen.jpg", productCount: 4 },
  { slug: "garden", name: "Garden" },
  { slug: "office", name: "Office", image: "/images/c/office.jpg" },
];
const BRANDS: BrandStripItem[] = [
  { slug: "northwind", name: "Northwind" },
  { slug: "acme", name: "Acme", logo: "/images/b/acme.svg" },
];
const COUPON: PromoBannerCoupon = { code: "save10", description: "10% off", minSubtotalCents: 2500, endsAt: "2026-12-01" };

// ---------------------------------------------------------------------------
describe("T88.1 each section returns null on empty / invalid data", () => {
  test("HomeHero: missing banner, non-object, blank / non-string title -> null", () => {
    for (const banner of [null, undefined, "x" as unknown as HomeHeroBanner, { title: "" }, { title: "   \n" }, { title: 42 as unknown as string }]) {
      expect(html(<HomeHero banner={banner} deal={DEAL} />)).toBe("");
    }
  });

  test("HomeHero: invalid deal (NaN cents, negative, fractional, bad currency, blank title, unsafe href) -> deal omitted, hero kept", () => {
    silence();
    const bad: Partial<HomeHeroDeal>[] = [
      { priceCents: Number.NaN },
      { priceCents: -1 },
      { priceCents: 12.5 },
      { currency: "" },
      { currency: "DOLLARS" },
      { currency: "US" },
      { title: "  " },
      { href: "https://evil.example" },
      { href: "javascript:alert(1)" },
      { href: "//evil.example" },
      { href: "/products/.." },
    ];
    for (const over of bad) {
      const out = html(<HomeHero banner={BANNER} deal={{ ...DEAL, ...over }} />);
      expect(out).toContain("Autumn essentials");
      expect(out).not.toContain(DEAL_HEADING);
    }
  });

  test("DEFECT D-T88-1: bad currency ('ZZZ', not ISO 4217) drops the deal / the minimum line", () => {
    expect(html(<HomeHero banner={BANNER} deal={{ ...DEAL, currency: "ZZZ" }} />)).not.toContain(DEAL_HEADING);
    expect(html(<PromoBanner coupon={{ ...COUPON, currency: "ZZZ" }} />)).not.toContain("Minimum order");
  });

  test("CategoryRail (was CategoryGrid): [], non-array, all-invalid -> null", () => {
    for (const categories of [[], null, "kitchen", { slug: "a" }, [{ slug: "", name: "X" }, { slug: "x", name: " " }, null]] as unknown[]) {
      expect(html(<CategoryRail categories={categories as CategoryRailItem[]} />)).toBe("");
    }
  });

  test("BrandStrip: [], non-array, all-invalid -> null", () => {
    for (const brands of [[], undefined, 7, [{ slug: " ", name: "A" }, { slug: "..", name: "B" }]] as unknown[]) {
      expect(html(<BrandStrip brands={brands as BrandStripItem[]} />)).toBe("");
    }
  });

  test("PromoBanner: missing coupon, blank / invalid code -> null", () => {
    for (const code of ["", "   ", "SAVE 10", "SAVE<10>", "x".repeat(33), "ÄBC", "save%20", 42 as unknown as string]) {
      expect(html(<PromoBanner coupon={{ ...COUPON, code }} />)).toBe("");
    }
    for (const coupon of [null, undefined, "SAVE10" as unknown as PromoBannerCoupon]) expect(html(<PromoBanner coupon={coupon} />)).toBe("");
  });
});

describe("T88.2 PromoBanner shows the code and conditions in text", () => {
  test("code upper-cased in <code>; description, minimum and end date as text; CTA to /cart", () => {
    const d = doc(<PromoBanner coupon={COUPON} />);
    expect(d.querySelector("code")?.textContent).toBe("SAVE10");
    expect(d.body.textContent).toContain("Use code SAVE10 at checkout");
    expect(d.body.textContent).toContain("10% off");
    const lis = [...d.querySelectorAll("li")].map((l) => l.textContent);
    expect(lis).toEqual(["Minimum order $25.00", "Ends Dec 1, 2026"]);
    expect(d.querySelector("time")?.getAttribute("datetime")).toBe("2026-12-01");
    expect(hrefs(d)).toEqual(["/cart"]);
  });

  for (const min of [0, -100, Number.NaN, 12.5, Number.MAX_SAFE_INTEGER + 2, null, undefined, Number.POSITIVE_INFINITY]) {
    test(`minSubtotalCents ${String(min)} -> no 'Minimum order'`, () => {
      expect(html(<PromoBanner coupon={{ ...COUPON, minSubtotalCents: min }} />)).not.toContain("Minimum order");
    });
  }

  for (const endsAt of ["2026-02-31", "2026-13-01", "2025-02-29", "2026-11-30T24:00:00Z", "2026-11-30T12:60:00Z", "tomorrow", "", "1764460800000", null, "2026-11-30T12:00:00+25:00"]) {
    test(`endsAt ${JSON.stringify(endsAt)} -> no 'Ends'`, () => {
      expect(html(<PromoBanner coupon={{ ...COUPON, endsAt }} />)).not.toMatch(/Ends/);
    });
  }

  test("valid ISO variants accepted (date-time Z, offset, leap day)", () => {
    expect(parseIsoDate("2028-02-29")).not.toBeNull();
    expect(html(<PromoBanner coupon={{ ...COUPON, endsAt: "2026-11-30T12:00:00Z" }} />)).toContain("Ends <time");
    expect(html(<PromoBanner coupon={{ ...COUPON, endsAt: "2026-11-30T12:00:00+02:00" }} />)).toContain("Nov 30, 2026");
  });

  test("unsafe cartHref falls back to /cart; hostile description / title as text", () => {
    silence();
    const d = doc(<PromoBanner coupon={{ ...COUPON, description: HOSTILE }} cartHref="javascript:alert(1)" title={HOSTILE} />);
    expect(hrefs(d)).toEqual(["/cart"]);
    expect(d.querySelector("img[src=x], script")).toBeNull();
    expect(d.body.textContent).toContain(HOSTILE);
  });
});

describe("T88.3 CategoryRail (was CategoryGrid) links to the real category slugs; T88.4 2 columns at base", () => {
  test("links /category/<slug> in input order; duplicates, blank and unsafe slugs dropped", () => {
    const d = doc(
      <CategoryRail
        categories={[
          ...CATS,
          { slug: "kitchen", name: "Kitchen again" },
          { slug: "", name: "Blank" },
          { slug: "..", name: "Dots" },
          { slug: "a/b", name: "Slash" },
          { slug: "javascript:alert(1)", name: "JS" },
        ]}
      />,
    );
    expect(hrefs(d)).toEqual(["/category/kitchen", "/category/garden", "/category/office"]);
    for (const h of hrefs(d)) expect(isAllowedInternalHref(h)).toBe(true);
    expect(d.body.textContent).not.toMatch(/Kitchen again|Blank|Dots|Slash|JS/);
  });

  // T152: CategoryGrid is now the CategoryRail alias (circular tiles in a no-JS keyboard-scrollable
  // ScrollRail) instead of a 2-column grid. The T88.4 intent (narrow screens never overflow, every
  // tile reachable) moves to: tiles live in a focusable scroll region; > 12 departments -> 12 tiles +
  // "All departments" -> /products (CONTRACTS H-6, H-7).
  test("rail: #home-categories holds a focusable scroll region with a list of circle tiles; > 12 -> 12 + All departments", () => {
    const d = doc(<CategoryRail id="home-categories" categories={CATS} />);
    const region = d.querySelector('#home-categories [role="region"][tabindex="0"]');
    expect(region === null ? null : "region").toBe("region");
    const tiles = [...(region?.querySelectorAll('ul a[data-shape="circle"]') ?? [])];
    expect(tiles.map((a) => a.getAttribute("href"))).toEqual(["/category/kitchen", "/category/garden", "/category/office"]);
    const many = Array.from({ length: 14 }, (_, i) => ({ slug: `dept-${i + 1}`, name: `Dept ${i + 1}` }));
    const dm = doc(<CategoryRail id="home-categories" categories={many} />);
    const links = [...dm.querySelectorAll('#home-categories [role="region"][tabindex="0"] ul a[data-shape="circle"]')];
    expect(links).toHaveLength(13);
    expect(links.slice(0, 12).map((a) => a.getAttribute("href"))).toEqual(many.slice(0, 12).map((c) => `/category/${c.slug}`));
    expect(links[12]?.getAttribute("href")).toBe("/products");
    expect(links[12]?.textContent).toContain("All departments");
  });

  test("hostile category name as text", () => {
    const d = doc(<CategoryRail categories={[{ slug: "x", name: HOSTILE }]} />);
    expect(d.querySelector("img[src=x], script")).toBeNull();
    expect(d.body.textContent).toContain(HOSTILE);
  });
});

describe("T88 BrandStrip", () => {
  test("44px links (min-h-touch) to /brand/<slug>; logo alt = name; text otherwise", () => {
    const d = doc(<BrandStrip brands={BRANDS} />);
    const links = [...d.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/brand/northwind", "/brand/acme"]);
    for (const a of links) expect(a.className).toMatch(/\bmin-h-touch\b/);
    expect(links[0]?.textContent).toBe("Northwind");
    expect(links[1]?.querySelector("img")?.getAttribute("alt")).toBe("Acme");
  });

  test("duplicates / unsafe dropped; hostile names text", () => {
    const d = doc(<BrandStrip brands={[...BRANDS, { slug: "acme", name: "Dup" }, { slug: "a/b", name: "S" }, { slug: "h", name: HOSTILE }]} />);
    expect(hrefs(d)).toEqual(["/brand/northwind", "/brand/acme", "/brand/h"]);
    expect(d.querySelector("img[src=x], script")).toBeNull();
    expect(d.body.textContent).toContain(HOSTILE);
  });
});

describe("T88 HomeHero", () => {
  // T151: a v3 slide has one CTA; the deprecated banner's `secondaryCta` is ignored silently (never rendered).
  test("CTA dropped for blank label (silently); secondaryCta never rendered, even when unsafe", () => {
    silence();
    const d = doc(
      <HomeHero
        banner={{ ...BANNER, cta: { label: "  ", href: "/deals" }, secondaryCta: { label: "Evil", href: "https://evil.example" } }}
      />,
    );
    expect(hrefs(d)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("CTA with an unsafe href is dropped with exactly one dev warning; the slide stays", () => {
    silence();
    const d = doc(<HomeHero banner={{ ...BANNER, cta: { label: "Go", href: "https://evil.example" }, secondaryCta: null }} />);
    expect(hrefs(d)).toEqual([]);
    expect(d.querySelector("h1")?.textContent).toBe("Autumn essentials");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("safe CTAs kept; every href allowed", () => {
    const d = doc(<HomeHero banner={BANNER} deal={DEAL} />);
    // T151: secondaryCta ("/best-sellers") is not part of a v3 slide.
    expect(hrefs(d)).toEqual(["/deals", "/products/qa-kettle"]);
    for (const h of hrefs(d)) expect(isAllowedInternalHref(h)).toBe(true);
  });

  test("deal card: savings text, end date, 'View deal: <title>' link", () => {
    const d = doc(<HomeHero banner={BANNER} deal={DEAL} />);
    const section = d.querySelector("section[aria-labelledby]") as HTMLElement;
    expect(section.textContent).toContain("You save $10.00");
    expect(section.textContent).toContain("Ends Nov 30, 2026");
    expect(section.querySelector("a")?.textContent).toBe("View deal: QA Kettle");
  });

  test("no savings text when list price <= price or invalid", () => {
    for (const listPriceCents of [2999, 1000, Number.NaN, -1, null]) {
      expect(html(<HomeHero banner={BANNER} deal={{ ...DEAL, listPriceCents }} />)).not.toContain("You save");
    }
  });

  // T151: the default is now level 1 (the hero headline is the home page's single h1, CONTRACTS H-1).
  test("headingLevel: default h1 hero + h2 deal; 2 -> h2 + h3", () => {
    const d1 = doc(<HomeHero banner={BANNER} deal={DEAL} />);
    expect(d1.querySelectorAll("h1")).toHaveLength(1);
    expect(d1.querySelector("h1")?.textContent).toBe("Autumn essentials");
    expect(d1.querySelector("h2")?.textContent).toBe(DEAL_HEADING);
    const d2 = doc(<HomeHero banner={BANNER} deal={DEAL} headingLevel={2} />);
    expect(d2.querySelector("h2")?.textContent).toBe("Autumn essentials");
    expect(d2.querySelector("h3")?.textContent).toBe(DEAL_HEADING);
    expect(d2.querySelector("h1")).toBeNull();
  });

  test("hostile banner / deal text as text", () => {
    const d = doc(<HomeHero banner={{ ...BANNER, title: HOSTILE, subtitle: HOSTILE, eyebrow: HOSTILE }} deal={{ ...DEAL, title: HOSTILE }} />);
    expect(d.querySelector("img[src=x], script")).toBeNull();
    expect(d.querySelector("h1")?.textContent).toBe(HOSTILE);
  });
});

describe("T88.1 headings unique + aria-labelledby inside own section; no script / inline style", () => {
  const all = () => (
    <main>
      <HomeHero banner={BANNER} deal={DEAL} headingLevel={1} />
      <CategoryRail categories={CATS} />
      <BrandStrip brands={BRANDS} />
      <PromoBanner coupon={COUPON} />
    </main>
  );

  test("heading texts unique across the four sections; each labelled section's heading is inside it", () => {
    const d = doc(all());
    const headings = [...d.querySelectorAll("h1,h2,h3,h4")].map((h) => h.textContent);
    expect(new Set(headings).size).toBe(headings.length);
    const labelled = [...d.querySelectorAll("[aria-labelledby]")];
    expect(labelled.length).toBe(4);
    for (const el of labelled) {
      const target = d.getElementById(el.getAttribute("aria-labelledby") ?? "");
      expect(target).not.toBeNull();
      expect(el.contains(target)).toBe(true);
    }
    const ids = [...d.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("no <script>, no inline style except next/image (img)", () => {
    const d = doc(all());
    expect(d.querySelectorAll("script")).toHaveLength(0);
    for (const el of d.querySelectorAll("[style]")) expect(el.tagName).toBe("IMG");
    for (const f of ["HomeHero/HomeHero.tsx", "CategoryGrid/CategoryRail.tsx", "BrandStrip/BrandStrip.tsx", "PromoBanner/PromoBanner.tsx"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src).not.toMatch(/\bstyle=\{/);
      expect(src).not.toMatch(/(?<![a-z]:)\b(?:w|min-w)-(?:\d{2,}|\[)/);
    }
  });

  test("every href rendered by the home sections passes isAllowedInternalHref", () => {
    for (const h of hrefs(doc(all()))) expect(isAllowedInternalHref(h)).toBe(true);
  });
});

describe("Cross-cutting: landmarks unique when BuyBox + ListView + the four home sections render together", () => {
  test("region / complementary / nav / form landmark names are unique; ids unique; one h1", () => {
    const fn = async () => null;
    const cartFn = fn as unknown as CartActionFn;
    const listFn = fn as unknown as ListActionFn;
    const d = doc(
      <main>
        <HomeHero banner={BANNER} deal={DEAL} headingLevel={1} />
        <CategoryRail categories={CATS} />
        <BrandStrip brands={BRANDS} />
        <PromoBanner coupon={COUPON} />
        <BuyBox
          product={{ id: "qa-p1", slug: "qa-p1", name: "QA", priceCents: 100, currency: "USD", stock: 2 }}
          actions={{
            addToCart: cartFn,
            buyNow: fn as unknown as CartActionFnV2,
            addToList: listFn,
            removeFromList: listFn,
            subscribeStockAlert: fn as unknown as StockAlertActionFn,
          }}
          viewer={{ inWishlist: false, alertRegistered: false }}
          delivery={{ estimate: null }}
        />
        <ListView
          mode="shared"
          headingLevel={2}
          shared={{ name: "Shared list", itemCount: 0, items: [] }}
          sort="added_desc"
          basePath="/lists/shared/tok"
        />
      </main>,
    );
    const name = (e: Element) =>
      e.getAttribute("aria-label") ?? d.getElementById(e.getAttribute("aria-labelledby") ?? "")?.textContent ?? "";
    const landmarks = [...d.querySelectorAll("section[aria-labelledby], section[aria-label], aside, nav, form[aria-label]")].map(
      (e) => `${e.tagName}:${name(e)}`,
    );
    expect(new Set(landmarks).size).toBe(landmarks.length);
    expect(d.querySelectorAll("aside")).toHaveLength(1);
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    const ids = [...d.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// Resume rulings: 44px targets, heading levels, no ids/tokens; home sections have no forms.
describe("Resume: home sections a11y basics", () => {
  const TOUCH = /\b(?:min-h-touch|size-touch|min-h-12)\b/;
  const page = (
    <main>
      <HomeHero banner={BANNER} deal={DEAL} headingLevel={1} />
      <CategoryRail categories={CATS} />
      <BrandStrip brands={BRANDS} />
      <PromoBanner coupon={COUPON} />
    </main>
  );

  test("every link meets 44px", () => {
    for (const a of doc(page).querySelectorAll("a")) {
      expect([a.textContent, TOUCH.test(a.getAttribute("class") ?? "")]).toEqual([a.textContent, true]);
    }
  });

  test("no forms (read-only sections); exactly one h1; heading levels never skip", () => {
    const d = doc(page);
    expect(d.querySelectorAll("form")).toHaveLength(0);
    const l = [...d.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
    expect(l.filter((x) => x === 1)).toHaveLength(1);
    expect(l[0]).toBe(1);
    for (let i = 1; i < l.length; i++) expect((l[i] ?? 0) - (l[i - 1] ?? 0)).toBeLessThanOrEqual(1);
  });

  test("decorative icons hidden; images have alt; no UUID / session data", () => {
    const d = doc(page);
    for (const svg of d.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
    for (const img of d.querySelectorAll("img")) expect(img.hasAttribute("alt")).toBe(true);
    expect(html(page)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|sessionId|ownerKey/i);
  });
});
