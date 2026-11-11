// QA (T163, Phase 3 wave B1): home organisms — HomeHero v3 (T151), CategoryRail + CategoryDiscovery
// (T152), ProductRail tabs (T153), PromoBanner / PromoBannerPair / LifestyleBanners (T154), BrandStrip +
// ServicesBand (T155) — against BACKLOG-phase3 T151–T155 and T163 AC1–4 and CONTRACTS.md H-1, H-3,
// H-6 … H-11, H-13 … H-17, H-19, H-21, H-25.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandStrip } from "@/components/organisms/BrandStrip";
import { CATEGORY_DISCOVERY_MAX_TILES, CategoryDiscovery } from "@/components/organisms/CategoryDiscovery";
import {
  CATEGORY_RAIL_ALL_HREF,
  CATEGORY_RAIL_ALL_LABEL,
  CATEGORY_RAIL_MAX_TILES,
  CategoryRail,
} from "@/components/organisms/CategoryGrid";
// (cj, T174) namespace import so the alias check survives the alias removal.
import * as railModule from "@/components/organisms/CategoryGrid";
import { DEAL_HEADING, HOME_HERO_MAX_SLIDES, HomeHero, type HomeHeroDeal } from "@/components/organisms/HomeHero";
import { LifestyleBanners, type LifestyleBannerItem } from "@/components/organisms/LifestyleBanners";
import { PRODUCT_RAIL_EMPTY_TAB_TEXT, ProductRail, RAIL_PARAM_MAX_LENGTH, resolveRailTab } from "@/components/organisms/ProductRail";
import { PromoBanner, PromoBannerPair, type PromoBannerContent } from "@/components/organisms/PromoBanner";
import { SERVICES_BAND_DEFAULT_TILES, ServicesBand } from "@/components/organisms/ServicesBand";
import type { HeroSlide } from "@/components/molecules/HeroBanner";
import { DELIVERY_PROMO_ART, HERO_SLIDE_ART, LIFESTYLE_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import { expectNotNull, expectNull } from "@/test/dom-assertions";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; ‮rtl`;
const APP = join(import.meta.dir, "../../../src/app");
const BRAND_WORDS = [["k", "mart"], ["one", "pass"], ["after", "pay"], ["zip", " pay"], ["app", " store"], ["google", " play"]].map((p) =>
  p.join(""),
);
const DARK_VARIANT = ["da", "rk:"].join("");
const TOUCH = /(^|\s)(min-h-touch|size-touch|h-touch)(\s|$)/;

let warnSpy: ReturnType<typeof spyOn> | null = null;
function silenceWarn(): ReturnType<typeof spyOn> {
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  return warnSpy;
}
afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = null;
});

const html = (el: ReactElement): string => renderToStaticMarkup(el);
const doc = (el: ReactElement): Document => new DOMParser().parseFromString(html(el), "text/html");

/** All page.tsx route patterns under src/app. */
function appRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === "page.tsx") {
        const rel = relative(APP, dir).split("/").filter((s) => s !== "" && !s.startsWith("(") && !s.startsWith("_"));
        out.push(`/${rel.join("/")}`);
      }
    }
  };
  walk(APP);
  return out;
}
const ROUTES = appRoutes();
function routeExists(href: string): boolean {
  const segs = (href.split(/[?#]/)[0] ?? "").split("/").filter(Boolean);
  return ROUTES.some((route) => {
    const r = route.split("/").filter(Boolean);
    return r.length === segs.length && r.every((s, i) => s.startsWith("[") || s === segs[i]);
  });
}

// ---- fixtures ----
function slide(n: number, over: Partial<HeroSlide> = {}): HeroSlide {
  const image = HERO_SLIDE_ART[(n - 1) % HERO_SLIDE_ART.length];
  if (image === undefined) throw new Error("no hero art");
  return { id: `s${n}`, headline: `Slide headline ${n}`, subline: `Sub ${n}`, cta: { label: `Shop ${n}`, href: "/deals" }, image, ...over };
}
const SLIDES3 = [slide(1), slide(2), slide(3)];
const DEAL: HomeHeroDeal = {
  title: "Ceramic pour-over set",
  priceCents: 1250,
  listPriceCents: 2000,
  currency: "USD",
  href: "/products/ceramic-pour-over-set",
  endsAt: "2026-11-30T00:00:00Z",
};
const depts = (n: number) => Array.from({ length: n }, (_, i) => ({ slug: `dept-${i + 1}`, name: `Department ${i + 1}` }));

function product(n: number, over: Partial<Product> = {}): Product {
  return {
    id: `qa-p${n}`,
    slug: `qa-product-${n}`,
    name: `QA Product ${n}`,
    description: "",
    priceCents: 1000 + n,
    currency: "USD",
    imageUrl: `/images/qa-${n}.jpg`,
    stock: 5,
    ...over,
  };
}
const TAB_IDS = ["best-sellers", "deals", "new-arrivals", "top-rated"] as const;
const TAB_LABELS = ["Best sellers", "Deals", "New arrivals", "Top rated"];
const TABS = TAB_IDS.map((id, i) => ({ id, label: TAB_LABELS[i] ?? id, href: `/?rail=${id}#top-picks` }));
const quickAdd = { action: async () => null };

function promo(heading: string, href: string, over: Partial<PromoBannerContent> = {}): PromoBannerContent {
  return { heading, blurb: `${heading} blurb`, cta: { label: `Shop ${heading}`, href }, ...over };
}
function lifestyle(n: number, href = `/category/dept-${n}`): LifestyleBannerItem {
  const art = [LIFESTYLE_ART.living, LIFESTYLE_ART.dining, LIFESTYLE_ART.outdoor, LIFESTYLE_ART.wardrobe][(n - 1) % 4];
  return { heading: `Idea ${n}`, blurb: `Blurb ${n}`, cta: { label: `Shop idea ${n}`, href }, image: art ?? null };
}

// --------------------------------------------------------------------------------------------
describe("HomeHero v3 (T151 AC1–2; H-1, H-8 … H-11; T163 AC4)", () => {
  test("0 slides -> nothing (deal included); all-invalid slides -> nothing", () => {
    expect(html(<HomeHero slides={[]} deal={DEAL} />)).toBe("");
    silenceWarn();
    expect(html(<HomeHero slides={[slide(1, { headline: "   " }), slide(2, { headline: "" })]} deal={DEAL} />)).toBe("");
  });

  test("1 slide: region/carousel #home-hero, h1 = headline, no dot links", () => {
    const d = doc(<HomeHero slides={[slide(1)]} />);
    const region = d.getElementById("home-hero");
    expect(region?.getAttribute("role")).toBe("region");
    expect(region?.getAttribute("aria-roledescription")).toBe("carousel");
    expect(d.querySelectorAll("h1")).toHaveLength(1);
    expect(d.querySelector("h1")?.textContent).toBe("Slide headline 1");
    expect(d.querySelectorAll('a[href^="#slide-"]')).toHaveLength(0);
  });

  test("3 slides: named region; h1 is the first slide only; slides '1 of 3'…; 3 dots, one aria-current", () => {
    render(<HomeHero slides={SLIDES3} />);
    const region = screen.getByRole("region", { name: /.+/ });
    expect(region.id).toBe("home-hero");
    expect(region.getAttribute("aria-roledescription")).toBe("carousel");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s.map((h) => h.textContent)).toEqual(["Slide headline 1"]);
    expect(region.contains(h1s[0] ?? null)).toBe(true);
    const slideLabels = [...region.querySelectorAll('[aria-roledescription="slide"]')].map((el) => el.getAttribute("aria-label"));
    expect(slideLabels).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    const dots = [...region.querySelectorAll('a[href^="#slide-"]')];
    expect(dots.map((a) => a.getAttribute("href"))).toEqual(["#slide-1", "#slide-2", "#slide-3"]);
    expect(dots.map((a) => a.getAttribute("aria-label") ?? a.textContent)).toEqual(["Slide 1 of 3", "Slide 2 of 3", "Slide 3 of 3"]);
    expect(dots.filter((a) => a.hasAttribute("aria-current"))).toHaveLength(1);
  });

  test(`more than ${HOME_HERO_MAX_SLIDES} slides are capped at ${HOME_HERO_MAX_SLIDES}`, () => {
    const d = doc(<HomeHero slides={[1, 2, 3, 4, 5].map((n) => slide(n))} />);
    expect(d.querySelectorAll('[aria-roledescription="slide"]')).toHaveLength(HOME_HERO_MAX_SLIDES);
    expect(d.body.textContent).not.toContain("Slide headline 4");
  });

  test("images: every img has alt + width/height; first eager, others lazy", () => {
    const d = doc(<HomeHero slides={SLIDES3} deal={DEAL} />);
    const imgs = [...d.querySelectorAll("#home-hero img")];
    expect(imgs.length).toBeGreaterThanOrEqual(3);
    for (const img of imgs) {
      expect(img.hasAttribute("alt")).toBe(true);
      expect(img.getAttribute("width") ?? "").not.toBe("");
      expect(img.getAttribute("height") ?? "").not.toBe("");
    }
    expect(imgs[0]?.getAttribute("loading")).not.toBe("lazy");
    for (const img of imgs.slice(1)) expect(img.getAttribute("loading")).toBe("lazy");
  });

  test("no autoplay: no autoplay attribute, no pause/play control in static markup", () => {
    const out = html(<HomeHero slides={SLIDES3} />);
    expect(out.toLowerCase()).not.toContain("autoplay");
    expect(out).not.toMatch(/>\s*(Pause|Play)\b/i);
    expect(doc(<HomeHero slides={SLIDES3} />).querySelectorAll("script")).toHaveLength(0);
  });

  test("deal panel: h2 'Deal of the day', title, price, 'You save', <time>, one 'View deal: <title>' link to the PDP", () => {
    render(<HomeHero slides={SLIDES3} deal={DEAL} />);
    const deal = screen.getByRole("region", { name: DEAL_HEADING });
    expect(within(deal).getByRole("heading", { level: 2, name: DEAL_HEADING })).toBeInTheDocument();
    expect(deal.textContent).toContain(DEAL.title);
    expect(deal.textContent).toContain("12");
    expect(deal.textContent).toMatch(/You save/);
    expect(deal.querySelector("time")?.getAttribute("dateTime") ?? deal.querySelector("time")?.getAttribute("datetime")).toBeTruthy();
    const links = within(deal).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.textContent).toBe(`View deal: ${DEAL.title}`); // visible "View deal" + sr-only ": <title>"
    expect(links[0]?.getAttribute("href")).toBe(DEAL.href);
    // Deal panel is a sibling of the carousel, not inside it.
    expect(document.getElementById("home-hero")?.contains(deal)).toBe(false);
  });

  test("deal panel price: accessible text reads the whole amount '$12.50' (superscript is visual only)", () => {
    render(<HomeHero slides={SLIDES3} deal={DEAL} />);
    const deal = screen.getByRole("region", { name: DEAL_HEADING });
    const spoken = [...deal.querySelectorAll(".sr-only, [aria-label]")].map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
    expect(spoken.join(" | ")).toContain("$12.50");
  });

  test("deal validation: NaN/negative/fractional cents, bad currency, blank title, external/js href -> panel dropped, hero kept", () => {
    silenceWarn();
    const bad: Partial<HomeHeroDeal>[] = [
      { priceCents: Number.NaN },
      { priceCents: -1 },
      { priceCents: 12.5 },
      { currency: "ZZZ" },
      { currency: "" },
      { title: "   " },
      { href: "https://evil.example/p" },
      { href: "javascript:alert(1)" },
      { href: "//evil.example" },
    ];
    for (const over of bad) {
      const out = html(<HomeHero slides={SLIDES3} deal={{ ...DEAL, ...over }} />);
      expect({ over, deal: out.includes(DEAL_HEADING), hero: out.includes("Slide headline 1") }).toEqual({ over, deal: false, hero: true });
    }
  });

  test("deal 'Ends' only for a valid ISO date; no savings when list <= price", () => {
    for (const endsAt of ["not a date", "2026-13-40", "", null]) {
      expect(html(<HomeHero slides={SLIDES3} deal={{ ...DEAL, endsAt }} />)).not.toContain("Ends ");
    }
    expect(html(<HomeHero slides={SLIDES3} deal={{ ...DEAL, listPriceCents: 1250 }} />)).not.toContain("You save");
  });

  test("hostile slide and deal text is text (no script/onerror)", () => {
    const { container } = render(
      <HomeHero slides={[slide(1, { headline: HOSTILE, subline: HOSTILE })]} deal={{ ...DEAL, title: HOSTILE }} />,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(HOSTILE);
    expectNull(container.querySelector("script"));
    for (const el of container.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
  });

  test("slide CTA with a disallowed href is dropped (no external link rendered)", () => {
    silenceWarn();
    const d = doc(<HomeHero slides={[slide(1, { cta: { label: "Go", href: "https://evil.example" } }), slide(2)]} />);
    const hrefs = [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.filter((h) => !h.startsWith("#") && !isAllowedInternalHref(h))).toEqual([]);
  });
});

// --------------------------------------------------------------------------------------------
describe("CategoryRail (T152 AC1–3; H-6, H-7)", () => {
  test("15 departments -> 12 tiles in data order + trailing 'All departments' -> /products (a real route)", () => {
    render(<CategoryRail categories={depts(15)} id="home-categories" />);
    const section = document.getElementById("home-categories");
    expectNotNull(section);
    const links = within(section as HTMLElement).getAllByRole("link");
    expect(links).toHaveLength(CATEGORY_RAIL_MAX_TILES + 1);
    expect(CATEGORY_RAIL_MAX_TILES).toBe(12);
    expect(links.slice(0, 12).map((a) => a.getAttribute("href"))).toEqual(depts(12).map((d) => `/category/${d.slug}`));
    expect(links.slice(0, 12).map((a) => a.textContent?.trim())).toEqual(depts(12).map((d) => d.name));
    const last = links[12];
    expect(last).toHaveAccessibleName(CATEGORY_RAIL_ALL_LABEL);
    expect(CATEGORY_RAIL_ALL_LABEL).toBe("All departments");
    expect(last?.getAttribute("href")).toBe(CATEGORY_RAIL_ALL_HREF);
    expect(CATEGORY_RAIL_ALL_HREF).toBe("/products");
    expect(routeExists("/products")).toBe(true);
    expect(routeExists("/departments")).toBe(false);
  });

  test("exactly 12 -> no 'All departments' tile", () => {
    render(<CategoryRail categories={depts(12)} />);
    expect(screen.queryByRole("link", { name: CATEGORY_RAIL_ALL_LABEL })).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(12);
  });

  test("circle tiles: images alt='' (decorative), link name = department; no headings inside tiles; section h2", () => {
    const { container } = render(<CategoryRail categories={depts(3)} />);
    const section = container.querySelector("section") as HTMLElement;
    expect(within(section).getAllByRole("heading")).toHaveLength(1);
    expect(within(section).getByRole("heading", { level: 2 })).toBeInTheDocument();
    for (const a of within(section).getAllByRole("link")) {
      expect(a.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(0);
      const img = a.querySelector("img");
      expect(img?.getAttribute("alt")).toBe("");
      expect(a.className + (a.querySelector("[class*=rounded-full]") ? " rounded-full" : "")).toContain("rounded-full");
    }
  });

  test("H-7: the scroller is a named region with tabindex=0 (keyboard reachable without JS)", () => {
    const d = doc(<CategoryRail categories={depts(5)} id="home-categories" />);
    const scroller = d.querySelector('#home-categories [role="region"]');
    expect(scroller?.getAttribute("tabindex")).toBe("0");
    expect(scroller?.getAttribute("aria-label") ?? "").not.toBe("");
  });

  test("0 / all-invalid / non-array -> null (no empty heading); hostile slug encoded, hostile name is text", () => {
    silenceWarn();
    for (const categories of [[], [{ slug: "", name: "X" }, { slug: "y", name: "  " }], null as unknown as []]) {
      expect(html(<CategoryRail categories={categories} />)).toBe("");
    }
    const { container } = render(<CategoryRail categories={[{ slug: "a b/../c", name: HOSTILE }]} />);
    for (const a of container.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    expectNull(container.querySelector("script"));
  });

  // (cj, T174): QA no longer imports the deprecated alias. While the alias still exists it must be
  // the rail itself; once CLEANUP removes it this test keeps passing. Final form after removal:
  // `expect(Object.keys(railModule).filter((k) => /grid/i.test(k))).toEqual([])`.
  test("folder exports CategoryRail; a deprecated CategoryGrid alias, if still exported, is the rail (T152 AC4, cj)", () => {
    const exported = railModule as Record<string, unknown>;
    expect(typeof exported.CategoryRail).toBe("function");
    expect(exported.CategoryGrid === undefined || exported.CategoryGrid === exported.CategoryRail).toBe(true);
    expect(html(<CategoryRail categories={depts(2)} />)).toContain(railModule.CATEGORY_RAIL_DEFAULT_TITLE);
  });
});

describe("CategoryDiscovery (T152; H-13)", () => {
  test("8 children -> 6 card tiles, each ONE link to /category/<slug>, eyebrow + h2, id home-discovery", () => {
    render(<CategoryDiscovery categories={depts(8)} />);
    const section = document.getElementById("home-discovery") as HTMLElement;
    expectNotNull(section);
    expect(section.getAttribute("aria-labelledby")).toBeTruthy();
    const h2 = within(section).getByRole("heading", { level: 2 });
    expect(within(section).getAllByRole("heading")).toHaveLength(1);
    // eyebrow: a text line before the h2
    const before = h2.previousElementSibling ?? h2.parentElement?.previousElementSibling;
    expect((before?.textContent ?? "").trim()).not.toBe("");
    const links = within(section).getAllByRole("link");
    expect(links).toHaveLength(CATEGORY_DISCOVERY_MAX_TILES);
    expect(CATEGORY_DISCOVERY_MAX_TILES).toBe(6);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(depts(6).map((d) => `/category/${d.slug}`));
    for (const a of links) {
      expect(a.querySelectorAll("h1, h2, h3, h4, h5, h6")).toHaveLength(0);
      expect(a.querySelector("img")?.getAttribute("alt")).toBe("");
    }
  });

  test("0 valid children -> nothing", () => {
    silenceWarn();
    expect(html(<CategoryDiscovery categories={[]} />)).toBe("");
    expect(html(<CategoryDiscovery categories={[{ slug: " ", name: "x" }]} />)).toBe("");
  });
});

// --------------------------------------------------------------------------------------------
describe("ProductRail tabs (T153 AC1–5; H-14 … H-16; T163 AC3)", () => {
  test("H-14: tabs nav = 4 plain links in order with /?rail=<id>#top-picks; active aria-current=page; no role=tab", () => {
    render(<ProductRail id="top-picks" title="Top picks" tabs={TABS} activeId="deals" products={[product(1)]} quickAdd={quickAdd} />);
    const section = document.getElementById("top-picks") as HTMLElement;
    const nav = within(section).getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.textContent?.trim())).toEqual(TAB_LABELS);
    expect(links.map((a) => a.getAttribute("href"))).toEqual(TAB_IDS.map((id) => `/?rail=${id}#top-picks`));
    expect(links.filter((a) => a.getAttribute("aria-current") === "page").map((a) => a.textContent?.trim())).toEqual(["Deals"]);
    expect(section.querySelectorAll('[role="tab"], [role="tablist"]')).toHaveLength(0);
    for (const a of links) expect(a.className).toMatch(TOUCH);
  });

  test("section is named by its heading (aria-labelledby -> h2 'Top picks')", () => {
    render(<ProductRail id="top-picks" title="Top picks" tabs={TABS} activeId="best-sellers" products={[product(1)]} />);
    const section = document.getElementById("top-picks") as HTMLElement;
    const labelledBy = section.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toBe("Top picks");
    expect(screen.getByRole("region", { name: "Top picks" }).id).toBe("top-picks");
  });

  test("resolveRailTab fuzz never throws and falls back to the default", () => {
    const ids = [...TAB_IDS];
    const fallbacks: unknown[] = [
      "x",
      "",
      ["deals", "top-rated"],
      ["deals"],
      "__proto__",
      "constructor",
      "toString",
      "hasOwnProperty",
      " deals",
      "DEALS",
      "deals#x",
      "d".repeat(500),
      "deals".padEnd(RAIL_PARAM_MAX_LENGTH + 1, "x"),
      null,
      undefined,
      42,
      {},
    ];
    for (const raw of fallbacks) {
      expect({ raw: String(raw).slice(0, 20), got: resolveRailTab(raw as string, ids, "best-sellers") }).toEqual({
        raw: String(raw).slice(0, 20),
        got: "best-sellers",
      });
    }
    for (const id of ids) expect(resolveRailTab(id, ids, "best-sellers")).toBe(id);
    // A 500-char id that IS listed still falls back (length cap is applied first).
    const long = "a".repeat(500);
    expect(resolveRailTab(long, [...ids, long], "best-sellers")).toBe("best-sellers");
  });

  test("unknown activeId renders the first tab as current (no throw)", () => {
    render(<ProductRail title="Top picks" tabs={TABS} activeId="__proto__" products={[product(1)]} />);
    const current = screen.getAllByRole("link").filter((a) => a.getAttribute("aria-current") === "page");
    expect(current.map((a) => a.textContent?.trim())).toEqual(["Best sellers"]);
  });

  test("empty active tab: heading + tab links stay, role=status text replaces the rail", () => {
    render(<ProductRail id="top-picks" title="Top picks" tabs={TABS} activeId="new-arrivals" products={[]} />);
    expect(screen.getByRole("heading", { level: 2, name: "Top picks" })).toBeInTheDocument();
    expect(within(screen.getByRole("navigation")).getAllByRole("link")).toHaveLength(4);
    expect(screen.getByRole("status").textContent).toBe(PRODUCT_RAIL_EMPTY_TAB_TEXT);
    expect(screen.queryAllByRole("listitem").filter((li) => li.closest("nav") === null)).toHaveLength(0);
  });

  test("no tabs and 0 products -> nothing", () => {
    expect(html(<ProductRail title="Top picks" products={[]} />)).toBe("");
  });

  test("H-16: compact cards, no duplicates, each with a '+ Add' form (name 'Add to cart: <name>'); out of stock disabled", () => {
    const products = [product(1), product(2), product(1), product(3, { stock: 0 })];
    render(<ProductRail id="top-picks" title="Top picks" tabs={TABS} activeId="deals" products={products} quickAdd={quickAdd} />);
    const region = screen.getByRole("region", { name: /Top picks: Deals/ });
    const cards = region.querySelectorAll(":scope > ul > li");
    expect(cards).toHaveLength(3);
    const buttons = within(region).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Add to cart: QA Product 1",
      "Add to cart: QA Product 2",
      expect.stringMatching(/QA Product 3|Out of stock/),
    ]);
    expect(buttons[0]?.textContent).toContain("Add");
    expect((buttons[2] as HTMLButtonElement).disabled).toBe(true);
    for (const li of cards) expect(li.querySelector("article")?.getAttribute("data-variant")).toBe("compact");
  });

  test("tabs with hostile/duplicate/blank entries: only valid unique allow-listed tabs render", () => {
    silenceWarn();
    render(
      <ProductRail
        title="Top picks"
        tabs={[
          ...TABS,
          { id: "deals", label: "Dup", href: "/?rail=deals#top-picks" },
          { id: "evil", label: "Evil", href: "javascript:alert(1)" },
          { id: "ext", label: "Ext", href: "https://evil.example/" },
          { id: " ", label: "Blank", href: "/" },
          { id: "h", label: HOSTILE, href: "/?rail=h#top-picks" },
        ]}
        activeId="deals"
        products={[product(1)]}
      />,
    );
    const hrefs = within(screen.getByRole("navigation")).getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.every((h) => isAllowedInternalHref(h))).toBe(true);
    expect(hrefs.filter((h) => h === "/?rail=deals#top-picks")).toHaveLength(1);
    expectNull(document.querySelector("script"));
  });
});

