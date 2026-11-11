import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { HERO_PANEL_ART, HERO_SLIDE_ART } from "@/content/home-art";
import { HERO_CAROUSEL_LABEL, HeroBanner } from "./HeroBanner";
import { HERO_SLIDE_TONES, type HeroSlide } from "./hero-slides";

let originalWarn: typeof console.warn;
let warn: ReturnType<typeof mock>;
beforeEach(() => {
  originalWarn = console.warn;
  warn = mock(() => {});
  console.warn = warn;
});
afterEach(() => {
  console.warn = originalWarn;
});

const SLIDES: HeroSlide[] = [
  { id: "gifts", headline: "Gifts for everyone", subline: "Free shipping over the threshold.", cta: { label: "Shop deals", href: "/deals" }, image: HERO_SLIDE_ART[0]!, tone: "accent" },
  { id: "kitchen", headline: "Kitchen refresh", cta: { label: "Shop kitchen", href: "/best-sellers" }, image: HERO_SLIDE_ART[1]!, tone: "promo" },
  { id: "tech", headline: "New tech", image: HERO_SLIDE_ART[2]!, tone: "accent-subtle" },
];

describe("HeroBanner v3 carousel (T139, slides)", () => {
  test("zero slides (or only unusable slides) renders nothing", () => {
    expect(render(<HeroBanner slides={[]} />).container.innerHTML).toBe("");
    const unusable = [{ id: "x", headline: "  ", image: HERO_PANEL_ART }];
    expect(renderToStaticMarkup(<HeroBanner slides={unusable} />)).toBe("");
  });

  test("region: role region, carousel roledescription, accessible name (default and custom), id passthrough", () => {
    const { unmount } = render(<HeroBanner slides={SLIDES} id="home-hero" />);
    const region = screen.getByRole("region", { name: HERO_CAROUSEL_LABEL });
    expect(region).toHaveAttribute("aria-roledescription", "carousel");
    expect(region).toHaveAttribute("id", "home-hero");
    unmount();
    render(<HeroBanner slides={SLIDES} label="  Holiday offers " />);
    expect(screen.getByRole("region", { name: "Holiday offers" })).toBeInTheDocument();
  });

  test("slides are groups labelled n of N with #slide-n anchors, in order", () => {
    render(<HeroBanner slides={SLIDES} />);
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    expect(groups.map((g) => g.id)).toEqual(["slide-1", "slide-2", "slide-3"]);
    for (const g of groups) expect(g).toHaveAttribute("aria-roledescription", "slide");
  });

  test("N>1: N dot links to #slide-n named 'Slide n of N', only the first aria-current (server-rendered)", () => {
    const html = renderToStaticMarkup(<HeroBanner slides={SLIDES} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const dots = Array.from(doc.querySelectorAll("[data-hero-dots] a"));
    expect(dots.map((a) => a.getAttribute("href"))).toEqual(["#slide-1", "#slide-2", "#slide-3"]);
    expect(dots.map((a) => a.textContent)).toEqual(["Slide 1 of 3", "Slide 2 of 3", "Slide 3 of 3"]);
    expect(dots.map((a) => a.getAttribute("aria-current"))).toEqual(["true", null, null]);
    for (const a of dots) expect(a.className).toContain("min-h-touch");
    render(<HeroBanner slides={SLIDES} />);
    expect(screen.getByRole("link", { name: "Slide 2 of 3" })).toHaveAttribute("href", "#slide-2");
  });

  test("one slide: no dots, no scroll-snap track, still labelled 1 of 1", () => {
    const { container } = render(<HeroBanner slides={[SLIDES[0]!]} />);
    expect(container.querySelector("[data-hero-dots]")).toBeNull();
    expect(screen.queryByRole("link", { name: /^Slide / })).toBeNull();
    expect(screen.getByRole("group", { name: "1 of 1" })).toBeInTheDocument();
    expect(container.querySelector("[data-hero-track]")).not.toHaveClass("overflow-x-auto");
  });

  test("track: horizontal scroll-snap inside its own container; smooth scrolling only under motion-safe", () => {
    const { container } = render(<HeroBanner slides={SLIDES} />);
    const track = container.querySelector("[data-hero-track]");
    expect(track).toHaveClass("flex", "min-w-0", "snap-x", "snap-mandatory", "overflow-x-auto", "motion-safe:scroll-smooth");
    expect(track?.className).not.toMatch(/(^|\s)scroll-smooth/);
    const region = screen.getByRole("region");
    expect(region).toHaveClass("w-full", "min-w-0");
    expect(region.className).not.toMatch(/overflow-x-(auto|scroll)/);
    for (const slide of screen.getAllByRole("group")) {
      expect(slide).toHaveClass("w-full", "min-w-0", "shrink-0", "snap-start");
    }
  });

  test("stacks below 768px (text first, 16:9 art second); from md the art fills the right half edge to edge, no frame (T178)", () => {
    render(<HeroBanner slides={SLIDES} />);
    const slide = screen.getByRole("group", { name: "1 of 3" });
    expect(slide).toHaveClass("flex-col", "relative", "overflow-hidden", "rounded-xl");
    const art = slide.querySelector("[data-hero-art]");
    expect(art).not.toBeNull();
    expect(art).toHaveClass("aspect-video", "w-full", "md:absolute", "md:inset-y-0", "md:right-0", "md:w-1/2", "md:aspect-auto");
    expect(art).not.toHaveClass("p-2");
    expect(art).not.toHaveClass("shadow-md");
    expect(slide.querySelector("[data-hero-copy]")).toHaveClass("md:w-1/2");
    expect(slide.querySelector("img")).toHaveClass("h-full", "w-full", "object-cover");
    const heading = screen.getByRole("heading", { name: "Gifts for everyone" });
    const img = slide.querySelector("img");
    expect(img).not.toBeNull();
    expect(heading.compareDocumentPosition(img as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("first image eager/priority, the rest lazy; all have alt, width and height", () => {
    const { container } = render(<HeroBanner slides={SLIDES} />);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs).toHaveLength(3);
    expect(imgs[0]).toHaveAttribute("loading", "eager");
    expect(imgs[1]).toHaveAttribute("loading", "lazy");
    expect(imgs[2]).toHaveAttribute("loading", "lazy");
    imgs.forEach((img, i) => {
      expect(img).toHaveAttribute("alt", HERO_SLIDE_ART[i]!.alt);
      expect(img).toHaveAttribute("width", String(HERO_SLIDE_ART[i]!.width));
      expect(img).toHaveAttribute("height", String(HERO_SLIDE_ART[i]!.height));
    });
  });

  test("priority={false} makes every image lazy", () => {
    const { container } = render(<HeroBanner slides={SLIDES} priority={false} />);
    for (const img of Array.from(container.querySelectorAll("img"))) expect(img).toHaveAttribute("loading", "lazy");
  });

  test("invalid CTA href drops the CTA (never '#') but keeps the slide", () => {
    const slides: HeroSlide[] = [
      { ...SLIDES[0]!, cta: { label: "Evil", href: "javascript:alert(1)" } },
      { ...SLIDES[1]!, cta: { label: "Off-site", href: "https://evil.example/" } },
    ];
    const { container } = render(<HeroBanner slides={slides} />);
    expect(screen.getAllByRole("group")).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Evil" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Off-site" })).toBeNull();
    expect(container.querySelector('a[href="#"]')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("valid CTA: pill link with the allowed href; white inverse pill + inverse focus ring on accent, primary on promo", () => {
    render(<HeroBanner slides={SLIDES} />);
    const onAccent = screen.getByRole("link", { name: "Shop deals" });
    expect(onAccent).toHaveAttribute("href", "/deals");
    expect(onAccent).toHaveClass("rounded-full", "bg-surface-raised", "text-text-primary", "focus-visible:outline-focus-ring-inverse");
    const onPromo = screen.getByRole("link", { name: "Shop kitchen" });
    expect(onPromo).toHaveClass("bg-accent", "text-text-on-accent");
    expect(onPromo).not.toHaveClass("focus-visible:outline-focus-ring-inverse");
    expect(warn).not.toHaveBeenCalled();
  });

  test("tone maps to documented surface/text pairs; unknown tone and missing tone fall back to neutral", () => {
    const expected: Record<(typeof HERO_SLIDE_TONES)[number], string[]> = {
      neutral: ["bg-surface-sunken", "text-text-primary"],
      accent: ["bg-accent", "text-text-inverse"],
      "accent-subtle": ["bg-accent-subtle", "text-text-primary"],
      promo: ["bg-promo", "text-text-primary"],
      "promo-subtle": ["bg-promo-subtle", "text-text-primary"],
      inverse: ["bg-surface-inverse", "text-text-inverse"],
    };
    for (const tone of HERO_SLIDE_TONES) {
      const { unmount } = render(<HeroBanner slides={[{ ...SLIDES[0]!, tone }]} />);
      const slide = screen.getByRole("group");
      expect(slide).toHaveAttribute("data-tone", tone);
      expect(slide).toHaveClass(...expected[tone]);
      unmount();
    }
    const bogus = { ...SLIDES[0]!, tone: "red" as unknown as HeroSlide["tone"] };
    const { unmount } = render(<HeroBanner slides={[bogus]} />);
    expect(screen.getByRole("group")).toHaveAttribute("data-tone", "neutral");
    unmount();
    const noTone: HeroSlide = { id: "plain", headline: "Plain", image: HERO_PANEL_ART };
    render(<HeroBanner slides={[noTone]} />);
    expect(screen.getByRole("group")).toHaveClass("bg-surface-sunken");
  });

  test("headline text colour follows the tone (inverse on accent/inverse, default otherwise)", () => {
    render(<HeroBanner slides={SLIDES} />);
    expect(screen.getByRole("heading", { name: "Gifts for everyone" })).toHaveClass("text-text-inverse");
    expect(screen.getByText("Free shipping over the threshold.")).toHaveClass("text-text-inverse");
    expect(screen.getByRole("heading", { name: "Kitchen refresh" })).toHaveClass("text-text-primary");
  });

  test("headings: level 2 by default for every slide; no h1 unless asked", () => {
    const { container } = render(<HeroBanner slides={SLIDES} />);
    expect(container.querySelectorAll("h1")).toHaveLength(0);
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(3);
  });

  test("headingLevel 3 applies to every slide; headingLevel 1 makes only the first slide an h1", () => {
    const three = render(<HeroBanner slides={SLIDES} headingLevel={3} />);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(3);
    three.unmount();
    const { container } = render(<HeroBanner slides={SLIDES} headingLevel={1} />);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Gifts for everyone");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  test("subline and CTA are optional", () => {
    render(<HeroBanner slides={[SLIDES[2]!]} />);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByRole("group").querySelectorAll("p")).toHaveLength(0);
  });

  test("slideIdPrefix renames anchors and dots; unsafe prefixes fall back to 'slide'", () => {
    const { unmount } = render(<HeroBanner slides={SLIDES} slideIdPrefix="promo" />);
    expect(screen.getAllByRole("group").map((g) => g.id)).toEqual(["promo-1", "promo-2", "promo-3"]);
    expect(screen.getByRole("link", { name: "Slide 3 of 3" })).toHaveAttribute("href", "#promo-3");
    unmount();
    render(<HeroBanner slides={SLIDES} slideIdPrefix={'x" onmouseover="1'} />);
    expect(screen.getAllByRole("group")[0]).toHaveAttribute("id", "slide-1");
  });

  test("no autoplay: no timers in the source, no live region, no pause/autoplay controls", () => {
    const source = readFileSync(join(import.meta.dir, "HeroBanner.tsx"), "utf8");
    expect(source).not.toMatch(/setInterval|setTimeout|useEffect|requestAnimationFrame|autoplay/i);
    expect(source).not.toMatch(/^["']use client["']/m);
    const html = renderToStaticMarkup(<HeroBanner slides={SLIDES} />);
    expect(html).not.toMatch(/aria-live|autoplay|<button/i);
    // No animations of our own (atom colour transitions are cut by the reduced-motion base layer).
    expect(html).not.toMatch(/animate-/);
  });

  test("hostile text renders as text (server markup escapes it)", () => {
    const hostile = `<script>alert(1)</script><img src=x onerror=alert(2)>`;
    const slides: HeroSlide[] = [
      { id: "h", headline: hostile, subline: hostile, cta: { label: hostile, href: "/deals" }, image: { ...HERO_PANEL_ART, alt: hostile } },
    ];
    const { container } = render(<HeroBanner slides={slides} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("heading")).toHaveTextContent(hostile);
    const html = renderToStaticMarkup(<HeroBanner slides={slides} />);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("T151: the deprecated Phase 2 `heading` band is gone (slides is the only API)", () => {
    const source = readFileSync(join(import.meta.dir, "HeroBanner.tsx"), "utf8");
    expect(source).not.toMatch(/LegacyHeroBanner|HeroBannerLegacyProps|heading\?: (string|never)/);
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(index).not.toMatch(/HERO_BANNER_IMAGE_SIZES|HeroBannerTone|HeroBannerCta|HeroBannerAlign/);
    // Every render is the carousel region, never a bare <section> band.
    const html = renderToStaticMarkup(<HeroBanner slides={[SLIDES[2]!]} />);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-roledescription="carousel"');
    expect(html).not.toContain("<section");
  });
});
