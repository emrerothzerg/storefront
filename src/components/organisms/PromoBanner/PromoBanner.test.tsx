import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { isAllowedInternalHref } from "@/content/routes";
import type { ValidatedCoupon } from "@/server/pricing/coupon-service";
import { BrandStrip } from "../BrandStrip";
import { CategoryRail } from "../CategoryGrid";
import { HomeHero } from "../HomeHero";
import { BEAUTY_PROMO_ART, DELIVERY_PROMO_ART, LIFESTYLE_ART } from "@/content/home-art";
import {
  normalisePromoBannerContent,
  normalisePromoCode,
  PROMO_BANNER_DEFAULT_TITLE,
  PROMO_PAIR_DEFAULT_HEADING,
  PromoBanner,
  PromoBannerPair,
  promoConditions,
  promoPairItems,
  type PromoBannerContent,
  type PromoBannerCoupon,
} from "./PromoBanner";

const HOSTILE = `<script>alert(1)</script><img src=x onerror=alert(2)>`;

const coupon: PromoBannerCoupon = {
  code: "save10",
  description: "10% off your order",
  minSubtotalCents: 2500,
  endsAt: "2026-11-30T23:59:59Z",
};

let warn: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

describe("PromoBanner: empty", () => {
  test("null / undefined coupon returns null", () => {
    expect(renderToStaticMarkup(<PromoBanner coupon={null} />)).toBe("");
    expect(renderToStaticMarkup(<PromoBanner coupon={undefined} />)).toBe("");
  });

  test("blank or invalid code returns null", () => {
    for (const code of ["", "   ", HOSTILE, "a".repeat(33), "SAVE 10", "SAVE​10"]) {
      expect(renderToStaticMarkup(<PromoBanner coupon={{ ...coupon, code }} />)).toBe("");
    }
  });
});

describe("PromoBanner: code and conditions in text (criterion 2)", () => {
  test("aside labelled by its heading; code in a <code>; conditions as text", () => {
    render(<PromoBanner coupon={coupon} id="promo" />);
    const aside = screen.getByRole("complementary", { name: PROMO_BANNER_DEFAULT_TITLE });
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.getAttribute("aria-labelledby")).toBe("promo-heading");
    const code = aside.querySelector("code");
    expect(code?.textContent).toBe("SAVE10");
    expect(code?.className).toContain("font-mono");
    expect(aside).toHaveTextContent("Use code SAVE10 at checkout");
    expect(aside).toHaveTextContent("10% off your order");
    expect(aside).toHaveTextContent("Minimum order $25.00");
    expect(aside).toHaveTextContent("Ends Nov 30, 2026");
    expect(aside.querySelector("time")?.getAttribute("datetime")).toBe("2026-11-30T23:59:59Z");
  });

  test("a ValidatedCoupon from listPromoted() can be passed as is", () => {
    const promoted: ValidatedCoupon = {
      code: "FREESHIP",
      kind: "free_shipping",
      value: 0,
      promoted: true,
      description: "Free shipping on orders of $20.00 or more",
    };
    render(<PromoBanner coupon={promoted} />);
    const aside = screen.getByRole("complementary");
    expect(aside).toHaveTextContent("FREESHIP");
    expect(aside).toHaveTextContent("Free shipping on orders of $20.00 or more");
    expect(aside).not.toHaveTextContent("Minimum order");
    expect(aside).not.toHaveTextContent("Ends");
  });

  test("invalid minimum / end date are omitted, never throw", () => {
    for (const extra of [
      { minSubtotalCents: Number.NaN, endsAt: "soon" },
      { minSubtotalCents: -5, endsAt: "2026-02-30" },
      { minSubtotalCents: 0, endsAt: null },
      { minSubtotalCents: 12.5, endsAt: "" },
      { minSubtotalCents: 2500, currency: "nope" },
    ]) {
      const html = renderToStaticMarkup(<PromoBanner coupon={{ ...coupon, endsAt: undefined, ...extra }} />);
      expect(html).toContain("SAVE10");
      expect(html).not.toContain("Minimum order");
      expect(html).not.toContain("Ends");
    }
  });

  test("minimum uses the coupon currency", () => {
    expect(promoConditions({ ...coupon, currency: "EUR" }).minimum).toBe("Minimum order €25.00");
    expect(normalisePromoCode("  welcome_5 ")).toBe("WELCOME_5");
  });
});

