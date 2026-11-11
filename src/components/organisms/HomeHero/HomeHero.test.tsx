import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { HeroSlide } from "@/components/molecules/HeroBanner";
import { HERO_PANEL_ART, HERO_SLIDE_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";
import {
  bannerToHeroSlide,
  HOME_HERO_ID,
  HOME_HERO_MAX_SLIDES,
  HomeHero,
  normaliseDeal,
  resolveHomeHeroSlides,
  safeDealImageUrl,
  type HomeHeroBanner,
  type HomeHeroDeal,
} from "./HomeHero";
import { formatIsoDate, isSupportedCurrency, parseIsoDate, tryFormatMoney } from "./home-format";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

const SLIDES: HeroSlide[] = [
  { id: "gifts", headline: "Gifts for everyone", subline: "Free shipping over $35.", cta: { label: "Shop deals", href: "/deals" }, image: HERO_SLIDE_ART[0]!, tone: "accent" },
  { id: "kitchen", headline: "Kitchen refresh", cta: { label: "Shop best sellers", href: "/best-sellers" }, image: HERO_SLIDE_ART[1]!, tone: "promo" },
  { id: "tech", headline: "New tech", image: HERO_SLIDE_ART[2]!, tone: "accent-subtle" },
];

const banner: HomeHeroBanner = {
  title: "Everyday essentials, delivered",
  subtitle: "Free shipping on orders over $35.",
  cta: { label: "Shop deals", href: "/deals" },
};

const deal: HomeHeroDeal = {
  title: "Noise-cancelling headphones",
  priceCents: 7999,
  listPriceCents: 9999,
  currency: "USD",
  href: "/products/noise-cancelling-headphones",
  endsAt: "2026-11-09T23:59:00Z",
};

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

function allHrefs(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
}

describe("HomeHero: empty input (T151 AC1)", () => {
  test("zero slides renders nothing, even with a valid deal", () => {
    expect(renderToStaticMarkup(<HomeHero slides={[]} deal={deal} />)).toBe("");
    expect(renderToStaticMarkup(<HomeHero />)).toBe("");
    expect(renderToStaticMarkup(<HomeHero slides={null} banner={null} deal={deal} />)).toBe("");
  });

  test("only unusable slides (blank headline, unsized image, non-objects) renders nothing", () => {
    const bad = [
      { ...SLIDES[0]!, headline: "   " },
      { ...SLIDES[1]!, image: { ...HERO_PANEL_ART, width: 0 } },
      null as unknown as HeroSlide,
      "x" as unknown as HeroSlide,
    ];
    expect(renderToStaticMarkup(<HomeHero slides={bad} deal={deal} />)).toBe("");
  });

  test("slides given (even empty) win over the deprecated banner", () => {
    expect(renderToStaticMarkup(<HomeHero slides={[]} banner={banner} />)).toBe("");
    render(<HomeHero slides={[SLIDES[2]!]} banner={banner} />);
    expect(screen.queryByText(banner.title)).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "New tech" })).toBeInTheDocument();
  });
});

