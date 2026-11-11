// QA T181 (UI wave 1, part 1): independent checks of the fixes for U01, U02, U03, U04, U08, U11, U12,
// U15, U16, U19, U20 from tests/e2e/UI-REVIEW-2026-11-09.md (U05 brands + coupon service live in
// tests/app/ui-wave1-part1-pages.qa.test.tsx because they need a seeded in-memory DB).
// Defects are pinned as `test.failing` tagged `// PIN: D-T181-n`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryTile } from "@/components/atoms/CategoryTile";
import { ScrollRail } from "@/components/atoms/ScrollRail";
import { ToastProvider, ToastViewport } from "@/components/atoms/Toast";
import { HeroBanner } from "@/components/molecules/HeroBanner";
import { PromoTile } from "@/components/molecules/PromoTile";
import { HomeHero, safeDealImageUrl, type HomeHeroDeal } from "@/components/organisms/HomeHero";
import { SiteHeader, type SiteHeaderProps } from "@/components/organisms/SiteHeader";
import { ACCOUNT_MENU_LABEL } from "@/components/organisms/SiteHeader/AccountMenu";
import { buildHeaderBenefits } from "@/app/_layout/header-benefits";
import { HOME_CONTENT } from "@/content/home";
import {
  ACCOUNT_PROMO_ART,
  BEST_SELLERS_PROMO_ART,
  DEALS_PROMO_ART,
  HERO_SLIDE_ART,
} from "@/content/home-art";
import { HEADER_BENEFIT_COMPACT_IDS } from "@/content/header-benefits";
import { LISTING_PROMOS } from "@/content/listing-promos";
import { DEPARTMENT_NAV } from "@/content/navigation";
import { expectFocused, expectNotNull } from "@/test/dom-assertions";
import { brandAndThemeViolations } from "../app/phase3-pages/_phase3";
import { BODY, PALETTE, ROOT, contrastRgb, hexToRgb, raw } from "./atoms/_palette";

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const classesOf = (el: Element | null | undefined): string[] =>
  (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const ratio = (fg: string, bg: string) => contrastRgb(hexToRgb(raw(fg)), hexToRgb(raw(bg)));

// ---------------------------------------------------------------------------
// U01 ScrollRail
// ---------------------------------------------------------------------------

const observers: Array<() => void> = [];
class FakeResizeObserver {
  private readonly cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    observers.push(() => this.cb());
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
const originalRO = globalThis.ResizeObserver;

function stub(el: HTMLElement, m: { scrollLeft: number; scrollWidth: number; clientWidth: number }) {
  Object.defineProperty(el, "scrollWidth", { configurable: true, value: m.scrollWidth });
  Object.defineProperty(el, "clientWidth", { configurable: true, value: m.clientWidth });
  Object.defineProperty(el, "scrollLeft", { configurable: true, writable: true, value: m.scrollLeft });
}

function Rail() {
  return (
    <ScrollRail label="Best sellers products">
      <a href="/products/a">A</a>
      <a href="/products/b">B</a>
      <a href="/products/c">C</a>
    </ScrollRail>
  );
}

const railRegion = () => screen.getByRole("region", { name: "Best sellers products" });
const leftArrow = () => screen.queryByRole("button", { name: "Scroll left" });
const rightArrow = () => screen.queryByRole("button", { name: "Scroll right" });

function measure(m: { scrollLeft: number; scrollWidth: number; clientWidth: number }) {
  stub(railRegion(), m);
  act(() => observers.forEach((fire) => fire()));
}

function scrollRegion(left: number) {
  act(() => {
    Object.defineProperty(railRegion(), "scrollLeft", { configurable: true, writable: true, value: left });
    railRegion().dispatchEvent(new Event("scroll"));
  });
}

describe("T181 U01 ScrollRail", () => {
  beforeEach(() => {
    observers.length = 0;
    globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  });
  afterEach(() => {
    globalThis.ResizeObserver = originalRO;
  });

  test("server HTML (no JS): named focusable region, no arrow buttons at all", () => {
    const html = renderToStaticMarkup(<Rail />);
    expect(html).not.toContain("<button");
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Best sellers products"');
    expect(html).toContain('tabindex="0"');
  });

  test("nothing scrollable (exact fit and within the 2px tolerance): zero buttons in the DOM", () => {
    render(<Rail />);
    measure({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    expect(document.querySelectorAll("button")).toHaveLength(0);
    measure({ scrollLeft: 0, scrollWidth: 302, clientWidth: 300 });
    expect(document.querySelectorAll("button")).toHaveLength(0);
    // 3px overflow is real content: the next arrow appears.
    measure({ scrollLeft: 0, scrollWidth: 303, clientWidth: 300 });
    expect(rightArrow()).not.toBeNull();
    expect(leftArrow()).toBeNull();
  });

  test("U01 repro: at scrollLeft 0..2 (snap parking) there is no prev arrow", () => {
    render(<Rail />);
    for (const left of [0, 1, 2]) {
      measure({ scrollLeft: left, scrollWidth: 900, clientWidth: 300 });
      expect(leftArrow()).toBeNull();
    }
  });

  test("arrows are siblings of the scroll region (outside it), absolute, max-md:hidden; region keeps tabIndex 0 + label", () => {
    const { container } = render(<Rail />);
    measure({ scrollLeft: 300, scrollWidth: 900, clientWidth: 300 });
    const wrapper = container.firstElementChild;
    const region = railRegion();
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(region.getAttribute("aria-label")).toBe("Best sellers products");
    for (const button of [leftArrow(), rightArrow()]) {
      expectNotNull(button);
      expect(region.contains(button)).toBe(false);
      expect(button?.parentElement === wrapper).toBe(true);
      expect(classesOf(button)).toEqual(expect.arrayContaining(["absolute", "max-md:hidden"]));
    }
    // DOM / tab order: prev, region, next.
    const order = [...(wrapper?.children ?? [])].map((el) => el.getAttribute("role") ?? el.tagName.toLowerCase());
    expect(order).toEqual(["button", "region", "button"]);
    // Gutter reserved from md, pulled into the page margin from the rail breakpoint.
    expect(classesOf(wrapper)).toEqual(expect.arrayContaining(["relative", "md:px-12", "rail:-mx-12"]));
  });

  test("focused 'Scroll left' that disappears at the start hands focus to the region", () => {
    render(<Rail />);
    measure({ scrollLeft: 300, scrollWidth: 900, clientWidth: 300 });
    act(() => leftArrow()?.focus());
    expectFocused(leftArrow());
    scrollRegion(0);
    expect(leftArrow()).toBeNull();
    expectFocused(railRegion());
  });

  test("focused arrow when the rail stops overflowing (resize) hands focus to the region; no buttons remain", () => {
    render(<Rail />);
    measure({ scrollLeft: 0, scrollWidth: 900, clientWidth: 300 });
    act(() => rightArrow()?.focus());
    expectFocused(rightArrow());
    measure({ scrollLeft: 0, scrollWidth: 900, clientWidth: 900 });
    expect(document.querySelectorAll("button")).toHaveLength(0);
    expectFocused(railRegion());
  });

  test("focus on the region itself is never moved by a scroll update", () => {
    render(<Rail />);
    measure({ scrollLeft: 0, scrollWidth: 900, clientWidth: 300 });
    act(() => railRegion().focus());
    scrollRegion(600);
    expectFocused(railRegion());
  });

  test("--breakpoint-rail: 85rem is a theme token between xl and 2xl; ScrollRail uses no arbitrary values", () => {
    const decls = [...BODY.matchAll(/--breakpoint-([a-z0-9]+):\s*([0-9.]+)rem;/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(decls).toContainEqual(["rail", 85]);
    const names = decls.map(([n]) => n);
    expect(names.indexOf("xl")).toBeLessThan(names.indexOf("rail"));
    expect(names.indexOf("rail")).toBeLessThan(names.indexOf("2xl"));
    const src = read("src/components/atoms/ScrollRail/ScrollRail.tsx");
    expect(src.match(/[a-z-]+-\[[^\]]*\]/g) ?? []).toEqual([]);
    expect(src).not.toContain("style=");
  });

  test("itemWidth sm is 80px below md (four category circles per 390px phone)", () => {
    render(
      <ScrollRail label="Shop by department, category list" itemWidth="sm">
        <span>x</span>
      </ScrollRail>,
    );
    expect(classesOf(screen.getByRole("listitem"))).toEqual(expect.arrayContaining(["w-20", "md:w-40"]));
  });
});

// ---------------------------------------------------------------------------
// U02 / U08 / U16 / U20 / U15 Header
// ---------------------------------------------------------------------------

const FREESHIP = { code: "FREESHIP", description: "Free shipping on orders of $20 or more" };

function headerProps(overrides: Partial<SiteHeaderProps> = {}): SiteHeaderProps {
  return {
    cartCount: 2,
    storeName: "Northwind Goods",
    departments: [],
    account: { status: "guest" },
    utilityLinks: [{ label: "Lists", href: "/lists", icon: "heart" }],
    categoryNav: DEPARTMENT_NAV,
    benefits: buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: FREESHIP }),
    ...overrides,
  };
}

describe("T181 U02 header: one banner, only row 1 sticks, from lg", () => {
  test("exactly one banner landmark (and one <header>) in the DOM and in the server HTML", () => {
    render(<SiteHeader {...headerProps()} />);
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    const html = renderToStaticMarkup(<SiteHeader {...headerProps()} />);
    expect(html.match(/<header\b/g) ?? []).toHaveLength(1);
    // No explicit role juggling: the landmark comes from the native element.
    expect(html).not.toMatch(/role="banner"/);
  });

  test("every sticky / fixed / top-0 class in the extended header is lg-prefixed (mobile + tablet static)", () => {
    const { container } = render(<SiteHeader {...headerProps()} />);
    const banner = screen.getByRole("banner");
    // The DepartmentMenu drawer is a modal <dialog> (fixed by design), not header stickiness.
    const all = [banner, ...banner.querySelectorAll("*")]
      .filter((el) => el.closest("dialog") === null)
      .flatMap((el) => classesOf(el));
    const positional = all.filter((c) => /(^|:)(sticky|fixed|top-0)$/.test(c));
    expect(positional.length).toBeGreaterThan(0);
    expect(positional.filter((c) => !c.startsWith("lg:"))).toEqual([]);
    expect(classesOf(banner)).toContain("lg:contents");
    expect(classesOf(banner.firstElementChild)).toEqual(expect.arrayContaining(["lg:sticky", "lg:top-0", "lg:z-sticky", "bg-surface-page"]));
    // The skip link sits before the banner (its focus:fixed is not header stickiness).
    expect(container.firstElementChild?.tagName).toBe("A");
  });

  test("row 1 holds wordmark, search, account and cart (what stays on screen from lg)", () => {
    render(<SiteHeader {...headerProps()} />);
    const row = screen.getByRole("banner").firstElementChild as HTMLElement;
    expect(within(row).getByTestId("header-wordmark")).toBeTruthy();
    expect(within(row).getByTestId("header-search")).toBeTruthy();
    expect(within(row).getByRole("link", { name: "Hello, Sign in, Account & Lists" })).toBeTruthy();
    expect(within(row).getByRole("link", { name: /^Cart, 2 items$/ })).toBeTruthy();
    expect(within(row).queryByRole("navigation", { name: "Primary" })).toBeNull();
  });
});

describe("T181 U08 / U16 header details", () => {
  test("v3 wordmark is nowrap, text-body below sm, h4 from sm; name unchanged", () => {
    render(<SiteHeader {...headerProps()} />);
    const mark = screen.getByTestId("header-wordmark");
    expect(classesOf(mark)).toEqual(expect.arrayContaining(["whitespace-nowrap", "text-body", "sm:text-h4"]));
    expect(classesOf(mark)).not.toContain("break-words");
    expect(screen.getByRole("link", { name: "Northwind Goods" })).toBeTruthy();
  });

  test("account menu accessible names unchanged (guest and signed-in), chevron summary still named", () => {
    const { unmount } = render(<SiteHeader {...headerProps()} />);
    expect(screen.getByRole("link", { name: "Hello, Sign in, Account & Lists" }).getAttribute("href")).toBe("/signin");
    expect(screen.getByTestId("account-menu").querySelector("summary")?.textContent).toBe(ACCOUNT_MENU_LABEL);
    unmount();
    render(
      <SiteHeader
        {...headerProps({ account: { status: "signed-in", displayName: "Ada Lovelace", signOutAction: () => {} } })}
      />,
    );
    expect(screen.getByRole("link", { name: "Hello, Ada Lovelace, Account & Lists" }).getAttribute("href")).toBe("/account");
  });
});

describe("T181 U20 / U15 benefits row", () => {
  test("built strip: free shipping amount from data, coupon without cents, compact ids = free shipping + coupon", () => {
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: 3500, currency: "USD", coupon: FREESHIP });
    expect(strip.items.map((i) => i.label)).toEqual([
      "Free standard shipping on orders of $35 or more",
      "Track your order",
      "Returns and refunds",
      "Use code FREESHIP for free shipping on orders of $20 or more",
    ]);
    expect([...HEADER_BENEFIT_COMPACT_IDS].sort()).toEqual(["free-shipping", "promo-code"]);
  });

  test.each([
    [4999, "$49.99"],
    [5000, "$50"],
    [100000, "$1,000"],
  ])("threshold %p cents renders as %s (data-driven, cents kept only when present)", (cents, text) => {
    const strip = buildHeaderBenefits({ freeShippingThresholdCents: cents, currency: "USD", coupon: null });
    expect(strip.items[0]?.label).toBe(`Free standard shipping on orders of ${text} or more`);
  });

  test("the threshold is never hardcoded in the content or fallback copy", () => {
    for (const rel of ["src/content/header-benefits.ts", "src/app/_layout/header-benefits.ts"]) {
      const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\$\s?\d/);
    }
  });

  test("below md only the compact items render visibly; all four from md", () => {
    render(<SiteHeader {...headerProps()} />);
    const strip = screen.getByTestId("header-benefits");
    const items = within(strip).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    const visibleBelowMd = items.filter((li) => !classesOf(li).includes("hidden")).map((li) => li.textContent);
    expect(visibleBelowMd).toEqual([
      "Free standard shipping on orders of $35 or more",
      "Use code FREESHIP for free shipping on orders of $20 or more",
    ]);
    for (const li of items) {
      const c = classesOf(li);
      if (c.includes("hidden")) expect(c).toContain("md:flex");
    }
    // No horizontal scroller below md (the cut-off "Trac..." row): only md:overflow-x-auto.
    const scroller = strip.firstElementChild;
    expect(classesOf(scroller).filter((c) => /^overflow-x-/.test(c))).toEqual([]);
  });

  test("no JS needed: server HTML carries wordmark, search form, benefits copy, account link and cart", () => {
    const html = renderToStaticMarkup(<SiteHeader {...headerProps()} />);
    for (const text of [
      "Northwind Goods",
      "Free standard shipping on orders of $35 or more",
      "Use code FREESHIP for free shipping on orders of $20 or more",
      "Hello, Sign in, Account &amp; Lists",
      'href="/cart"',
      "<form",
    ]) {
      expect(html).toContain(text);
    }
  });

  test("header files carry no retailer words", () => {
    for (const rel of [
      "src/components/organisms/SiteHeader/SiteHeader.tsx",
      "src/components/organisms/SiteHeader/HeaderBenefitsRow.tsx",
      "src/content/header-benefits.ts",
      "src/app/_layout/header-benefits.ts",
    ]) {
      expect(brandAndThemeViolations(read(rel))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// U03 Hero + U19 deal thumbnail
// ---------------------------------------------------------------------------

describe("T181 U03 hero", () => {
  test("no-JS carousel: 3 slides with ids, anchor dots #slide-n pointing at them", () => {
    const html = renderToStaticMarkup(<HeroBanner slides={HOME_CONTENT.hero.slides} headingLevel={1} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<button");
    render(<HeroBanner slides={HOME_CONTENT.hero.slides} headingLevel={1} />);
    const slides = document.querySelectorAll("[data-hero-slide]");
    expect(slides).toHaveLength(3);
    const dots = [...document.querySelectorAll("[data-hero-dots] a")].map((a) => a.getAttribute("href"));
    expect(dots).toEqual(["#slide-1", "#slide-2", "#slide-3"]);
    for (const href of dots) expect(document.getElementById(href?.slice(1) ?? "")).not.toBeNull();
  });

  test("first slide image eager, others lazy; alt texts are the manifest's", () => {
    render(<HeroBanner slides={HOME_CONTENT.hero.slides} headingLevel={1} />);
    const imgs = [...document.querySelectorAll("[data-hero-art] img")];
    expect(imgs).toHaveLength(3);
    expect(imgs.map((i) => i.getAttribute("loading"))).toEqual(["eager", "lazy", "lazy"]);
    expect(imgs.map((i) => i.getAttribute("alt"))).toEqual(HERO_SLIDE_ART.map((a) => a.alt));
  });

  test("art: 16:9 block under the copy below md, absolute right half from md, no inner frame", () => {
    render(<HeroBanner slides={HOME_CONTENT.hero.slides} />);
    const art = document.querySelector("[data-hero-art]");
    const c = classesOf(art);
    expect(c).toEqual(
      expect.arrayContaining(["aspect-video", "w-full", "md:absolute", "md:inset-y-0", "md:right-0", "md:w-1/2", "md:aspect-auto"]),
    );
    // Art comes after the copy in the DOM (under it on mobile).
    expect(art?.previousElementSibling?.hasAttribute("data-hero-copy")).toBe(true);
    expect(classesOf(art?.previousElementSibling)).toContain("md:w-1/2");
    // No frame: no border/padding/ring/rounded on the art box; the slide clips it.
    expect(c.filter((x) => /^(border|p-|ring|rounded|shadow)/.test(x))).toEqual([]);
    const slide = art?.parentElement;
    expect(classesOf(slide)).toEqual(expect.arrayContaining(["relative", "overflow-hidden", "rounded-xl"]));
    expect(classesOf(art?.querySelector("img"))).toContain("object-cover");
  });

  test("slide tone matches its art background (blends edge to edge)", () => {
    const toneToken: Record<string, string> = { accent: "accent", promo: "promo", "accent-subtle": "accent-subtle" };
    HOME_CONTENT.hero.slides.forEach((slide, i) => {
      const svg = read(`public${HERO_SLIDE_ART[i]?.path}`);
      const bg = svg.match(/<rect x="0" y="0" width="1200" height="900" fill="(#[0-9a-f]{6})"/)?.[1];
      expect(bg).toBe(raw(toneToken[slide.tone ?? ""] ?? "missing"));
    });
  });

  const HERO_AND_PROMO_SVGS = [
    ...HERO_SLIDE_ART.map((a) => a.path),
    DEALS_PROMO_ART.path,
    BEST_SELLERS_PROMO_ART.path,
    ACCOUNT_PROMO_ART.path,
  ];

  test.each(HERO_AND_PROMO_SVGS)("%s: palette colours only, no text, no brand words, no script/external refs", (path) => {
    const svg = read(`public${path}`);
    const palette = new Set(Object.values(PALETTE));
    const colours = [...svg.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
    expect(colours.length).toBeGreaterThan(0);
    expect(colours.filter((c) => !palette.has(c))).toEqual([]);
    expect(svg).not.toMatch(/rgb\(|hsl\(|<text|<script|href=|url\(|on[a-z]+=/i);
    expect(brandAndThemeViolations(svg)).toEqual([]);
  });
});

const DEAL: HomeHeroDeal = {
  title: "Gooseneck Pour-Over Kettle",
  priceCents: 3999,
  listPriceCents: 4999,
  currency: "USD",
  href: "/products/gooseneck-kettle",
  imageUrl: "/images/products/kettle.svg",
};

function dealSection(): HTMLElement {
  return screen.getByRole("region", { name: "Deal of the day" });
}

function focusables(root: HTMLElement): number {
  return root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])').length;
}

describe("T181 U19 deal thumbnail", () => {
  test("thumbnail is decorative (alt=\"\") and adds no tab stop", () => {
    const { unmount } = render(<HomeHero slides={HOME_CONTENT.hero.slides} deal={{ ...DEAL, imageUrl: null }} />);
    const without = focusables(dealSection());
    unmount();
    render(<HomeHero slides={HOME_CONTENT.hero.slides} deal={DEAL} />);
    const thumb = dealSection().querySelector("[data-deal-thumbnail]");
    expectNotNull(thumb);
    expect(thumb?.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(thumb?.querySelector("a, button, [tabindex]")).toBeNull();
    expect(focusables(dealSection())).toBe(without);
  });

  test.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "//evil.example/x.png",
    "http://evil.example/x.png",
    "\\\\evil.example\\x.png",
    "/\\evil.example/x.png",
    "vbscript:x",
    "  ",
  ])("unsafe image URL %p is rejected and renders no thumbnail", (url) => {
    expect(safeDealImageUrl(url)).toBeNull();
    render(<HomeHero slides={HOME_CONTENT.hero.slides} deal={{ ...DEAL, imageUrl: url }} />);
    expect(dealSection().querySelector("[data-deal-thumbnail]")).toBeNull();
  });

  // PIN: D-T181-1 (fixed by T178 follow-up) — the URL parser strips ASCII tab/LF/CR, so "/\t/evil.example/x.svg" resolves to
  // https://evil.example/x.svg (protocol-relative). safeDealImageUrl only trims, then checks startsWith("//").
  test.each(["/\t/evil.example/x.svg", "/\n/evil.example/x.svg", "/\r/evil.example/x.svg"])(
    "D-T181-1: safeDealImageUrl(%p) should be null (tab/newline-smuggled protocol-relative URL resolves off-site)",
    (url) => {
      expect(new URL(url, "https://shop.example.com").host).toBe("evil.example");
      expect(safeDealImageUrl(url)).toBeNull();
    },
  );

  test("safe URLs are kept", () => {
    expect(safeDealImageUrl("/images/products/kettle.svg")).toBe("/images/products/kettle.svg");
    expect(safeDealImageUrl(" https://cdn.example.com/a.png ")).toBe("https://cdn.example.com/a.png");
  });
});

// ---------------------------------------------------------------------------
// U04 PromoTile + listing promos
// ---------------------------------------------------------------------------

describe("T181 U04 promo tiles", () => {
  test("every listing promo has art", () => {
    for (const promo of LISTING_PROMOS) {
      expect(promo.image).not.toBeNull();
      expect(promo.image?.path).toMatch(/^\/images\/home\/promo-[a-z-]+\.svg$/);
      expect(read(`public${promo.image?.path}`)).toContain("<svg");
    }
  });

  test.each(LISTING_PROMOS.map((p) => [p.id, p] as const))("%s as a two-column tile: split layout with decorative art", (_id, promo) => {
    render(<PromoTile heading={promo.heading} blurb={promo.blurb} cta={promo.cta} image={promo.image} tone={promo.tone} span={2} />);
    const art = document.querySelector("[data-promo-image]");
    expectNotNull(art);
    expect(art?.querySelector("img")?.getAttribute("alt")).toBe("");
    const card = art?.parentElement;
    expect(classesOf(card)).toEqual(expect.arrayContaining(["sm:flex-row", "sm:items-center"]));
    // One link only (stretched), named by the CTA.
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: promo.cta.label })).toBeTruthy();
  });

  test("account tile (primary): brand-blue accent surface, white text, white CTA pill, white focus rings", () => {
    const promo = LISTING_PROMOS.find((p) => p.id === "account");
    expect(promo?.tone).toBe("primary");
    if (!promo) return;
    render(<PromoTile heading={promo.heading} blurb={promo.blurb} cta={promo.cta} image={promo.image} tone="primary" span={2} />);
    const card = screen.getByRole("article");
    const c = classesOf(card);
    expect(c).toEqual(expect.arrayContaining(["bg-accent", "**:focus-visible:outline-focus-ring-inverse"]));
    expect(c).not.toContain("bg-surface-inverse");
    expect(classesOf(screen.getByRole("heading", { name: promo.heading }))).toContain("text-text-inverse");
    expect(classesOf(screen.getByText(promo.blurb))).toContain("text-text-inverse");
    expect(classesOf(screen.getByRole("link"))).toEqual(expect.arrayContaining(["bg-surface-raised", "text-text-primary"]));
  });

  test("one-column tile unchanged: stacked (no sm:flex-row), art first, CTA pushed to the bottom", () => {
    const promo = LISTING_PROMOS[1];
    if (!promo) throw new Error("missing promo");
    render(<PromoTile heading={promo.heading} blurb={promo.blurb} cta={promo.cta} image={promo.image} tone={promo.tone} span={1} />);
    const card = screen.getByRole("article");
    expect(classesOf(card)).not.toContain("sm:flex-row");
    expect(card.firstElementChild?.hasAttribute("data-promo-image")).toBe(true);
    expect(classesOf(screen.getByRole("link"))).toContain("mt-auto");
  });

  test("art backgrounds match their tile surfaces (deals gold, best sellers sunken, account brand blue)", () => {
    const bg = (path: string) => read(`public${path}`).match(/<rect x="0" y="0" width="640" height="400" fill="(#[0-9a-f]{6})"/)?.[1];
    expect(bg(DEALS_PROMO_ART.path)).toBe(raw("promo"));
    expect(bg(BEST_SELLERS_PROMO_ART.path)).toBe(raw("surface-sunken"));
    expect(bg(ACCOUNT_PROMO_ART.path)).toBe(raw("accent"));
  });
});

// ---------------------------------------------------------------------------
// U12 CategoryTile, U11 Toast
// ---------------------------------------------------------------------------

describe("T181 U12 CategoryTile sizes", () => {
  test.each([
    ["circle", "lg", ["w-20", "md:w-32"]],
    ["circle", "md", ["w-20", "md:w-24"]],
    ["circle", "sm", ["w-16"]],
    ["card", "lg", ["w-40", "md:w-56"]],
    ["card", "md", ["w-32", "md:w-40"]],
    ["card", "sm", ["w-28", "md:w-32"]],
  ] as const)("%s %s -> %p and a >= 44px hit area", (shape, size, widths) => {
    render(<CategoryTile href="/category/books" label="Books" imageSrc="/images/home/tile-books.svg" shape={shape} size={size} />);
    const link = screen.getByRole("link", { name: "Books" });
    expect(classesOf(link)).toEqual(expect.arrayContaining([...widths, "min-h-touch", "min-w-touch"]));
    // Smallest width utility used is w-16 (64px) > 44px.
    const base = classesOf(link).find((c) => /^w-\d+$/.test(c));
    expect(Number(base?.slice(2)) * 4).toBeGreaterThanOrEqual(44);
  });

  test("CategoryDiscovery uses auto item width so the card tile sizes itself", () => {
    const src = read("src/components/organisms/CategoryDiscovery/CategoryDiscovery.tsx");
    expect(src).toContain('itemWidth="auto"');
  });
});

describe("T181 U11 Toast placement", () => {
  test("bottom-centre below md, top-right from md under the top bar, z-toast above the sticky header", () => {
    render(
      <ToastProvider>
        <ToastViewport />
      </ToastProvider>,
    );
    const viewports = screen.getAllByRole("region", { name: "Notifications" });
    const c = classesOf(viewports[viewports.length - 1]);
    expect(c).toEqual(
      expect.arrayContaining(["fixed", "bottom-0", "left-0", "right-0", "z-toast", "md:top-16", "md:bottom-auto", "md:left-auto"]),
    );
    const z = (name: string) => Number(BODY.match(new RegExp(`--z-index-${name}:\\s*(\\d+)`))?.[1]);
    expect(z("toast")).toBeGreaterThan(z("sticky"));
  });
});

// ---------------------------------------------------------------------------
// Contrast of the new combinations
// ---------------------------------------------------------------------------

describe("T181 contrast (computed from globals.css :root)", () => {
  test.each([
    ["text-inverse", "accent", 4.5, "PromoTile primary heading/blurb, hero slide 1"],
    ["text-on-accent", "accent", 4.5, "Card accent text"],
    ["text-primary", "surface-raised", 4.5, "inverse CTA pill label"],
    ["surface-raised", "accent", 3, "inverse CTA pill edge on blue"],
    ["focus-ring-inverse", "accent", 3, "focus ring inside the blue tile"],
    ["text-primary", "promo", 4.5, "deals tile copy on gold"],
    ["focus-ring", "promo", 3, "focus ring on the gold tile"],
    ["accent", "promo", 3, "primary CTA fill on gold"],
    ["text-primary", "surface-sunken", 4.5, "benefits captions, best sellers tile"],
    ["accent", "surface-sunken", 3, "benefits icons"],
    ["text-secondary", "surface-raised", 4.5, "brand tile product counts"],
    ["text-primary", "accent-subtle", 4.5, "hero slide 3 copy"],
  ])("%s on %s >= %p (%s)", (fg, bg, min) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(min);
  });
});
