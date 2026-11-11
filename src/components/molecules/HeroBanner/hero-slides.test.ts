import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { HERO_SLIDE_ART } from "@/content/home-art";
import {
  DEFAULT_HERO_SLIDE_TONE,
  HERO_SLIDE_TONES,
  heroDotLabel,
  heroSlideLabel,
  normaliseHeroSlides,
  resolveHeroSlideTone,
  safeHeroCta,
  type HeroSlide,
} from "./hero-slides";

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

const art = HERO_SLIDE_ART[0]!;
const slide = (over: Partial<HeroSlide> = {}): HeroSlide => ({ id: "a", headline: "Gifts", image: art, ...over });

describe("hero-slides", () => {
  test("labels", () => {
    expect(heroSlideLabel(2, 3)).toBe("2 of 3");
    expect(heroDotLabel(2, 3)).toBe("Slide 2 of 3");
  });

  test("tone: token-backed values pass, anything else falls back to neutral", () => {
    for (const tone of HERO_SLIDE_TONES) expect(resolveHeroSlideTone(tone)).toBe(tone);
    expect(DEFAULT_HERO_SLIDE_TONE).toBe("neutral");
    for (const bad of [undefined, null, "", "red", "bg-red", "dark", 3, {}]) {
      expect(resolveHeroSlideTone(bad)).toBe("neutral");
    }
  });

  test("safeHeroCta keeps allowed internal links and trims the label", () => {
    expect(safeHeroCta({ label: "  Shop deals ", href: "/deals" })).toEqual({ label: "Shop deals", href: "/deals" });
    expect(safeHeroCta({ label: "Toys", href: "/category/toys?sort=price#top" })).toEqual({
      label: "Toys",
      href: "/category/toys?sort=price#top",
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["javascript:alert(1)", "//evil.example", "https://evil.example/", "/nope", "", "deals"])(
    "safeHeroCta drops disallowed href %p with a dev warning",
    (href) => {
      expect(safeHeroCta({ label: "Go", href })).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("[HeroBanner]");
    },
  );

  test("safeHeroCta drops blank labels and missing CTAs silently", () => {
    expect(safeHeroCta({ label: "   ", href: "/deals" })).toBeNull();
    expect(safeHeroCta(null)).toBeNull();
    expect(safeHeroCta(undefined)).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  test("normaliseHeroSlides: non-arrays and empty input give []", () => {
    expect(normaliseHeroSlides([])).toEqual([]);
    expect(normaliseHeroSlides(null)).toEqual([]);
    expect(normaliseHeroSlides(undefined)).toEqual([]);
    expect(normaliseHeroSlides("x" as unknown as HeroSlide[])).toEqual([]);
  });

  test("normaliseHeroSlides drops unusable slides, keeps order, trims text", () => {
    const out = normaliseHeroSlides([
      slide({ id: "one", headline: "  One  ", subline: "  Sub  " }),
      null as unknown as HeroSlide,
      slide({ id: "blank", headline: "   " }),
      slide({ id: "noimg", image: null as unknown as HeroSlide["image"] }),
      slide({ id: "badsize", image: { ...art, width: Number.NaN } }),
      slide({ id: "two", headline: "Two", subline: "   " }),
    ]);
    expect(out.map((s) => s.headline)).toEqual(["One", "Two"]);
    expect(out[0]?.subline).toBe("Sub");
    expect(out[1]?.subline).toBeNull();
  });

  test("normaliseHeroSlides: an invalid CTA is dropped but the slide stays", () => {
    const out = normaliseHeroSlides([slide({ cta: { label: "Go", href: "javascript:alert(1)" } })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.cta).toBeNull();
  });

  test("normaliseHeroSlides: blank or duplicate ids get unique keys; unknown tone -> neutral", () => {
    const out = normaliseHeroSlides([
      slide({ id: "x" }),
      slide({ id: "x" }),
      slide({ id: "  " }),
      slide({ id: "y", tone: "bogus" as unknown as HeroSlide["tone"] }),
    ]);
    const keys = out.map((s) => s.key);
    expect(new Set(keys).size).toBe(4);
    expect(out[3]?.tone).toBe("neutral");
  });
});