describe("HomeHero: carousel (contract H-1, H-8, H-9)", () => {
  test("root region #home-hero is the carousel with the content label; first headline is the single h1", () => {
    render(<HomeHero slides={SLIDES} label="Featured offers this week" />);
    const region = screen.getByRole("region", { name: "Featured offers this week" });
    expect(region.id).toBe(HOME_HERO_ID);
    expect(region.getAttribute("aria-roledescription")).toBe("carousel");
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("Gifts for everyone");
    expect(region.contains(h1s[0]!)).toBe(true);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Kitchen refresh", "New tech"]);
  });

  test("label defaults to the HeroBanner default when not given", () => {
    render(<HomeHero slides={SLIDES} />);
    expect(screen.getByRole("region", { name: "Featured offers" }).id).toBe("home-hero");
  });

  test("3 slides: labelled n of 3, 3 dot links, only the first aria-current", () => {
    const { container } = render(<HomeHero slides={SLIDES} />);
    const groups = container.querySelectorAll("[aria-roledescription='slide']");
    expect(Array.from(groups).map((g) => g.getAttribute("aria-label"))).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    const dots = ["Slide 1 of 3", "Slide 2 of 3", "Slide 3 of 3"].map((name) => screen.getByRole("link", { name }));
    expect(dots.map((d) => d.getAttribute("href"))).toEqual(["#slide-1", "#slide-2", "#slide-3"]);
    expect(dots.filter((d) => d.hasAttribute("aria-current"))).toHaveLength(1);
  });

  test("1 slide: no dots", () => {
    render(<HomeHero slides={[SLIDES[0]!]} />);
    expect(screen.queryByRole("link", { name: /^Slide \d+ of \d+$/ })).toBeNull();
    expect(screen.getByRole("group", { name: "1 of 1" })).toBeInTheDocument();
  });

  test(`at most ${HOME_HERO_MAX_SLIDES} slides are shown (usable ones, in order)`, () => {
    const many: HeroSlide[] = [
      { ...SLIDES[0]!, headline: "  " },
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, headline: `Slide headline ${n}`, image: HERO_PANEL_ART })),
    ];
    const resolved = resolveHomeHeroSlides(many);
    expect(resolved.map((s) => s.headline)).toEqual(["Slide headline 1", "Slide headline 2", "Slide headline 3"]);
    const { container } = render(<HomeHero slides={many} />);
    expect(container.querySelectorAll("[aria-roledescription='slide']")).toHaveLength(HOME_HERO_MAX_SLIDES);
  });

  test("first slide image eager, the others lazy; no autoplay, no buttons, no live region", () => {
    const { container } = render(<HomeHero slides={SLIDES} />);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs).toHaveLength(3);
    expect(imgs[0]!.getAttribute("loading")).not.toBe("lazy");
    expect(imgs.slice(1).every((img) => img.getAttribute("loading") === "lazy")).toBe(true);
    const html = renderToStaticMarkup(<HomeHero slides={SLIDES} deal={deal} />);
    expect(html).not.toMatch(/autoplay|aria-live|<button/i);
    const src = readFileSync(join(import.meta.dir, "HomeHero.tsx"), "utf8");
    expect(src).not.toMatch(/setInterval|setTimeout|useEffect/);
  });

  test("headingLevel 2 (non-home use): no h1, deal heading h3", () => {
    render(<HomeHero slides={SLIDES} deal={deal} headingLevel={2} />);
    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "Gifts for everyone" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Deal of the day" })).toBeInTheDocument();
  });

  test("custom id renames the region and prefixes the deal heading id; unsafe ids fall back to home-hero", () => {
    const { unmount } = render(<HomeHero slides={SLIDES} deal={deal} id="hero" />);
    expect(screen.getByRole("region", { name: "Featured offers" }).id).toBe("hero");
    expect(screen.getByRole("heading", { name: "Deal of the day" }).id).toBe("hero-deal-heading");
    unmount();
    render(<HomeHero slides={SLIDES} id={'x" onload="1'} />);
    expect(screen.getByRole("region", { name: "Featured offers" }).id).toBe("home-hero");
  });

  test("unsafe slide CTA is dropped (one dev warning), the slide stays", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <HomeHero slides={[{ ...SLIDES[0]!, cta: { label: "Evil", href: "javascript:alert(1)" } }]} />,
    );
    expect(screen.queryByRole("link", { name: "Evil" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Gifts for everyone" })).toBeInTheDocument();
    expect(allHrefs(container)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("HomeHero: deal panel (T151 AC2)", () => {
  test("deal panel is a region labelled by its own h2 (one level below the h1)", () => {
    render(<HomeHero slides={SLIDES} deal={deal} />);
    const region = screen.getByRole("region", { name: "Deal of the day" });
    const heading = within(region).getByRole("heading", { level: 2, name: "Deal of the day" });
    expect(heading.id).toBe("home-hero-deal-heading");
    expect(region.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  test("deal shows name, superscript price (read as the full amount), savings, end date and one PDP link", () => {
    render(<HomeHero slides={SLIDES} deal={deal} />);
    const region = screen.getByRole("region", { name: "Deal of the day" });
    expect(region).toHaveTextContent(deal.title);
    expect(region).toHaveTextContent("$79.99");
    expect(region.querySelector("[data-slot='price-superscript']")).not.toBeNull();
    expect(region).toHaveTextContent("You save $20.00 (20%)");
    expect(region).toHaveTextContent("Ends Nov 9, 2026");
    expect(region.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-09T23:59:00Z");
    const links = within(region).getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAccessibleName(/^View deal ?: Noise-cancelling headphones$/);
    expect(links[0]!.getAttribute("href")).toBe(deal.href);
  });

  test("with a deal the carousel spans 2 of 3 columns from lg; without, full width and no deal region", () => {
    const withDeal = render(<HomeHero slides={SLIDES} deal={deal} />);
    expect(withDeal.container.firstElementChild?.className).toContain("lg:grid-cols-3");
    expect(withDeal.container.querySelector("#home-hero")?.className).toContain("lg:col-span-2");
    withDeal.unmount();
    const { container } = render(<HomeHero slides={SLIDES} />);
    expect(screen.queryByRole("region", { name: "Deal of the day" })).toBeNull();
    expect(container.firstElementChild?.className).not.toContain("lg:grid-cols-3");
  });

  test("invalid deal fields drop the deal, never throw; the carousel stays", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const bad: HomeHeroDeal[] = [
      { ...deal, priceCents: Number.NaN },
      { ...deal, priceCents: -1 },
      { ...deal, priceCents: 1.5 },
      { ...deal, currency: "not-a-currency" },
      { ...deal, currency: "" },
      { ...deal, title: "  " },
      { ...deal, href: "javascript:alert(1)" },
      { ...deal, href: "//evil.example/x" },
      { ...deal, href: "https://evil.example/" },
      { ...deal, href: "/not-a-route" },
    ];
    for (const d of bad) {
      expect(normaliseDeal(d)).toBeNull();
      const html = renderToStaticMarkup(<HomeHero slides={SLIDES} deal={d} />);
      expect(html).not.toContain("Deal of the day");
      expect(html).toContain("Gifts for everyone");
    }
    expect(normaliseDeal(null)).toBeNull();
    expect(normaliseDeal("x" as unknown as HomeHeroDeal)).toBeNull();
  });

  test("invalid list price falls back to the plain price; invalid endsAt hides the date", () => {
    render(<HomeHero slides={SLIDES} deal={{ ...deal, listPriceCents: Number.NaN, endsAt: "2026-02-31" }} />);
    const region = screen.getByRole("region", { name: "Deal of the day" });
    expect(region).toHaveTextContent("$79.99");
    expect(region).not.toHaveTextContent("You save");
    expect(region).not.toHaveTextContent("Ends");
  });
});

describe("HomeHero: deal thumbnail (T178, U19)", () => {
  test("decorative product thumbnail (112px box, rounded) sits between the title and the price", () => {
    const { container } = render(<HomeHero slides={SLIDES} deal={{ ...deal, imageUrl: "/images/products/headphones.svg" }} />);
    const region = screen.getByRole("region", { name: "Deal of the day" });
    const thumb = region.querySelector("[data-deal-thumbnail]");
    expect(thumb).not.toBeNull();
    expect(thumb?.getAttribute("class") ?? "").toContain("size-28");
    expect(thumb?.getAttribute("class") ?? "").toContain("rounded-lg");
    const img = thumb?.querySelector("img");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("src") ?? "").toContain("headphones.svg");
    const title = within(region).getByText(deal.title);
    const price = region.querySelector("[data-slot='price-superscript']");
    expect(title.compareDocumentPosition(thumb as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect((thumb as Node).compareDocumentPosition(price as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // still one link in the panel; the image adds no tab stop
    expect(within(region).getAllByRole("link")).toHaveLength(1);
    expect(container.querySelectorAll("#home-hero img").length).toBe(SLIDES.length);
  });

  test("missing, blank or unsafe image URLs render no thumbnail; the deal stays", () => {
    for (const imageUrl of [undefined, null, "", "   ", "javascript:alert(1)", "//evil.example/a.png", "http://x/a.png", "/a\\b.png", "data:image/png;base64,x"]) {
      const html = renderToStaticMarkup(<HomeHero slides={SLIDES} deal={{ ...deal, imageUrl }} />);
      expect({ imageUrl, thumb: html.includes("data-deal-thumbnail") }).toEqual({ imageUrl, thumb: false });
      expect(html).toContain("Deal of the day");
    }
  });

  test("safeDealImageUrl keeps site-relative and https URLs only (trimmed)", () => {
    expect(safeDealImageUrl(" /images/p.svg ")).toBe("/images/p.svg");
    expect(safeDealImageUrl("https://cdn.example/p.png")).toBe("https://cdn.example/p.png");
    for (const bad of [42, null, undefined, "", "//x", "http://x", "javascript:x", "p.svg"]) expect(safeDealImageUrl(bad)).toBeNull();
  });

  test("D-T181-1: tab, LF or CR inside the URL is rejected (browsers strip them, turning /<ctl>/host into //host)", () => {
    for (const ctl of ["\t", "\n", "\r"]) {
      const url = `/${ctl}/evil.example/x.svg`;
      expect({ url, out: safeDealImageUrl(url) }).toEqual({ url, out: null });
      const html = renderToStaticMarkup(<HomeHero slides={SLIDES} deal={{ ...deal, imageUrl: url }} />);
      expect(html).not.toContain("data-deal-thumbnail");
      expect(html).not.toContain("evil.example");
    }
    for (const bad of ["/images/a b.svg", "https://cdn.example/a\u0000.png", "/images/x\u007f.svg", "https://\tevil.example/x.svg"]) {
      expect({ bad, out: safeDealImageUrl(bad) }).toEqual({ bad, out: null });
    }
    expect(safeDealImageUrl("/images/products/x.svg")).toBe("/images/products/x.svg");
    expect(safeDealImageUrl("https://cdn.example/p.png")).toBe("https://cdn.example/p.png");
  });
});

describe("HomeHero: deprecated banner compatibility (until T165 passes slides)", () => {
  test("banner maps onto one slide: title h1, subtitle, CTA, placeholder panel art (with alt), accent-subtle tone", () => {
    const slide = bannerToHeroSlide(banner);
    expect(slide).toEqual({
      id: "home-banner",
      headline: banner.title,
      subline: banner.subtitle ?? null,
      cta: banner.cta ?? null,
      image: HERO_PANEL_ART,
      tone: "accent-subtle",
    });
    const { container } = render(<HomeHero banner={banner} deal={deal} />);
    expect(screen.getByRole("heading", { level: 1, name: banner.title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Shop deals" }).getAttribute("href")).toBe("/deals");
    expect(container.querySelector("#home-hero")?.getAttribute("aria-roledescription")).toBe("carousel");
  });

  test("banner tone and image map; raised -> neutral; blank image url -> placeholder art", () => {
    expect(bannerToHeroSlide({ title: "T", tone: "raised" })?.tone).toBe("neutral");
    expect(bannerToHeroSlide({ title: "T", tone: "inverse" })?.tone).toBe("inverse");
    expect(bannerToHeroSlide({ title: "T", image: { url: " /images/x.svg ", alt: "X" } })?.image).toEqual({
      path: "/images/x.svg",
      alt: "X",
      width: 800,
      height: 600,
    });
    expect(bannerToHeroSlide({ title: "T", image: { url: "  ", alt: "X" } })?.image.path).toBe(HERO_PANEL_ART.path);
  });

  test("missing banner, non-object or blank title -> null / nothing rendered", () => {
    for (const b of [null, undefined, "x" as unknown as HomeHeroBanner, { title: "   " }, { title: 42 as unknown as string }]) {
      expect(bannerToHeroSlide(b)).toBeNull();
      expect(renderToStaticMarkup(<HomeHero banner={b} deal={deal} />)).toBe("");
    }
  });

  test("eyebrow and secondaryCta are ignored; unsafe banner CTA dropped (never '#')", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const { container } = render(
      <HomeHero
        banner={{
          ...banner,
          eyebrow: "Ignored eyebrow",
          cta: { label: "Bad", href: "javascript:alert(1)" },
          secondaryCta: { label: "Also ignored", href: "/products" },
        }}
      />,
    );
    expect(screen.queryByText("Ignored eyebrow")).toBeNull();
    expect(screen.queryByRole("link", { name: "Bad" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Also ignored" })).toBeNull();
    expect(allHrefs(container)).toEqual([]);
  });
});

describe("HomeHero: hostile input and markup", () => {
  test("hostile headline / subline / deal name render as text", () => {
    const slides: HeroSlide[] = [{ id: "h", headline: HOSTILE, subline: HOSTILE, image: HERO_PANEL_ART }];
    const html = renderToStaticMarkup(<HomeHero slides={slides} deal={{ ...deal, title: HOSTILE }} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    render(<HomeHero slides={slides} deal={{ ...deal, title: HOSTILE }} />);
    expect(screen.getByRole("heading", { level: 1, name: HOSTILE })).toBeInTheDocument();
  });

  test("no script, no inline style outside img; every href allowed or a #slide anchor", () => {
    const html = renderToStaticMarkup(<HomeHero slides={SLIDES} deal={deal} />);
    expect(html).not.toContain("<script");
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of Array.from(doc.querySelectorAll("[style]"))) expect(el.tagName).toBe("IMG");
    const hrefs = allHrefs(doc);
    expect(hrefs).toEqual(["/deals", "/best-sellers", "#slide-1", "#slide-2", "#slide-3", deal.href]);
    for (const href of hrefs) expect(href.startsWith("#slide-") || isAllowedInternalHref(href)).toBe(true);
  });
});

describe("home-format helpers", () => {
  test("parseIsoDate accepts ISO dates and date-times, rejects the rest", () => {
    expect(parseIsoDate("2026-11-09")).toBe(Date.UTC(2026, 10, 9));
    expect(parseIsoDate("2026-11-09T12:00:00Z")).toBe(Date.UTC(2026, 10, 9, 12));
    expect(parseIsoDate("2026-11-09T12:00:00")).toBe(Date.UTC(2026, 10, 9, 12));
    expect(parseIsoDate("2026-11-09T12:00:00.000+02:00")).toBe(Date.UTC(2026, 10, 9, 10));
    for (const bad of ["", "  ", "tomorrow", "2026-02-31", "2026-13-01", "2026-11-09T25:00:00Z", "11/09/2026", "1e3", HOSTILE]) {
      expect(parseIsoDate(bad)).toBeNull();
    }
    expect(parseIsoDate(Number.NaN)).toBeNull();
    expect(parseIsoDate(null)).toBeNull();
  });

  test("formatIsoDate formats in UTC", () => {
    expect(formatIsoDate("2026-11-30T23:59:59Z")).toEqual({ iso: "2026-11-30T23:59:59Z", label: "Nov 30, 2026" });
    expect(formatIsoDate("nope")).toBeNull();
  });

  test("tryFormatMoney never throws", () => {
    expect(tryFormatMoney(2500, "usd")).toBe("$25.00");
    expect(tryFormatMoney(Number.NaN, "USD")).toBeNull();
    expect(tryFormatMoney(100, "??")).toBeNull();
    expect(tryFormatMoney(100, undefined)).toBeNull();
  });

  test("tryFormatMoney rejects well-formed but unassigned codes (D-T88-1)", () => {
    for (const code of ["ZZZ", "ABC", "zzz", " ZZZ "]) expect(tryFormatMoney(100, code)).toBeNull();
    expect(tryFormatMoney(100, " eur ")).toBe("€1.00");
    expect(isSupportedCurrency("USD")).toBe(true);
    expect(isSupportedCurrency("usd")).toBe(false);
    expect(isSupportedCurrency("ZZZ")).toBe(false);
  });

  test("a deal priced in an unassigned currency is dropped (D-T88-1)", () => {
    expect(normaliseDeal({ ...deal, currency: "ZZZ" })).toBeNull();
    expect(renderToStaticMarkup(<HomeHero slides={SLIDES} deal={{ ...deal, currency: "ZZZ" }} />)).not.toContain("Deal of the day");
  });
});

describe("HomeHero: server-safe and tokens", () => {
  test("no use client directive", () => {
    const src = readFileSync(join(import.meta.dir, "HomeHero.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
    expect(src).not.toContain("dangerouslySetInnerHTML");
  });
});