// --------------------------------------------------------------------------------------------
describe("PromoBanner coupon + banner modes, PromoBannerPair (T154 AC1, AC3; H-12, H-19)", () => {
  test("coupon mode: complementary, code upper-cased in <code>, 'Go to cart' -> /cart; bad code -> nothing", () => {
    render(<PromoBanner coupon={{ code: "welcome10", description: "10% off your order", minSubtotalCents: 2500 }} />);
    const aside = screen.getByRole("complementary");
    expect(aside.querySelector("code")?.textContent).toBe("WELCOME10");
    expect(aside.textContent).toContain("Minimum order $25.00");
    expect(within(aside).getByRole("link", { name: /Go to cart/ }).getAttribute("href")).toBe("/cart");
    for (const code of ["", "  ", "HAS SPACE", "<b>", "X".repeat(33)]) {
      expect(html(<PromoBanner coupon={{ code, description: "x" }} />)).toBe("");
    }
    expect(html(<PromoBanner coupon={null} />)).toBe("");
  });

  test("coupon mode: unsafe cartHref falls back to /cart; hostile description is text", () => {
    silenceWarn();
    const { container } = render(<PromoBanner coupon={{ code: "SAVE5", description: HOSTILE }} cartHref="javascript:alert(1)" />);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/cart");
    expect(container.textContent).toContain(HOSTILE);
    expectNull(container.querySelector("script"));
  });

  test("banner mode: one CTA link to /shipping, heading, decorative image; invalid CTA -> nothing", () => {
    render(<PromoBanner id="home-shipping-promo" promo={promo("Free shipping over $35", "/shipping", { image: DELIVERY_PROMO_ART })} />);
    const root = document.getElementById("home-shipping-promo") as HTMLElement;
    expectNotNull(root);
    const links = within(root).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/shipping");
    expect(within(root).getByRole("heading", { level: 2 }).textContent).toBe("Free shipping over $35");
    for (const img of root.querySelectorAll("img")) expect(img.hasAttribute("alt")).toBe(true);
    silenceWarn();
    for (const href of ["", "  ", "javascript:alert(1)", "https://evil.example", "//evil.example"]) {
      expect(html(<PromoBanner promo={promo("X", href)} />)).toBe("");
    }
    expect(html(<PromoBanner promo={{ ...promo("X", "/deals"), heading: "  " }} />)).toBe("");
    expect(html(<PromoBanner promo={null} />)).toBe("");
  });

  test("PromoBannerPair: 2 valid -> section + h2 + 2 h3 cards ('New arrivals' -> /new-arrivals, 'Top rated' -> /top-rated)", () => {
    render(<PromoBannerPair id="home-promo-pair" promos={[promo("New arrivals", "/new-arrivals"), promo("Top rated", "/top-rated")]} />);
    const section = document.getElementById("home-promo-pair") as HTMLElement;
    expectNotNull(section);
    expect(within(section).getAllByRole("heading", { level: 2 })).toHaveLength(1);
    expect(within(section).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["New arrivals", "Top rated"]);
    expect(within(section).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/new-arrivals", "/top-rated"]);
    expect(routeExists("/new-arrivals") && routeExists("/top-rated")).toBe(true);
  });

  test("PromoBannerPair: one valid of two -> nothing; three valid -> first two", () => {
    silenceWarn();
    expect(html(<PromoBannerPair promos={[promo("A", "/deals"), promo("B", "javascript:x")]} />)).toBe("");
    const d = doc(<PromoBannerPair promos={[promo("A", "/deals"), promo("B", "/new-arrivals"), promo("C", "/top-rated")]} />);
    expect([...d.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["A", "B"]);
  });
});

// --------------------------------------------------------------------------------------------
describe("LifestyleBanners (T154 AC2; H-17)", () => {
  test("columns 4: 4 cards, grid 1 / sm 2 / lg 4; each card one link; images have alt", () => {
    render(<LifestyleBanners id="home-lifestyle-cards" items={[1, 2, 3, 4].map((n) => lifestyle(n))} columns={4} heading="Make room" />);
    const section = document.getElementById("home-lifestyle-cards") as HTMLElement;
    const list = within(section).getByRole("list");
    expect(list.className).toContain("grid-cols-1");
    expect(list.className).toContain("sm:grid-cols-2");
    expect(list.className).toContain("lg:grid-cols-4");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    for (const li of items) {
      expect(li.querySelectorAll("a")).toHaveLength(1);
      for (const img of li.querySelectorAll("img")) expect(img.hasAttribute("alt")).toBe(true);
      expect(li.querySelectorAll("h1, h2")).toHaveLength(0);
    }
  });

  test("columns 3: lg:grid-cols-3 and at most 3 cards from 4 valid", () => {
    const d = doc(<LifestyleBanners items={[1, 2, 3, 4].map((n) => lifestyle(n))} columns={3} />);
    expect(d.querySelector("ul")?.className).toContain("lg:grid-cols-3");
    expect(d.querySelectorAll("ul > li")).toHaveLength(3);
  });

  test("invalid hrefs dropped; < 2 valid -> nothing", () => {
    silenceWarn();
    const mixed = [lifestyle(1), lifestyle(2, "javascript:alert(1)"), lifestyle(3, "https://evil.example"), lifestyle(4)];
    const d = doc(<LifestyleBanners items={mixed} columns={4} />);
    expect([...d.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/category/dept-1", "/category/dept-4"]);
    expect(html(<LifestyleBanners items={[lifestyle(1), lifestyle(2, "")]} columns={4} />)).toBe("");
    expect(html(<LifestyleBanners items={null} columns={4} />)).toBe("");
  });
});

// --------------------------------------------------------------------------------------------
describe("BrandStrip (T155 AC1, AC4)", () => {
  test("scroll row: overflow-x-auto scroller with a no-wrap list; one 44px link per brand to /brand/<slug>", () => {
    const brands = [1, 2, 3].map((n) => ({ slug: `brand-${n}`, name: `Brand ${n}` }));
    const { container } = render(<BrandStrip brands={brands} />);
    const list = within(container).getByRole("list");
    expect(list.parentElement?.className).toContain("overflow-x-auto");
    expect(list.className).toContain("flex-nowrap");
    const links = within(list).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(brands.map((b) => `/brand/${b.slug}`));
    expect(routeExists("/brand/brand-1")).toBe(true);
    for (const a of links) expect(a.className).toMatch(TOUCH);
  });

  test("empty / invalid -> nothing", () => {
    silenceWarn();
    expect(html(<BrandStrip brands={[]} />)).toBe("");
    expect(html(<BrandStrip brands={[{ slug: "", name: "X" }]} />)).toBe("");
  });
});

describe("ServicesBand (T155 AC2–3; H-21)", () => {
  test("defaults: h2 'Customer services' (visually hidden), 6 tiles to existing pages, notice links /returns", () => {
    render(<ServicesBand id="home-services" />);
    const section = document.getElementById("home-services") as HTMLElement;
    const h2 = within(section).getByRole("heading", { level: 2, name: "Customer services" });
    expect(h2.className).toContain("sr-only");
    expect(section.getAttribute("aria-labelledby")).toBe(h2.id);
    const hrefs = within(section).getAllByRole("link").map((a) => a.getAttribute("href") ?? "");
    for (const tile of ["/orders", "/returns", "/shipping", "/help", "/faq", "/contact"]) expect(hrefs).toContain(tile);
    expect(SERVICES_BAND_DEFAULT_TILES.map((t) => t.href)).toEqual(["/orders", "/returns", "/shipping", "/help", "/faq", "/contact"]);
    for (const h of hrefs) expect({ h, exists: routeExists(h) }).toEqual({ h, exists: true });
    const notice = section.querySelector("p a");
    expect(notice?.getAttribute("href")).toBe("/returns");
  });

  test("notice null -> none; blank text -> none; bad href keeps the text, drops the link", () => {
    expect(doc(<ServicesBand notice={null} />).querySelector("section p a")).toBeNull();
    silenceWarn();
    const d = doc(<ServicesBand notice={{ text: "Need a refund?", linkLabel: "Read more", href: "javascript:alert(1)" }} />);
    expect(d.body.textContent).toContain("Need a refund?");
    expect([...d.querySelectorAll("a")].map((a) => a.getAttribute("href"))).not.toContain("javascript:alert(1)");
  });

  test("all tiles invalid -> nothing (no heading, no notice)", () => {
    silenceWarn();
    expect(html(<ServicesBand tiles={[{ label: "X", href: "https://evil.example" }]} />)).toBe("");
  });
});

// --------------------------------------------------------------------------------------------
function AllHome() {
  return (
    <main>
      <CategoryRail categories={depts(14)} id="home-categories" />
      <HomeHero slides={SLIDES3} deal={DEAL} />
      <PromoBanner id="home-shipping-promo" promo={promo("Free shipping over $35", "/shipping", { image: DELIVERY_PROMO_ART })} />
      <CategoryDiscovery categories={depts(6)} />
      <BrandStrip brands={[{ slug: "acme", name: "Acme" }]} id="home-brands" />
      <PromoBanner id="home-lifestyle-banner" promo={promo("Everyday beauty", "/category/dept-1")} />
      <ProductRail id="top-picks" title="Top picks" tabs={TABS} activeId="best-sellers" products={[product(1), product(2)]} quickAdd={quickAdd} />
      <LifestyleBanners id="home-lifestyle-cards" items={[1, 2, 3, 4].map((n) => lifestyle(n))} columns={4} heading="Make room" />
      <PromoBannerPair id="home-promo-pair" promos={[promo("New arrivals", "/new-arrivals"), promo("Top rated", "/top-rated")]} />
      <ProductRail id="home-recently-viewed" title="Recently viewed" products={[product(5)]} />
      <ServicesBand id="home-services" />
      <PromoBanner coupon={{ code: "WELCOME10", description: "10% off" }} />
    </main>
  );
}

describe("Cross-cutting: every home organism rendered together", () => {
  test("landmark names unique (region, navigation, complementary); ids unique; exactly one h1", () => {
    const { container } = render(<AllHome />);
    for (const role of ["region", "navigation", "complementary"] as const) {
      const names = screen.queryAllByRole(role).map((el) => {
        const by = el.getAttribute("aria-labelledby");
        return el.getAttribute("aria-label") ?? (by ? document.getElementById(by)?.textContent : "") ?? "";
      });
      expect({ role, dupes: names.filter((n, i) => names.indexOf(n) !== i) }).toEqual({ role, dupes: [] });
      expect({ role, blank: names.filter((n) => n.trim() === "").length }).toEqual({ role, blank: 0 });
    }
    const ids = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  test("heading levels never skip downward in DOM order (G-7)", () => {
    const { container } = render(<AllHome />);
    const levels = [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName.slice(1)));
    const skips: string[] = [];
    // The first heading is exempt: by the H-order the category rail (h2) precedes the hero h1 in <main>
    // (observation for T166/T172, not an organism defect).
    levels.forEach((lvl, i) => {
      if (i === 0) return;
      const prev = levels[i - 1] ?? 0;
      if (lvl > prev + 1) skips.push(`${prev}->${lvl} at #${i}`);
    });
    expect(skips).toEqual([]);
  });

  test("every href is allow-listed (or an in-page #id that exists) and every internal route exists", () => {
    const { container } = render(<AllHome />);
    const hrefs = [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(30);
    for (const h of hrefs) {
      if (h.startsWith("#")) {
        expect({ h, target: document.getElementById(h.slice(1)) !== null }).toEqual({ h, target: true });
        continue;
      }
      expect({ h, allowed: isAllowedInternalHref(h), exists: routeExists(h) }).toEqual({ h, allowed: true, exists: true });
    }
  });

  test("44px: every link and button carries a touch-size class (or is the button-look link / pill)", () => {
    const { container } = render(<AllHome />);
    const targets = [...container.querySelectorAll("a[href], button")];
    const small = targets.filter((el) => {
      const cls = el.getAttribute("class") ?? "";
      return !TOUCH.test(cls) && !/(^|\s)(h-11|h-12|min-h-11|min-h-12|size-11|size-12)(\s|$)/.test(cls);
    });
    expect(small.map((el) => el.outerHTML.slice(0, 160))).toEqual([]);
  });

  test("every img has an alt attribute and width/height", () => {
    const { container } = render(<AllHome />);
    const imgs = [...container.querySelectorAll("img")];
    expect(imgs.length).toBeGreaterThan(10);
    // H-25: width+height, or a `fill` image inside an aspect-ratio box.
    const sized = (img: Element) =>
      (img.getAttribute("width") && img.getAttribute("height")) ||
      (img.getAttribute("data-nimg") === "fill" && /(^|\s)aspect-/.test(img.closest("[class*=aspect-]")?.getAttribute("class") ?? ""));
    const bad = imgs.filter((img) => !img.hasAttribute("alt") || !sized(img));
    expect(bad.map((img) => img.outerHTML.slice(0, 120))).toEqual([]);
  });

  test("light-only, brand-free, tokens-only: no dark-variant classes, no retailer names, no arbitrary/palette classes, no inline style/handlers", () => {
    const out = html(<AllHome />);
    expect(out).not.toContain(DARK_VARIANT);
    const lower = out.toLowerCase();
    for (const word of BRAND_WORDS) expect({ word, found: lower.includes(word) }).toEqual({ word, found: false });
    expect(out).not.toMatch(/\son[a-z]+=/i);
    const d = new DOMParser().parseFromString(out, "text/html");
    const classes = [...d.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)(bg|text|border|ring)-(gray|slate|red|blue|green|yellow|white|black)(-\d+)?$/.test(c))).toEqual([]);
    // Inline styles: only next/image style attributes on <img> are tolerated.
    const styled = [...d.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG");
    expect(styled.map((el) => el.outerHTML.slice(0, 100))).toEqual([]);
  });

  test("no newsletter email field, no app/store promotion outside the footer (H-24)", () => {
    const { container } = render(<AllHome />);
    expect(container.querySelectorAll('input[type="email"]')).toHaveLength(0);
    expect(container.textContent?.toLowerCase()).not.toContain("download the app");
  });
});

// --------------------------------------------------------------------------------------------
// Accepted rulings (formerly pinned defects).
describe("Accepted rulings", () => {
  // Was PIN D-T154-1 (minor). Orchestrator ruling (T163 hand-off, STATE T163 row): ACCEPTED. T154 AC1
  // ("expired/inactive coupon hides the code") is satisfied upstream: `couponService.listPromoted(now)`
  // drops expired, not-yet-started, inactive and exhausted coupons, and organisms never read the clock
  // (one-clock rule). T172 converted the pin into these two tests: the service filters, the organism
  // renders exactly what it is given and reads no clock.
  test("ruling D-T154-1: listPromoted(now) filters out a promoted coupon whose expiry has passed", async () => {
    const { createDatabase } = await import("@/server/db/client");
    const { runMigrations } = await import("@/server/db/schema");
    const { createCouponService } = await import("@/server/pricing/coupon-service");
    const db = createDatabase(":memory:");
    try {
      runMigrations(db);
      const insert = db.query(
        "INSERT INTO coupons (code, kind, value, starts_at, expires_at, is_active, promoted) VALUES (?, 'percent', 10, NULL, ?, 1, 1)",
      );
      insert.run("OLD10", "2020-01-01T00:00:00.000Z");
      insert.run("LIVE10", "2030-01-01T00:00:00.000Z");
      const now = Date.parse("2026-11-08T12:00:00.000Z");
      const codes = createCouponService({ db }).listPromoted(now).map((c) => c.code);
      expect(codes).toEqual(["LIVE10"]);
      // The same coupon is listed while it is still inside its window (the filter is the clock, not the row).
      expect(createCouponService({ db }).listPromoted(Date.parse("2019-12-31T00:00:00.000Z")).map((c) => c.code)).toEqual([
        "LIVE10",
        "OLD10",
      ]);
    } finally {
      db.close();
    }
  });

  test("ruling D-T154-1: PromoBanner coupon mode reads no clock (renders what the service passed)", () => {
    const dateNow = spyOn(Date, "now");
    try {
      const out = html(<PromoBanner coupon={{ code: "OLD10", description: "10% off", endsAt: "2020-01-01T00:00:00Z" }} />);
      // No expiry logic in the organism: the code is shown, and no clock was consulted to decide that.
      expect(out).toContain("OLD10");
      expect(dateNow).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });
});