describe("PromoBanner: links", () => {
  test("cart link defaults to /cart; custom allowed href kept", () => {
    const { rerender } = render(<PromoBanner coupon={coupon} />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/cart");
    rerender(<PromoBanner coupon={coupon} cartHref="/deals" />);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/deals");
  });

  test("disallowed cartHref falls back to /cart", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    for (const bad of ["javascript:alert(1)", "//evil.example", "https://evil.example/cart", "/nope"]) {
      const { container, unmount } = render(<PromoBanner coupon={coupon} cartHref={bad} />);
      const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href") ?? "");
      expect(hrefs).toEqual(["/cart"]);
      for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
      unmount();
    }
    expect(warn).toHaveBeenCalled();
  });
});

describe("PromoBanner: hostile text and markup", () => {
  test("hostile description/title render as text", () => {
    const html = renderToStaticMarkup(<PromoBanner coupon={{ ...coupon, description: HOSTILE }} title={HOSTILE} />);
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    render(<PromoBanner coupon={{ ...coupon, description: HOSTILE }} />);
    expect(screen.getByRole("complementary")).toHaveTextContent(HOSTILE);
  });

  test("no script, no inline style", () => {
    const html = renderToStaticMarkup(<PromoBanner coupon={coupon} />);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/style="/);
  });

  test("no use client directive", () => {
    const src = readFileSync(join(import.meta.dir, "PromoBanner.tsx"), "utf8");
    expect(src.startsWith('"use client"')).toBe(false);
  });
});

describe("Home sections together (criterion 1: unique headings and landmarks)", () => {
  test("default headings are distinct and every labelled section points at its own heading", () => {
    const { container } = render(
      <>
        <HomeHero
          banner={{ title: "Welcome", cta: { label: "Shop", href: "/products" } }}
          deal={{ title: "Kettle", priceCents: 2999, currency: "USD", href: "/products/kettle" }}
          headingLevel={1}
        />
        <CategoryRail categories={[{ slug: "kitchen", name: "Kitchen" }]} />
        <BrandStrip brands={[{ slug: "acme", name: "Acme" }]} />
        <PromoBanner coupon={coupon} />
      </>,
    );
    const headings = screen.getAllByRole("heading").map((h) => h.textContent);
    expect(new Set(headings).size).toBe(headings.length);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    const labelled = Array.from(container.querySelectorAll("[aria-labelledby]"));
    expect(labelled).toHaveLength(4);
    const ids = labelled.map((el) => el.getAttribute("aria-labelledby") ?? "");
    expect(new Set(ids).size).toBe(4);
    for (const el of labelled) {
      const target = container.querySelector(`[id="${el.getAttribute("aria-labelledby") ?? ""}"]`);
      expect(target).not.toBeNull();
      expect(el.contains(target)).toBe(true);
    }
    for (const a of Array.from(container.querySelectorAll("a"))) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
    // T154: region count depended on sibling organisms (HomeHero/CategoryRail
    // are restyled in Phase 3); pin PromoBanner's own landmark instead: one
    // complementary landmark, and the banner itself adds no region.
    expect(within(container).getAllByRole("complementary")).toHaveLength(1);
    const alone = render(<PromoBanner coupon={coupon} />);
    expect(within(alone.container).queryAllByRole("region")).toHaveLength(0);
  });
});

