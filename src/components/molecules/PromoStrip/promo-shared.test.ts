import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import { DELIVERY_PROMO_ART } from "@/content/home-art";
import {
  PROMO_TONES,
  PROMO_TONE_CARD,
  cleanPromoText,
  normalisePromoCta,
  normalisePromoHeadingLevel,
  normalisePromoImage,
  normalisePromoTone,
  promoToneStyle,
  safePromoHref,
  type PromoCta,
  type PromoImage,
} from "./promo-shared";

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe("normalisePromoTone", () => {
  test("keeps the four token-backed tones", () => {
    for (const tone of PROMO_TONES) expect(normalisePromoTone(tone)).toBe(tone);
  });

  test("unknown, blank, cased and non-string input falls back to neutral without throwing", () => {
    for (const bad of ["", "PRIMARY", "danger", "promo", "inverse", " primary", null, undefined, 3, {}, []]) {
      expect(normalisePromoTone(bad)).toBe("neutral");
    }
  });

  test("maps onto the Card tones the designer shipped", () => {
    expect(PROMO_TONE_CARD).toEqual({
      primary: "inverse",
      "primary-subtle": "accent-subtle",
      neutral: "sunken",
      accent: "promo",
    });
  });

  test("inverse band gets inverse heading/text/CTA; every other band keeps dark text and the primary CTA", () => {
    expect(promoToneStyle("primary")).toEqual({
      card: "inverse",
      heading: "inverse",
      text: "inverse",
      cta: "inverse",
      inverse: true,
    });
    for (const tone of ["primary-subtle", "neutral", "accent", "bogus"]) {
      const style = promoToneStyle(tone);
      expect(style.heading).toBe("default");
      expect(style.text).toBe("primary");
      expect(style.cta).toBe("primary");
      expect(style.inverse).toBe(false);
    }
  });
});

describe("normalisePromoHeadingLevel", () => {
  test("2, 3 and 4 are kept; 1 and junk become 3 (never h1)", () => {
    expect(normalisePromoHeadingLevel(2)).toBe(2);
    expect(normalisePromoHeadingLevel(3)).toBe(3);
    expect(normalisePromoHeadingLevel(4)).toBe(4);
    for (const bad of [1, 0, 5, 6, -2, 2.5, Number.NaN, "2", null, undefined]) {
      expect(normalisePromoHeadingLevel(bad)).toBe(3);
    }
  });
});

describe("hrefs and CTAs", () => {
  test("safePromoHref accepts planned internal routes only", () => {
    expect(safePromoHref("/shipping")).toBe("/shipping");
    expect(safePromoHref("/category/home-kitchen?sort=new#top")).toBe("/category/home-kitchen?sort=new#top");
    for (const bad of ["https://evil.example", "//evil.example", "javascript:alert(1)", "shipping", "", "/nope/x/y/z", 42, null]) {
      expect(safePromoHref(bad)).toBeNull();
    }
    expect(warn).toHaveBeenCalled();
  });

  test("normalisePromoCta trims the label and drops blank labels or rejected hrefs", () => {
    expect(normalisePromoCta({ label: "  Learn more ", href: "/shipping" })).toEqual({
      label: "Learn more",
      href: "/shipping",
    });
    expect(normalisePromoCta({ label: "   ", href: "/shipping" })).toBeNull();
    expect(normalisePromoCta({ label: "Go", href: "javascript:alert(1)" })).toBeNull();
    expect(normalisePromoCta(null)).toBeNull();
    expect(normalisePromoCta(undefined)).toBeNull();
    const malformed = { label: 7, href: "/deals" } as unknown as PromoCta;
    expect(normalisePromoCta(malformed)).toBeNull();
  });

  test("cleanPromoText trims strings and blanks anything else", () => {
    expect(cleanPromoText("  hi ")).toBe("hi");
    expect(cleanPromoText(undefined)).toBe("");
    expect(cleanPromoText(5)).toBe("");
  });
});

describe("normalisePromoImage", () => {
  test("accepts a home-art manifest entry and makes it decorative by default", () => {
    expect(normalisePromoImage(DELIVERY_PROMO_ART)).toEqual({
      src: DELIVERY_PROMO_ART.path,
      alt: "",
      width: DELIVERY_PROMO_ART.width,
      height: DELIVERY_PROMO_ART.height,
    });
  });

  test("decorative: false keeps the trimmed alt", () => {
    const img = normalisePromoImage({ ...DELIVERY_PROMO_ART, decorative: false, alt: "  A parcel " });
    expect(img?.alt).toBe("A parcel");
  });

  test("missing, blank, unsafe paths or bad sizes give null", () => {
    const base: PromoImage = { path: "/images/home/promo-delivery.svg", width: 640, height: 400 };
    expect(normalisePromoImage(null)).toBeNull();
    expect(normalisePromoImage(undefined)).toBeNull();
    for (const path of ["", "   ", "javascript:alert(1)", "//evil.example/x.svg", "http://x.example/a.svg", "data:image/svg+xml,x", "img.svg"]) {
      expect(normalisePromoImage({ ...base, path })).toBeNull();
    }
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normalisePromoImage({ ...base, width })).toBeNull();
    }
    expect(normalisePromoImage({ ...base, path: "https://cdn.example/a.svg" })?.src).toBe("https://cdn.example/a.svg");
  });
});
