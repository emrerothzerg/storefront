// QA (T147, Phase 3 wave A): BenefitsStrip + ServiceTiles (T140) and PromoStrip, PromoTile,
// LifestyleCard (T141) against BACKLOG-phase3 T140 AC1-AC4, T141 AC1-AC5, T147 AC4 and CONTRACTS
// G-12, H-3, H-12, H-17, H-21, L-17.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BenefitsStrip, normaliseBenefits } from "@/components/molecules/BenefitsStrip";
import { LifestyleCard } from "@/components/molecules/LifestyleCard";
import {
  PROMO_TONES,
  PROMO_TONE_CARD,
  PromoStrip,
  normalisePromoHeadingLevel,
  normalisePromoImage,
  normalisePromoTone,
} from "@/components/molecules/PromoStrip";
import { PromoTile, promoTileSpanClass } from "@/components/molecules/PromoTile";
import { SERVICE_TILES_GRID_CLASSES, ServiceTiles } from "@/components/molecules/ServiceTiles";
import { BEAUTY_PROMO_ART, DELIVERY_PROMO_ART, LIFESTYLE_ART } from "@/content/home-art";
import { isAllowedInternalHref } from "@/content/routes";

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>&amp; ‮evil`;
const BAD_HREFS = ["javascript:alert(1)", "//evil.example", "https://evil.example/x", "/no-such-route", "deals", "/deals/"];

function doc(el: ReactElement): Document {
  return new DOMParser().parseFromString(`<body>${renderToStaticMarkup(el)}</body>`, "text/html");
}
const cls = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const hrefs = (d: ParentNode) => [...d.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
const injected = (d: ParentNode) => d.querySelectorAll("script, img[src='x'], [onerror]").length;

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

// ============================================================ BenefitsStrip
describe("T140 BenefitsStrip", () => {
  const items = [
    { label: "Free shipping over $35", icon: "truck" as const, href: "/shipping" },
    { label: "Track your order", icon: "package" as const, href: "/orders" },
    { label: "Easy returns", icon: "refresh" as const, href: "/returns" },
    { label: "Help centre", icon: "info" as const, href: "/help" },
  ];

  test("AC1 + G-12: <ul> of 4 <li>, named by `label`; links go to real routes; icons decorative", () => {
    const d = doc(<BenefitsStrip label="Store benefits" items={items} />);
    const ul = d.querySelector("ul");
    expect(ul?.getAttribute("aria-label")).toBe("Store benefits");
    expect(d.querySelectorAll("ul > li").length).toBe(4);
    expect(hrefs(d)).toEqual(["/shipping", "/orders", "/returns", "/help"]);
    for (const svg of d.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
    for (const a of d.querySelectorAll("a")) expect(cls(a)).toContain("min-h-touch");
  });

  test("AC1: empty / all-blank items render nothing", () => {
    expect(renderToStaticMarkup(<BenefitsStrip label="x" items={[]} />)).toBe("");
    expect(renderToStaticMarkup(<BenefitsStrip label="x" items={[{ label: "  " }, { label: "" }]} />)).toBe("");
    expect(normaliseBenefits(null)).toEqual([]);
  });

  test("rejected hrefs render as plain text (never '#'), with a dev warning", () => {
    const d = doc(<BenefitsStrip label="x" items={BAD_HREFS.map((href, i) => ({ label: `Item ${i}`, href }))} />);
    expect(d.querySelectorAll("a").length).toBe(0);
    expect(d.querySelectorAll("li").length).toBe(BAD_HREFS.length);
    expect(warn).toHaveBeenCalledTimes(BAD_HREFS.length);
  });

  test("no links at all: the scroller is a focusable named region (keyboard can still scroll)", () => {
    const d = doc(<BenefitsStrip label="Store benefits" items={[{ label: "A" }, { label: "B" }]} />);
    const region = d.querySelector('[role="region"]');
    expect(region?.getAttribute("aria-label")).toBe("Store benefits");
    expect(region?.getAttribute("tabindex")).toBe("0");
  });

  test("AC4: one row (no wrap), scrolls inside its own container, padding leaves room for focus", () => {
    const d = doc(<BenefitsStrip label="x" items={items} />);
    const ul = d.querySelector("ul");
    expect(cls(ul)).toEqual(expect.arrayContaining(["flex-nowrap", "w-max", "p-1"]));
    expect(cls(ul?.parentElement)).toEqual(expect.arrayContaining(["overflow-x-auto", "max-w-full", "min-w-0"]));
  });

  test("AC2: copy only from props; hostile labels render as text", () => {
    const d = doc(<BenefitsStrip label={HOSTILE} items={[{ label: HOSTILE, href: "/shipping" }]} />);
    expect(injected(d)).toBe(0);
    expect(d.querySelector("a")?.textContent).toBe(HOSTILE.trim());
  });
});

// ============================================================ ServiceTiles
describe("T140 ServiceTiles + H-21", () => {
  const tiles = [
    { label: "Track my order", href: "/orders", icon: "package" as const },
    { label: "Returns", href: "/returns", icon: "refresh" as const },
    { label: "Shipping", href: "/shipping", icon: "truck" as const },
    { label: "Help centre", href: "/help", icon: "info" as const },
    { label: "FAQ", href: "/faq", icon: "question-circle" as const },
    { label: "Contact us", href: "/contact", icon: "mail" as const },
  ];

  test("H-21: section named by its h2 'Customer services' (visually hidden allowed); ul of 6 tile links", () => {
    const d = doc(<ServiceTiles id="home-services" heading="Customer services" headingVisuallyHidden tiles={tiles} />);
    const section = d.querySelector("section#home-services");
    const h2 = section?.querySelector("h2");
    expect(h2?.textContent).toBe("Customer services");
    expect(section?.getAttribute("aria-labelledby")).toBe(h2?.id);
    expect(hrefs(d)).toEqual(["/orders", "/returns", "/shipping", "/help", "/faq", "/contact"]);
  });

  test("AC3: 2 / sm 3 / lg 6 columns; whole tile is one 44px link; icons decorative", () => {
    expect(SERVICE_TILES_GRID_CLASSES.split(" ")).toEqual(expect.arrayContaining(["grid-cols-2", "sm:grid-cols-3", "lg:grid-cols-6"]));
    const d = doc(<ServiceTiles tiles={tiles} />);
    for (const li of d.querySelectorAll("li")) expect(li.querySelectorAll("a").length).toBe(1);
    for (const a of d.querySelectorAll("a")) expect(cls(a)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch", "w-full", "h-full"]));
    for (const svg of d.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  test("no heading -> a div (no unlabelled section, no orphan heading); 0 valid tiles -> nothing", () => {
    const d = doc(<ServiceTiles tiles={tiles} />);
    expect(d.querySelector("section, h2, h3")).toBeNull();
    expect(renderToStaticMarkup(<ServiceTiles heading="X" tiles={BAD_HREFS.map((href) => ({ label: "L", href }))} />)).toBe("");
  });

  test("tiles with bad hrefs are dropped, hostile labels are text, unknown tone falls back", () => {
    const d = doc(
      <ServiceTiles tone={"neon" as "sunken"} tiles={[...BAD_HREFS.map((href) => ({ label: "Bad", href })), { label: HOSTILE, href: "/faq" }]} />,
    );
    expect(hrefs(d)).toEqual(["/faq"]);
    expect(injected(d)).toBe(0);
    expect(cls(d.body.firstElementChild)).toContain("bg-accent-subtle");
  });

  test("headingLevel 3 renders h3; never h1", () => {
    const d = doc(<ServiceTiles heading="Services" headingLevel={3} tiles={tiles} />);
    expect(d.querySelector("h3")?.textContent).toBe("Services");
    expect(d.querySelector("h1")).toBeNull();
  });
});

// ============================================================ Promo tone / heading / href helpers
describe("T141 AC2/AC3: shared promo rules", () => {
  test("tones limited to primary / primary-subtle / neutral / accent; unknown -> neutral, never throws", () => {
    expect([...PROMO_TONES]).toEqual(["primary", "primary-subtle", "neutral", "accent"]);
    for (const t of ["", "red", "__proto__", "constructor", null, 3, undefined]) expect(normalisePromoTone(t)).toBe("neutral");
    for (const t of PROMO_TONES) expect(typeof PROMO_TONE_CARD[t]).toBe("string");
  });

  test("heading level: 2/3/4 kept, 1 and junk -> 3 (never h1)", () => {
    for (const [i, o] of [[1, 3], [2, 2], [3, 3], [4, 4], [5, 3], [0, 3], ["2", 3], [Number.NaN, 3]] as const) {
      expect({ i: String(i), o: normalisePromoHeadingLevel(i) }).toEqual({ i: String(i), o });
    }
  });

  test("images: unsafe / blank paths and bad sizes dropped; decorative by default", () => {
    for (const path of ["", "  ", "javascript:alert(1)", "//evil.example/a.svg", "/a\\b.svg", "data:image/svg+xml,x", "http://x/a.png"]) {
      expect({ path, img: normalisePromoImage({ path, width: 10, height: 10 }) }).toEqual({ path, img: null });
    }
    expect(normalisePromoImage({ path: "/a.svg", width: 0, height: 10 })).toBeNull();
    expect(normalisePromoImage({ path: "/a.svg", width: 10, height: 10, alt: "Named" })?.alt).toBe("");
    expect(normalisePromoImage({ path: "/a.svg", width: 10, height: 10, alt: "Named", decorative: false })?.alt).toBe("Named");
  });
});

type PromoCase = { name: string; el: (p: Record<string, unknown>) => ReactElement };
const PROMOS: PromoCase[] = [
  { name: "PromoStrip", el: (p) => <PromoStrip heading="Free shipping" blurb="Over $35" {...p} /> },
  { name: "PromoTile", el: (p) => <PromoTile heading="Today's deals" blurb="Save" {...p} /> },
  { name: "LifestyleCard", el: (p) => <LifestyleCard heading="Living room" blurb="Cosy" {...p} /> },
];

describe("T141 AC1/AC4 + L-17: one link, never nested; invalid href -> no link", () => {
  for (const { name, el } of PROMOS) {
    test(`${name}: exactly one allow-listed link; its overlay is the click area; no nested links`, () => {
      const d = doc(el({ cta: { label: "Shop", href: "/deals" }, image: DELIVERY_PROMO_ART }));
      const links = [...d.querySelectorAll("a")];
      expect(links).toHaveLength(1);
      expect(isAllowedInternalHref(links[0]?.getAttribute("href") ?? "")).toBe(true);
      expect(links[0]?.querySelector("a, button")).toBeNull();
      expect(cls(links[0])).toEqual(expect.arrayContaining(["after:absolute", "after:inset-0"]));
      // the stretched overlay needs a positioned card
      expect(cls(d.body.firstElementChild)).toContain("relative");
      // the CTA is described by the heading
      const h = d.querySelector("h2, h3, h4");
      expect(links[0]?.getAttribute("aria-describedby")).toBe(h?.id);
    });

    test(`${name}: every invalid CTA href renders the card without a link (no '#'), with a dev warning`, () => {
      for (const href of BAD_HREFS) {
        warn.mockClear();
        const d = doc(el({ cta: { label: "Shop", href } }));
        expect({ href, links: d.querySelectorAll("a").length }).toEqual({ href, links: 0 });
        expect(d.body.textContent).toContain(name === "LifestyleCard" ? "Living room" : name === "PromoTile" ? "Today's deals" : "Free shipping");
        expect(warn).toHaveBeenCalledTimes(1);
      }
    });

    test(`${name}: unknown tone falls back without throwing`, () => {
      const d = doc(el({ tone: "neon", cta: { label: "Shop", href: "/deals" } }));
      const tone = d.body.firstElementChild?.getAttribute("data-promo-tone");
      expect(tone).toBe(PROMO_TONE_CARD.neutral);
    });

    test(`${name}: heading level default 3, junk/1 -> 3, 2 and 4 honoured; never h1`, () => {
      expect(doc(el({})).querySelector("h3") === null ? "no h3" : "h3").toBe("h3");
      for (const lvl of [1, 9, "x"]) expect(doc(el({ headingLevel: lvl })).querySelector("h1")).toBeNull();
      expect(doc(el({ headingLevel: 2 })).querySelector("h2") === null ? "no h2" : "h2").toBe("h2");
      expect(doc(el({ headingLevel: 4 })).querySelector("h4") === null ? "no h4" : "h4").toBe("h4");
    });

    test(`${name}: AC5 no image -> no <img> and no image column; hostile text renders as text`, () => {
      const d = doc(el({ heading: HOSTILE, blurb: HOSTILE, cta: { label: HOSTILE, href: "/deals" }, image: null }));
      expect(d.querySelector("img, [data-promo-image]")).toBeNull();
      expect(injected(d)).toBe(0);
      expect(d.querySelector("h3")?.textContent).toBe(HOSTILE.trim());
    });

    test(`${name}: images are decorative (alt="") and lazy by default, with width/height`, () => {
      const d = doc(el({ image: LIFESTYLE_ART.living }));
      const img = d.querySelector("img");
      expect(img?.getAttribute("alt")).toBe("");
      expect(img?.getAttribute("loading")).toBe("lazy");
      expect(Number(img?.getAttribute("width"))).toBeGreaterThan(0);
      expect(Number(img?.getAttribute("height"))).toBeGreaterThan(0);
    });
  }
});

describe("T141 per-molecule specifics", () => {
  test("PromoStrip: blank heading -> nothing; section labelled by its heading; priority makes the image eager", () => {
    expect(renderToStaticMarkup(<PromoStrip heading="   " />)).toBe("");
    const d = doc(<PromoStrip id="home-shipping-promo" heading="Free shipping" headingLevel={2} image={BEAUTY_PROMO_ART} priority />);
    const section = d.querySelector("section#home-shipping-promo");
    expect(section?.getAttribute("aria-labelledby")).toBe(d.querySelector("h2")?.id);
    expect(d.querySelector("img")?.getAttribute("loading")).toBe("eager");
  });

  test("PromoStrip: image stacks first below md and sits beside the text from md (start/end)", () => {
    const end = doc(<PromoStrip heading="H" image={DELIVERY_PROMO_ART} />).body.firstElementChild;
    const start = doc(<PromoStrip heading="H" image={DELIVERY_PROMO_ART} imagePosition="start" />).body.firstElementChild;
    expect(cls(end)).toEqual(expect.arrayContaining(["flex-col", "md:flex-row-reverse"]));
    expect(cls(start)).toEqual(expect.arrayContaining(["flex-col", "md:flex-row"]));
  });

  test("PromoTile as='li' carries its own span class and can sit directly in a grid <ul>; unknown span -> 1", () => {
    const d = doc(
      <ul>
        <PromoTile as="li" span={2} heading="Wide" />
        <PromoTile as="li" span={7 as 1} heading="Narrow" />
      </ul>,
    );
    const lis = [...d.querySelectorAll("ul > li")];
    expect(lis.map((li) => cls(li).find((c) => c.startsWith("col-span-")))).toEqual(["col-span-2", "col-span-1"]);
    expect(promoTileSpanClass("2")).toBe("col-span-1");
    expect(renderToStaticMarkup(<PromoTile heading="" />)).toBe("");
  });

  test("LifestyleCard: renders nothing with no heading, no blurb and no valid link; one bold underlined 44px link", () => {
    expect(renderToStaticMarkup(<LifestyleCard cta={{ label: "Shop", href: "javascript:x" }} />)).toBe("");
    const d = doc(<LifestyleCard blurb="b" cta={{ label: "Shop living room", href: "/category/home-kitchen" }} image={LIFESTYLE_ART.living} />);
    const a = d.querySelector("a");
    expect(cls(a)).toEqual(expect.arrayContaining(["font-semibold", "underline", "min-h-touch"]));
    // plain card: no overflow clip, so the focus ring is not cut at the card edge
    expect(cls(d.body.firstElementChild)).not.toContain("overflow-hidden");
  });

  test("primary tone: dark band with white text and the inverse CTA pill (no accent fill on dark)", () => {
    for (const { el } of PROMOS.slice(0, 2)) {
      const d = doc(el({ tone: "primary", cta: { label: "Go", href: "/deals" } }));
      const a = d.querySelector("a");
      expect(cls(a)).not.toContain("bg-accent");
      expect(cls(d.querySelector("h2, h3, h4"))).toContain("text-text-inverse");
    }
  });
});

describe("T140/T141 cross-cutting: tokens only, light only, brand-free", () => {
  const all = (
    <>
      <BenefitsStrip label="x" items={[{ label: "a", href: "/help" }]} />
      <ServiceTiles heading="S" tiles={[{ label: "FAQ", href: "/faq", icon: "info" }]} />
      {PROMO_TONES.map((tone) => (
        <PromoStrip key={`s-${tone}`} heading="H" tone={tone} cta={{ label: "Go", href: "/deals" }} image={DELIVERY_PROMO_ART} />
      ))}
      {PROMO_TONES.map((tone) => (
        <PromoTile key={`t-${tone}`} heading="H" tone={tone} cta={{ label: "Go", href: "/deals" }} span={2} image={DELIVERY_PROMO_ART} />
      ))}
      {PROMO_TONES.map((tone) => (
        <LifestyleCard key={`l-${tone}`} heading="H" tone={tone} cta={{ label: "Go", href: "/deals" }} />
      ))}
    </>
  );

  test("no arbitrary values, no dark:, no palette colours, no inline style except next/image", () => {
    const d = doc(all);
    const c = [...d.querySelectorAll("[class]")].flatMap((el) => cls(el));
    expect(c.filter((x) => /\[|^dark:|:dark:/.test(x))).toEqual([]);
    expect(c.filter((x) => /(^|:)(bg|text|border)-(gray|slate|red|blue|green|white|black|teal|purple)(-\d+)?$/.test(x))).toEqual([]);
    expect([...d.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG").length).toBe(0);
  });

  test("no retailer brand or pay-later copy in the molecules' own markup", () => {
    const html = renderToStaticMarkup(all).toLowerCase();
    for (const w of ["kmart", "onepass", "afterpay", "zip pay", "app store", "google play"]) expect({ w, hit: html.includes(w) }).toEqual({ w, hit: false });
  });
});