describe("PromoBanner v3 coupon mode (T154): PromoStrip surface, Phase 2 behaviour kept", () => {
  test("root id on the aside, heading id derived; default tone is the primary tint", () => {
    const html = renderToStaticMarkup(<PromoBanner coupon={coupon} id="home-promo" />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const aside = doc.querySelector("aside");
    expect(aside?.id).toBe("home-promo");
    expect(aside?.getAttribute("aria-labelledby")).toBe("home-promo-heading");
    expect(aside?.getAttribute("data-promo-tone")).toBe("accent-subtle");
    expect(aside?.className).toContain("rounded-xl");
  });

  test("tone prop maps onto the promo tones; unknown tone falls back to neutral", () => {
    const tone = (t: string) =>
      new DOMParser()
        .parseFromString(renderToStaticMarkup(<PromoBanner coupon={coupon} tone={t as "neutral"} />), "text/html")
        .querySelector("aside")
        ?.getAttribute("data-promo-tone");
    expect(tone("primary")).toBe("inverse");
    expect(tone("accent")).toBe("promo");
    expect(tone("neutral")).toBe("sunken");
    expect(tone("hot-pink")).toBe("sunken");
  });

  test("inverse band: CTA uses the inverse button look", () => {
    render(<PromoBanner coupon={coupon} tone="primary" />);
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("/cart");
    expect(screen.getByRole("heading", { level: 2 }).className).toContain("text-text-inverse");
  });

  test("the code is not covered by a stretched link (stays selectable)", () => {
    render(<PromoBanner coupon={coupon} />);
    expect(screen.getByRole("link").className).not.toContain("after:absolute");
  });

  test("headingLevel 3 renders an h3; blank title falls back to the default", () => {
    render(<PromoBanner coupon={coupon} headingLevel={3} title="   " />);
    expect(screen.getByRole("heading", { level: 3 }).textContent).toBe(PROMO_BANNER_DEFAULT_TITLE);
  });

  test("blank id is ignored (no empty id attribute)", () => {
    const html = renderToStaticMarkup(<PromoBanner coupon={coupon} id="   " />);
    expect(html).not.toContain('id=""');
    expect(html).not.toContain('id="   "');
  });
});

const SHIPPING: PromoBannerContent = {
  heading: "Free shipping over $35",
  blurb: "Standard shipping is free on qualifying orders.",
  cta: { label: "Learn more", href: "/shipping" },
  image: DELIVERY_PROMO_ART,
};

describe("PromoBanner v3 banner mode (promo prop)", () => {
  test("renders a PromoStrip section with id, h2 by default, one link, decorative image", () => {
    const html = renderToStaticMarkup(<PromoBanner promo={SHIPPING} id="home-shipping-promo" />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const section = doc.getElementById("home-shipping-promo");
    expect(section?.tagName).toBe("SECTION");
    expect(section?.querySelector("h2")?.textContent).toBe("Free shipping over $35");
    expect([...doc.querySelectorAll("a")].map((a) => a.getAttribute("href"))).toEqual(["/shipping"]);
    expect(doc.querySelector("img")?.getAttribute("alt")).toBe("");
    expect(doc.querySelector("aside")).toBeNull();
    expect(doc.querySelector("code")).toBeNull();
    expect(section?.getAttribute("data-promo-tone")).toBe("accent-subtle");
  });

  test("split banner: imagePosition start puts the image first from md; tone honoured", () => {
    const html = renderToStaticMarkup(
      <PromoBanner
        promo={{
          heading: "Everyday beauty",
          blurb: "Skincare and makeup picks.",
          cta: { label: "Shop beauty", href: "/category/beauty-personal-care" },
          image: BEAUTY_PROMO_ART,
          imagePosition: "start",
          tone: "neutral",
        }}
        id="home-lifestyle-banner"
      />,
    );
    const section = new DOMParser().parseFromString(html, "text/html").getElementById("home-lifestyle-banner");
    expect(section?.className).toContain("md:flex-row");
    expect(section?.className).not.toContain("md:flex-row-reverse");
    expect(section?.getAttribute("data-promo-tone")).toBe("sunken");
  });

  test("headingLevel 3 / 4 honoured; 1 never renders an h1", () => {
    expect(renderToStaticMarkup(<PromoBanner promo={SHIPPING} headingLevel={3} />)).toContain("<h3");
    expect(renderToStaticMarkup(<PromoBanner promo={SHIPPING} headingLevel={4} />)).toContain("<h4");
    expect(renderToStaticMarkup(<PromoBanner promo={SHIPPING} headingLevel={1 as 2} />)).not.toContain("<h1");
  });

  test("omitted when promo is missing, heading blank, or the CTA is missing / blank / not allowed", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const bad: Array<PromoBannerContent | null | undefined> = [
      null,
      undefined,
      "promo" as unknown as PromoBannerContent,
      { ...SHIPPING, heading: "   " },
      { ...SHIPPING, cta: { label: " ", href: "/shipping" } },
      { ...SHIPPING, cta: undefined as unknown as PromoBannerContent["cta"] },
      ...["javascript:alert(1)", "//evil.example", "https://evil.example/", "/nope", ""].map((href) => ({
        ...SHIPPING,
        cta: { label: "Go", href },
      })),
    ];
    for (const promo of bad) {
      expect(renderToStaticMarkup(<PromoBanner promo={promo} id="home-shipping-promo" />)).toBe("");
      expect(normalisePromoBannerContent(promo)).toBeNull();
    }
  });

  test("hostile copy renders as text", () => {
    const html = renderToStaticMarkup(
      <PromoBanner promo={{ heading: HOSTILE, blurb: HOSTILE, cta: { label: HOSTILE, href: "/deals" } }} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img src=x");
    render(<PromoBanner promo={{ heading: HOSTILE, blurb: HOSTILE, cta: { label: HOSTILE, href: "/deals" } }} />);
    expect(screen.getByRole("heading").textContent).toBe(HOSTILE);
    expect(screen.getByRole("link").textContent).toBe(HOSTILE);
  });

  test("unsafe image path is dropped, text fills the width", () => {
    const html = renderToStaticMarkup(
      <PromoBanner promo={{ ...SHIPPING, image: { path: "javascript:alert(1)", width: 10, height: 10 } }} />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("Free shipping over $35");
  });
});

const PAIR: PromoBannerContent[] = [
  { heading: "New arrivals", blurb: "Fresh picks.", cta: { label: "Shop new arrivals", href: "/new-arrivals" }, image: LIFESTYLE_ART.living },
  { heading: "Top rated", blurb: "Loved by shoppers.", cta: { label: "Shop top rated", href: "/top-rated" }, tone: "accent" },
];

describe("PromoBannerPair (contract H-19)", () => {
  test("section with id + hidden h2; two promo strips (h3) linking /new-arrivals and /top-rated", () => {
    const html = renderToStaticMarkup(<PromoBannerPair promos={PAIR} id="home-promo-pair" />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const section = doc.getElementById("home-promo-pair");
    expect(section?.getAttribute("aria-labelledby")).toBe("home-promo-pair-heading");
    const h2 = section?.querySelector("h2");
    expect(h2?.textContent).toBe(PROMO_PAIR_DEFAULT_HEADING);
    expect(h2?.className).toContain("sr-only");
    expect([...doc.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["New arrivals", "Top rated"]);
    expect([...doc.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Shop new arrivals", "/new-arrivals"],
      ["Shop top rated", "/top-rated"],
    ]);
    expect(section?.querySelectorAll("ul > li")).toHaveLength(2);
    expect(section?.querySelector("ul")?.className).toContain("grid-cols-1");
  });

  test("showHeading makes the h2 visible; custom heading used", () => {
    render(<PromoBannerPair promos={PAIR} heading="Shop more" showHeading />);
    const h2 = screen.getByRole("heading", { level: 2 });
    expect(h2.textContent).toBe("Shop more");
    expect(h2.className).not.toContain("sr-only");
  });

  test("invalid promos dropped; only the first two valid render; < 2 valid → omitted", () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const bad = { heading: "Bad", cta: { label: "x", href: "javascript:alert(1)" } };
    const extra = { heading: "Deals", cta: { label: "Shop deals", href: "/deals" } };
    expect(promoPairItems([bad, ...PAIR, extra]).map((p) => p.cta.href)).toEqual(["/new-arrivals", "/top-rated"]);
    for (const promos of [[], null, undefined, "x", [PAIR[0]], [bad, PAIR[1]], [null, PAIR[0]]] as unknown[]) {
      expect(renderToStaticMarkup(<PromoBannerPair promos={promos as PromoBannerContent[]} id="home-promo-pair" />)).toBe("");
    }
  });

  test("all hrefs allowed; no h1; no inline style or script", () => {
    const html = renderToStaticMarkup(<PromoBannerPair promos={PAIR} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const a of doc.querySelectorAll("a")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    expect(doc.querySelector("h1")).toBeNull();
    expect(html).not.toContain("<script");
    for (const el of doc.querySelectorAll("[style]")) expect(el.tagName).toBe("IMG");
  });
});
