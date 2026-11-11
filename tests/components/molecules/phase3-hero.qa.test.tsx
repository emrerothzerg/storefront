// QA (T147, Phase 3 wave A): HeroBanner v3 (T139) against BACKLOG-phase3 T139 AC1-AC6 and
// CONTRACTS H-8 … H-11 (molecule level; #home-hero page rows belong to T163/T172).
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, within } from "@testing-library/react";
import {
  HERO_CAROUSEL_LABEL,
  HERO_SLIDE_TONES,
  HeroBanner,
  normaliseHeroSlides,
  resolveHeroSlideTone,
  type HeroSlide,
} from "@/components/molecules/HeroBanner";
import { HERO_SLIDE_ART } from "@/content/home-art";

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>&amp; ‮evil`;
const ART = { path: "/images/home/hero.svg", alt: "", width: 1200, height: 800 };
const slide = (n: number, over: Partial<HeroSlide> = {}): HeroSlide => ({
  id: `s${n}`,
  headline: `Headline ${n}`,
  subline: `Sub ${n}`,
  cta: { label: `Shop ${n}`, href: "/deals" },
  image: ART,
  ...over,
});
const slides = (n: number) => Array.from({ length: n }, (_, i) => slide(i + 1));

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}
const cls = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("T139 AC2 + H-8: region and slide labelling", () => {
  test("wrapper is role=region, aria-roledescription=carousel, named (default 'Featured offers'), carries the id", () => {
    const doc = parse(renderToStaticMarkup(<HeroBanner id="home-hero" slides={slides(3)} />));
    const root = doc.querySelector("#home-hero");
    expect(root?.getAttribute("role")).toBe("region");
    expect(root?.getAttribute("aria-roledescription")).toBe("carousel");
    expect(root?.getAttribute("aria-label")).toBe(HERO_CAROUSEL_LABEL);
    expect(HERO_CAROUSEL_LABEL).toBe("Featured offers");
  });

  test("blank / whitespace label falls back; a custom label is used as text", () => {
    for (const label of ["", "   "]) {
      const r = render(<HeroBanner label={label} slides={slides(1)} />);
      expect(within(r.container).getByRole("region").getAttribute("aria-label")).toBe(HERO_CAROUSEL_LABEL);
      r.unmount();
    }
    render(<HeroBanner label={HOSTILE} slides={slides(1)} />);
    expect(screen.getByRole("region", { name: HOSTILE.trim() }).getAttribute("aria-roledescription")).toBe("carousel");
  });

  test("3 slides are groups labelled '1 of 3' … '3 of 3' with ids slide-1 … slide-3", () => {
    const doc = parse(renderToStaticMarkup(<HeroBanner slides={slides(3)} />));
    const groups = [...doc.querySelectorAll('[role="group"][aria-roledescription="slide"]')];
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["1 of 3", "2 of 3", "3 of 3"]);
    expect(groups.map((g) => g.id)).toEqual(["slide-1", "slide-2", "slide-3"]);
  });
});

describe("T139 AC1 + H-9: pager dots", () => {
  test("N > 1: N dot links #slide-n named 'Slide n of N'; exactly one aria-current (the first)", () => {
    const { container } = render(<HeroBanner slides={slides(3)} />);
    const dots = [1, 2, 3].map((n) => screen.getByRole("link", { name: `Slide ${n} of 3` }));
    expect(dots.map((d) => d.getAttribute("href"))).toEqual(["#slide-1", "#slide-2", "#slide-3"]);
    expect(dots.map((d) => d.hasAttribute("aria-current"))).toEqual([true, false, false]);
    expect(container.querySelectorAll("[data-hero-dots] a").length).toBe(3);
  });

  test("dots are 44px targets; the visual dot is aria-hidden", () => {
    const doc = parse(renderToStaticMarkup(<HeroBanner slides={slides(2)} />));
    for (const a of doc.querySelectorAll("[data-hero-dots] a")) {
      expect(cls(a)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch"]));
      expect(a.querySelector("span[aria-hidden='true']") === null ? "no visual" : "ok").toBe("ok");
    }
  });

  test("1 slide: no dots, no scrolling track", () => {
    const doc = parse(renderToStaticMarkup(<HeroBanner slides={slides(1)} />));
    expect(doc.querySelector("[data-hero-dots]")).toBeNull();
    expect(doc.querySelectorAll('a[href^="#slide"]').length).toBe(0);
    expect(cls(doc.querySelector("[data-hero-track]"))).not.toContain("overflow-x-auto");
  });

  test("dots counted after normalisation: 3 slides with 1 unusable -> 2 dots labelled 'of 2'", () => {
    render(<HeroBanner slides={[slide(1), slide(2, { headline: "   " }), slide(3)]} />);
    expect(screen.getAllByRole("link", { name: /^Slide \d of 2$/ })).toHaveLength(2);
  });

  test("slideIdPrefix: safe prefix used; unsafe prefix falls back to 'slide'", () => {
    const a = parse(renderToStaticMarkup(<HeroBanner slideIdPrefix="promo" slides={slides(2)} />));
    expect(a.querySelector("#promo-2") === null ? "missing" : "ok").toBe("ok");
    const b = parse(renderToStaticMarkup(<HeroBanner slideIdPrefix={'x" onmouseover="1'} slides={slides(2)} />));
    expect([...b.querySelectorAll("[data-hero-dots] a")].map((x) => x.getAttribute("href"))).toEqual(["#slide-1", "#slide-2"]);
  });
});

describe("T139 AC3 + H-10: images", () => {
  test("first slide image eager with fetchpriority=high; the others lazy; every img has alt, width, height", () => {
    const doc = parse(renderToStaticMarkup(<HeroBanner slides={slides(3)} />));
    const imgs = [...doc.querySelectorAll("img")];
    expect(imgs.map((i) => i.getAttribute("loading"))).toEqual(["eager", "lazy", "lazy"]);
    expect(imgs[0]?.getAttribute("fetchpriority") ?? imgs[0]?.getAttribute("fetchPriority")).toBe("high");
    for (const i of imgs) {
      expect(i.hasAttribute("alt")).toBe(true);
      expect(Number(i.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(i.getAttribute("height"))).toBeGreaterThan(0);
    }
  });

  test("the shipped placeholder art works as slide images", () => {
    const art = HERO_SLIDE_ART.map((image, i) => slide(i + 1, { image }));
    const doc = parse(renderToStaticMarkup(<HeroBanner slides={art} />));
    expect(doc.querySelectorAll("img").length).toBe(HERO_SLIDE_ART.length);
  });

  test("slide with a missing or unsized image is dropped (never a layout-shifting image)", () => {
    const bad = [
      slide(1, { image: undefined as unknown as HeroSlide["image"] }),
      slide(2, { image: { ...ART, width: 0 } }),
      slide(3, { image: { ...ART, height: Number.NaN } }),
      slide(4),
    ];
    expect(normaliseHeroSlides(bad).map((s) => s.headline)).toEqual(["Headline 4"]);
  });
});

describe("T139 AC5 + H-9: zero slides and bad CTAs", () => {
  test("zero slides / null / non-array / all unusable -> renders nothing", () => {
    for (const s of [[], null, undefined, "x", [null, { id: "a", headline: "", image: ART }]] as unknown as HeroSlide[][]) {
      expect(renderToStaticMarkup(<HeroBanner slides={s} />)).toBe("");
    }
  });

  test("invalid CTA hrefs drop the CTA (no link, no '#') but keep the slide; one dev warning each", () => {
    const bad = ["javascript:alert(1)", "//evil.example", "https://evil.example/", "/nope-route", "deals", "/deals/"];
    const doc = parse(
      renderToStaticMarkup(<HeroBanner slides={bad.map((href, i) => slide(i + 1, { cta: { label: "Go", href } }))} />),
    );
    expect(doc.querySelectorAll("[data-hero-slide]").length).toBe(bad.length);
    expect(doc.querySelectorAll("[data-hero-slide] a").length).toBe(0);
    expect(doc.querySelectorAll('a[href="#"]').length).toBe(0);
    expect(warn).toHaveBeenCalledTimes(bad.length);
  });

  test("blank CTA label drops the CTA silently", () => {
    const doc = parse(renderToStaticMarkup(<HeroBanner slides={[slide(1, { cta: { label: "  ", href: "/deals" } })]} />));
    expect(doc.querySelectorAll("[data-hero-slide] a").length).toBe(0);
    expect(warn).toHaveBeenCalledTimes(0);
  });

  test("hostile headline / subline / CTA label render as text", () => {
    const { container } = render(<HeroBanner slides={[slide(1, { headline: HOSTILE, subline: HOSTILE, cta: { label: HOSTILE, href: "/deals" } })]} />);
    expect(container.querySelectorAll("script, img[src='x'], [onerror]").length).toBe(0);
    expect(container.querySelector("h2")?.textContent).toBe(HOSTILE.trim());
  });
});

describe("T139 headings, tones, motion, layout", () => {
  test("headingLevel 1: only slide 1 is h1, others h2; 3: all h3; default 2", () => {
    const one = parse(renderToStaticMarkup(<HeroBanner headingLevel={1} slides={slides(3)} />));
    expect(one.querySelectorAll("h1").length).toBe(1);
    expect(one.querySelectorAll("h2").length).toBe(2);
    expect(parse(renderToStaticMarkup(<HeroBanner headingLevel={3} slides={slides(2)} />)).querySelectorAll("h3").length).toBe(2);
    expect(parse(renderToStaticMarkup(<HeroBanner slides={slides(2)} />)).querySelectorAll("h2").length).toBe(2);
  });

  test("unknown tones fall back to neutral; every listed tone renders a token surface", () => {
    expect(resolveHeroSlideTone("primary")).toBe("neutral");
    expect(resolveHeroSlideTone("__proto__")).toBe("neutral");
    const doc = parse(
      renderToStaticMarkup(
        <HeroBanner slides={[...HERO_SLIDE_TONES, "bogus"].map((tone, i) => slide(i + 1, { tone: tone as HeroSlide["tone"] }))} />,
      ),
    );
    const tones = [...doc.querySelectorAll("[data-hero-slide]")].map((s) => s.getAttribute("data-tone"));
    expect(tones).toEqual([...HERO_SLIDE_TONES, "neutral"]);
    for (const s of doc.querySelectorAll("[data-hero-slide]")) expect(cls(s).some((c) => /^bg-(surface|accent|promo)/.test(c))).toBe(true);
  });

  test("AC6: no autoplay, no timers, smooth scroll only under motion-safe, no animate-* classes", () => {
    const html = renderToStaticMarkup(<HeroBanner slides={slides(3)} />);
    expect(html).not.toMatch(/autoplay|aria-live|animate-|<script/i);
    const track = parse(html).querySelector("[data-hero-track]");
    expect(cls(track)).toContain("motion-safe:scroll-smooth");
    expect(cls(track)).not.toContain("scroll-smooth");
  });

  test("AC4: stacks below md (copy, then 16:9 art); from md the art fills the right half (T178); track scrolls inside itself; no fixed widths without breakpoint", () => {
    const doc = parse(renderToStaticMarkup(<HeroBanner slides={slides(2)} />));
    for (const s of doc.querySelectorAll("[data-hero-slide]")) {
      expect(cls(s)).toEqual(expect.arrayContaining(["flex-col", "relative", "overflow-hidden", "w-full", "min-w-0", "shrink-0", "snap-start"]));
      expect(cls(s.querySelector("[data-hero-art]"))).toEqual(
        expect.arrayContaining(["aspect-video", "md:absolute", "md:inset-y-0", "md:right-0", "md:w-1/2"]),
      );
    }
    expect(cls(doc.querySelector("[data-hero-track]"))).toEqual(expect.arrayContaining(["overflow-x-auto", "snap-x", "min-w-0"]));
    const fixed = [...doc.querySelectorAll("[class]")].flatMap((el) => cls(el)).filter((c) => /^(min-)?w-(\d{2,}|\[)/.test(c));
    expect(fixed).toEqual([]);
  });

  test("tokens only, light only", () => {
    const html = renderToStaticMarkup(<HeroBanner slides={HERO_SLIDE_TONES.map((tone, i) => slide(i + 1, { tone }))} />);
    const all = [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1]!.split(/\s+/));
    expect(all.filter((c) => /\[|^dark:/.test(c))).toEqual([]);
  });
});
