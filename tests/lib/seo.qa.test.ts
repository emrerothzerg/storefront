import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// QA-W0-S: adversarial tests for src/lib/seo/{site,metadata,json-ld,sitemap}.ts
// (criteria 1-3 and the pure half of 5). Pure modules; only env is touched.
// ---------------------------------------------------------------------------

import {
  absoluteUrl,
  BACKGROUND_COLOR,
  DEFAULT_SITE_URL,
  getSiteUrl,
  ROBOTS_DISALLOW,
  THEME_COLOR,
} from "@/lib/seo/site";
import { buildMetadata, MAX_DESCRIPTION_LENGTH, MAX_TITLE_LENGTH, truncateText } from "@/lib/seo/metadata";
import {
  availabilityFor,
  breadcrumbListJsonLd,
  centsToDecimalString,
  faqPageJsonLd,
  itemListJsonLd,
  organizationJsonLd,
  productJsonLd,
  toProductJsonLdInput,
  webSiteJsonLd,
  type ProductJsonLdInput,
} from "@/lib/seo/json-ld";
import { buildSitemapEntries, toSitemapProduct } from "@/lib/seo/sitemap";

const env = process.env as Record<string, string | undefined>;
const ORIGINAL = env.NEXT_PUBLIC_SITE_URL;

beforeEach(() => {
  delete env.NEXT_PUBLIC_SITE_URL;
});
afterEach(() => {
  if (ORIGINAL === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = ORIGINAL;
});

function withSite(value: string | undefined): string {
  if (value === undefined) delete env.NEXT_PUBLIC_SITE_URL;
  else env.NEXT_PUBLIC_SITE_URL = value;
  return getSiteUrl();
}

const graphemeCount = (s: string): number =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)).length;

// ---------------------------------------------------------------------------
// Criterion 1: getSiteUrl / absoluteUrl
// ---------------------------------------------------------------------------
describe("C1 getSiteUrl", () => {
  test.each([
    ["https://shop.example.com", "https://shop.example.com"],
    ["  https://shop.example.com  ", "https://shop.example.com"],
    ["https://shop.example.com/", "https://shop.example.com"],
    ["https://shop.example.com///", "https://shop.example.com"],
    ["https://shop.example.com/?utm=1#frag", "https://shop.example.com"],
    ["https://shop.example.com/store/?q=1#x", "https://shop.example.com/store"],
    ["https://shop.example.com/store//", "https://shop.example.com/store"],
    ["HTTPS://SHOP.EXAMPLE.COM", "https://shop.example.com"],
    ["https://shop.example.com:443", "https://shop.example.com"],
    ["http://localhost:4000", "http://localhost:4000"],
    ["\thttps://shop.example.com\n", "https://shop.example.com"],
  ])("%p -> %p", (raw, expected) => {
    expect(withSite(raw)).toBe(expected);
  });

  test.each([
    [undefined],
    [""],
    ["   "],
    ["shop.example.com"],
    ["/relative/path"],
    ["//shop.example.com"],
    ["ftp://shop.example.com"],
    ["javascript:alert(1)"],
    ["data:text/html,hi"],
    ["file:///etc/passwd"],
    ["https://user:secret@shop.example.com"],
    ["https://user@shop.example.com"],
    ["https://:pw@shop.example.com"],
    ["https://"],
    ["not a url at all"],
  ])("falls back to localhost for %p", (raw) => {
    expect(withSite(raw)).toBe(DEFAULT_SITE_URL);
    expect(DEFAULT_SITE_URL).toBe("http://localhost:3000");
  });

  test("result never ends in a slash and never contains ? or #", () => {
    for (const raw of ["https://a.example/", "https://a.example/x/?y#z", "https://a.example/#", "https://a.example/?"]) {
      const url = withSite(raw);
      expect(url.endsWith("/")).toBe(false);
      expect(url).not.toContain("?");
      expect(url).not.toContain("#");
    }
  });

  test("is read per call (env change honoured)", () => {
    expect(withSite("https://one.example")).toBe("https://one.example");
    expect(withSite("https://two.example")).toBe("https://two.example");
  });
});

describe("C1 absoluteUrl", () => {
  test("joins paths with and without a leading slash", () => {
    withSite("https://shop.example.com");
    expect(absoluteUrl("/x")).toBe("https://shop.example.com/x");
    expect(absoluteUrl("x")).toBe("https://shop.example.com/x");
    expect(absoluteUrl("/")).toBe("https://shop.example.com/");
    expect(absoluteUrl("  /x  ")).toBe("https://shop.example.com/x");
  });

  test("keeps a base path", () => {
    withSite("https://example.com/store/");
    expect(absoluteUrl("/products/a")).toBe("https://example.com/store/products/a");
  });

  test("absolute http(s) input passes through unchanged", () => {
    withSite("https://shop.example.com");
    expect(absoluteUrl("https://cdn.example.net/a.png")).toBe("https://cdn.example.net/a.png");
    expect(absoluteUrl("http://cdn.example.net/a.png")).toBe("http://cdn.example.net/a.png");
    expect(absoluteUrl("HTTPS://cdn.example.net/a.png")).toBe("HTTPS://cdn.example.net/a.png");
  });

  test("non-http schemes are not passed through as absolute", () => {
    withSite("https://shop.example.com");
    expect(absoluteUrl("javascript:alert(1)").startsWith("https://shop.example.com/")).toBe(true);
  });

  test("defaults to localhost when unset", () => {
    expect(absoluteUrl("/a")).toBe("http://localhost:3000/a");
  });
});

// ---------------------------------------------------------------------------
// Criterion 2: buildMetadata / truncateText
// ---------------------------------------------------------------------------
describe("C2 truncateText", () => {
  test("short text returned unchanged (whitespace collapsed)", () => {
    expect(truncateText("  Walnut   desk \n", 60)).toBe("Walnut desk");
  });

  test("exactly max graphemes is not truncated", () => {
    const s = "a".repeat(60);
    expect(truncateText(s, 60)).toBe(s);
  });

  test("max+1 is truncated to max graphemes ending in an ellipsis", () => {
    const out = truncateText("a".repeat(61), 60);
    expect(graphemeCount(out)).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  test("never cuts a surrogate pair (astral chars at every offset)", () => {
    for (let pad = 0; pad < 4; pad++) {
      const out = truncateText("x".repeat(pad) + "\u{1F600}".repeat(100), 60);
      expect(graphemeCount(out)).toBeLessThanOrEqual(60);
      for (let i = 0; i < out.length; i++) {
        const code = out.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = out.charCodeAt(i + 1);
          expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
          i++;
        } else {
          expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
        }
      }
    }
  });

  test("never splits a ZWJ family emoji or flag", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}";
    const flag = "\u{1F1EF}\u{1F1F5}";
    for (const unit of [family, flag, "é"]) {
      const out = truncateText(unit.repeat(80), 60);
      expect(graphemeCount(out)).toBe(60);
      const body = out.slice(0, -1);
      expect(body).toBe(unit.repeat(59));
    }
  });

  test("prefers a word boundary when close", () => {
    const out = truncateText("Premium handcrafted solid walnut writing desk with drawers and cable tray", 60);
    expect(graphemeCount(out)).toBeLessThanOrEqual(60);
    expect(out).toMatch(/\w…$/);
    expect(out).not.toMatch(/ …$/);
  });

  test("invalid max returns empty string", () => {
    expect(truncateText("abc", 0)).toBe("");
    expect(truncateText("abc", -1)).toBe("");
    expect(truncateText("abc", Number.NaN)).toBe("");
    expect(truncateText("abc", 1.5)).toBe("");
  });

  test("100k-char input completes quickly", () => {
    const start = performance.now();
    const out = truncateText("word ".repeat(20000), 160);
    expect(graphemeCount(out)).toBeLessThanOrEqual(160);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("C2 buildMetadata", () => {
  beforeEach(() => withSite("https://shop.example.com"));

  test("constants are 60 / 160", () => {
    expect(MAX_TITLE_LENGTH).toBe(60);
    expect(MAX_DESCRIPTION_LENGTH).toBe(160);
  });

  test("title <= 60 and description <= 160 graphemes for long input", () => {
    const m = buildMetadata({ title: "T".repeat(500), description: "D ".repeat(500) });
    expect(graphemeCount(String(m.title))).toBeLessThanOrEqual(60);
    expect(graphemeCount(String(m.description))).toBeLessThanOrEqual(160);
    expect(String(m.openGraph?.title)).toBe(String(m.title));
  });

  test("no path -> no canonical, no og:url", () => {
    const m = buildMetadata({ title: "A", description: "B" });
    expect(m.alternates).toBeUndefined();
    expect(m.openGraph).toBeDefined();
    expect(m.openGraph && "url" in m.openGraph).toBe(false);
  });

  test("path -> absolute canonical + og:url", () => {
    const m = buildMetadata({ title: "A", description: "B", path: "/products/x" });
    expect(m.alternates?.canonical).toBe("https://shop.example.com/products/x");
    expect(m.openGraph && "url" in m.openGraph ? m.openGraph.url : null).toBe(
      "https://shop.example.com/products/x",
    );
  });

  test("openGraph always present with siteName", () => {
    for (const input of [
      { title: "A", description: "B" },
      { title: "A", description: "B", noindex: true },
      { title: "A", description: "B", path: "/", image: { url: "/i.svg" } },
    ]) {
      const m = buildMetadata(input);
      expect(m.openGraph?.siteName).toBe("Northwind Goods");
    }
  });

  test("twitter summary_large_image only with an image", () => {
    const without = buildMetadata({ title: "A", description: "B" });
    expect(without.twitter && "card" in without.twitter ? without.twitter.card : null).not.toBe(
      "summary_large_image",
    );
    const withImg = buildMetadata({ title: "A", description: "B", image: { url: "/img/p.svg", alt: "P" } });
    expect(withImg.twitter && "card" in withImg.twitter ? withImg.twitter.card : null).toBe(
      "summary_large_image",
    );
    expect(JSON.stringify(withImg.openGraph)).toContain("https://shop.example.com/img/p.svg");
  });

  test("robots only when noindex, exactly {index:false, follow:false}", () => {
    expect(buildMetadata({ title: "A", description: "B" }).robots).toBeUndefined();
    expect(buildMetadata({ title: "A", description: "B", noindex: false }).robots).toBeUndefined();
    expect(buildMetadata({ title: "A", description: "B", noindex: true }).robots).toEqual({
      index: false,
      follow: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Criterion 3: JSON-LD builders
// ---------------------------------------------------------------------------
const BASE: ProductJsonLdInput = {
  name: "Canvas Tote Bag",
  description: "A bag.",
  slug: "canvas-tote-bag",
  images: ["/images/products/canvas-tote-bag.svg"],
  priceCents: 1999,
  currency: "USD",
  stock: 5,
};

describe("C3 centsToDecimalString", () => {
  test.each([
    [1999, "USD", "19.99"],
    [1999, "JPY", "1999"],
    [0, "USD", "0.00"],
    [5, "USD", "0.05"],
    [100, "USD", "1.00"],
    [125000, "USD", "1250.00"],
    [1999, "KWD", "1.999"],
    [Number.MAX_SAFE_INTEGER, "USD", "90071992547409.91"],
  ])("(%p, %p) -> %p", (cents, cur, expected) => {
    expect(centsToDecimalString(cents, cur)).toBe(expected);
  });

  test.each([[19.99], [-1], [Number.NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1]])(
    "invalid amount %p -> null",
    (cents) => {
      expect(centsToDecimalString(cents, "USD")).toBeNull();
    },
  );

  test.each([[""], ["US"], ["USDX"], ["12$"]])("malformed currency %p -> null", (cur) => {
    expect(centsToDecimalString(1999, cur)).toBeNull();
  });
});

describe("C3 productJsonLd", () => {
  beforeEach(() => withSite("https://shop.example.com"));

  test("offers.price is a decimal string, currency + condition set", () => {
    const p = productJsonLd(BASE);
    expect(p["@context"]).toBe("https://schema.org");
    expect(p["@type"]).toBe("Product");
    expect(p.offers?.price).toBe("19.99");
    expect(typeof p.offers?.price).toBe("string");
    expect(p.offers?.priceCurrency).toBe("USD");
    expect(p.offers?.["@type"]).toBe("Offer");
    expect(p.url).toBe("https://shop.example.com/products/canvas-tote-bag");
    expect(p.offers?.url).toBe(p.url);
    expect(p.image).toEqual(["https://shop.example.com/images/products/canvas-tote-bag.svg"]);
  });

  test("JPY has no decimals", () => {
    expect(productJsonLd({ ...BASE, currency: "JPY" }).offers?.price).toBe("1999");
  });

  test.each([
    [1, "https://schema.org/InStock"],
    [42, "https://schema.org/InStock"],
    [0, "https://schema.org/OutOfStock"],
    [-1, "https://schema.org/OutOfStock"],
    [-0, "https://schema.org/OutOfStock"],
    [Number.NaN, "https://schema.org/OutOfStock"],
    [Infinity, "https://schema.org/OutOfStock"],
    [-Infinity, "https://schema.org/OutOfStock"],
  ])("stock %p -> %p", (stock, expected) => {
    expect(availabilityFor(stock)).toBe(expected as ReturnType<typeof availabilityFor>);
    expect(productJsonLd({ ...BASE, stock }).offers?.availability).toBe(
      expected as ReturnType<typeof availabilityFor>,
    );
  });

  test("aggregateRating present for valid integer count and 1..5 avg", () => {
    const p = productJsonLd({ ...BASE, ratingCount: 12, ratingAvg: 4.26 });
    expect(p.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: 4.3,
      ratingCount: 12,
      bestRating: 5,
      worstRating: 1,
    });
    expect(productJsonLd({ ...BASE, ratingCount: 1, ratingAvg: 1 }).aggregateRating).toBeDefined();
    expect(productJsonLd({ ...BASE, ratingCount: 1, ratingAvg: 5 }).aggregateRating).toBeDefined();
  });

  test.each([
    [undefined, undefined],
    [0, 4],
    [-3, 4],
    [1.5, 4],
    [Number.NaN, 4],
    [Infinity, 4],
    [10, undefined],
    [10, 0],
    [10, 0.99],
    [10, 5.01],
    [10, Number.NaN],
    [10, Infinity],
    [undefined, 4],
  ])("no aggregateRating for count=%p avg=%p", (ratingCount, ratingAvg) => {
    const input: ProductJsonLdInput = {
      ...BASE,
      ...(ratingCount === undefined ? {} : { ratingCount }),
      ...(ratingAvg === undefined ? {} : { ratingAvg }),
    };
    const p = productJsonLd(input);
    expect(p.aggregateRating).toBeUndefined();
    expect("aggregateRating" in p).toBe(false);
  });

  test.each([[19.99], [-1], [Number.NaN], [Infinity]])("invalid price %p drops offers", (priceCents) => {
    const p = productJsonLd({ ...BASE, priceCents });
    expect("offers" in p).toBe(false);
  });

  test.each([[""], ["US"], ["DOLLARS"]])("malformed currency %p drops offers", (currency) => {
    expect("offers" in productJsonLd({ ...BASE, currency })).toBe(false);
  });

  // Defect probe: well-formed but non-ISO-4217 codes are accepted by Intl.
  test.each([["ABC"], ["ZZZ"], ["BTC"]])("non-ISO-4217 currency %p drops offers", (currency) => {
    expect("offers" in productJsonLd({ ...BASE, currency })).toBe(false);
  });

  test("sku via toProductJsonLdInput falls back to id", () => {
    const src = { ...BASE, id: "prod_canvas-tote-bag", imageUrl: "/i.svg" };
    expect(productJsonLd(toProductJsonLdInput(src)).sku).toBe("prod_canvas-tote-bag");
    expect(productJsonLd(toProductJsonLdInput({ ...src, sku: null })).sku).toBe("prod_canvas-tote-bag");
    expect(productJsonLd(toProductJsonLdInput({ ...src, sku: "SKU-1" })).sku).toBe("SKU-1");
  });

  // Defect probe: an empty sku string should not suppress the id fallback.
  test("blank sku string still falls back to id", () => {
    const src = { ...BASE, id: "prod_canvas-tote-bag", imageUrl: "/i.svg" };
    expect(productJsonLd(toProductJsonLdInput({ ...src, sku: "" })).sku).toBe("prod_canvas-tote-bag");
    expect(productJsonLd(toProductJsonLdInput({ ...src, sku: "   " })).sku).toBe("prod_canvas-tote-bag");
  });

  test("toProductJsonLdInput maps imageUrl and brand shapes", () => {
    const { images: _unused, ...noImages } = BASE;
    expect(_unused.length).toBe(1);
    const a = toProductJsonLdInput({ ...noImages, id: "p1", imageUrl: "/a.svg", brand: { name: "Acme" } });
    expect(a.images).toEqual(["/a.svg"]);
    expect(a.brandName).toBe("Acme");
    const b = toProductJsonLdInput({ ...BASE, images: [{ url: "/1.svg" }, "/2.svg"], imageUrl: "/x.svg" });
    expect(b.images).toEqual(["/1.svg", "/2.svg"]);
  });

  test("slug with special characters is encoded in the URL", () => {
    const p = productJsonLd({ ...BASE, slug: "a b/../c" });
    expect(p.url).toBe("https://shop.example.com/products/a%20b%2F..%2Fc");
  });

  test("result round-trips through JSON", () => {
    const p = productJsonLd({ ...BASE, ratingCount: 3, ratingAvg: 4, brandName: "Acme", sku: "S" });
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });
});

describe("C3 BreadcrumbList / WebSite / Organization / FAQPage / ItemList", () => {
  beforeEach(() => withSite("https://shop.example.com"));

  test("breadcrumb positions start at 1, items absolute", () => {
    const b = breadcrumbListJsonLd([
      { name: " Home ", path: "/" },
      { name: "Bags", path: "categories/bags" },
      { name: "Tote", path: "https://cdn.example.net/x" },
    ]);
    expect(b["@type"]).toBe("BreadcrumbList");
    expect(b.itemListElement.map((i) => i.position)).toEqual([1, 2, 3]);
    expect(b.itemListElement.map((i) => i.item)).toEqual([
      "https://shop.example.com/",
      "https://shop.example.com/categories/bags",
      "https://cdn.example.net/x",
    ]);
    expect(b.itemListElement[0]?.name).toBe("Home");
    for (const i of b.itemListElement) expect(i["@type"]).toBe("ListItem");
  });

  test("empty breadcrumb list is still valid shape", () => {
    expect(breadcrumbListJsonLd([]).itemListElement).toEqual([]);
  });

  test("WebSite SearchAction", () => {
    const w = webSiteJsonLd();
    expect(w["@type"]).toBe("WebSite");
    expect(w.url).toBe("https://shop.example.com/");
    expect(w.potentialAction["@type"]).toBe("SearchAction");
    expect(w.potentialAction.target["@type"]).toBe("EntryPoint");
    expect(w.potentialAction.target.urlTemplate).toBe(
      "https://shop.example.com/search?q={search_term_string}",
    );
    expect(w.potentialAction["query-input"]).toBe("required name=search_term_string");
  });

  test("Organization", () => {
    expect(organizationJsonLd()).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Northwind Goods",
      url: "https://shop.example.com/",
    });
  });

  test("FAQPage shape", () => {
    const f = faqPageJsonLd([{ question: " Q1? ", answer: " A1 " }, { question: "Q2?", answer: "A2" }]);
    expect(f["@type"]).toBe("FAQPage");
    expect(f.mainEntity).toEqual([
      { "@type": "Question", name: "Q1?", acceptedAnswer: { "@type": "Answer", text: "A1" } },
      { "@type": "Question", name: "Q2?", acceptedAnswer: { "@type": "Answer", text: "A2" } },
    ]);
  });

  test("ItemList shape", () => {
    const l = itemListJsonLd([{ path: "/products/a", name: "A" }, { path: "/products/b", name: "  " }]);
    expect(l["@type"]).toBe("ItemList");
    expect(l.numberOfItems).toBe(2);
    expect(l.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, url: "https://shop.example.com/products/a", name: "A" },
      { "@type": "ListItem", position: 2, url: "https://shop.example.com/products/b" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 (pure parts): sitemap entries, robots list, manifest colours
// ---------------------------------------------------------------------------
describe("C5 buildSitemapEntries", () => {
  beforeEach(() => withSite("https://shop.example.com"));

  test("home first, then each slug once; duplicates, blanks and padded dupes skipped", () => {
    const entries = buildSitemapEntries([
      { slug: "a" },
      { slug: "b" },
      { slug: "a" },
      { slug: " b " },
      { slug: "" },
      { slug: "   " },
    ]);
    const urls = entries.map((e) => e.url);
    expect(urls).toEqual([
      "https://shop.example.com/",
      "https://shop.example.com/products/a",
      "https://shop.example.com/products/b",
    ]);
    expect(new Set(urls).size).toBe(urls.length);
  });

  test("empty catalog still lists home", () => {
    expect(buildSitemapEntries([]).map((e) => e.url)).toEqual(["https://shop.example.com/"]);
  });

  test("invalid updatedAt never yields an Invalid Date; newest valid date goes on home", () => {
    const entries = buildSitemapEntries([
      { slug: "a", updatedAt: "not a date" },
      { slug: "b", updatedAt: "2026-01-02T00:00:00Z" },
      { slug: "c", updatedAt: "2026-03-04T00:00:00Z" },
    ]);
    expect(entries[1]?.lastModified).toBeUndefined();
    expect(entries[0]?.lastModified).toEqual(new Date("2026-03-04T00:00:00Z"));
  });

  test("toSitemapProduct ignores non-string updatedAt", () => {
    expect(toSitemapProduct({ slug: "a" })).toEqual({ slug: "a" });
    const odd: { slug: string; updatedAt: number } = { slug: "a", updatedAt: 5 };
    expect(toSitemapProduct(odd)).toEqual({ slug: "a" });
  });
});

describe("C5 robots list + manifest colours vs globals.css", () => {
  test("disallow list covers every private route", () => {
    for (const p of ["/cart", "/checkout", "/orders", "/account", "/lists", "/search", "/api/", "/compare"]) {
      expect(ROBOTS_DISALLOW).toContain(p);
    }
    expect(ROBOTS_DISALLOW).not.toContain("/");
  });

  test("THEME_COLOR / BACKGROUND_COLOR equal --accent / --surface-page in globals.css (light theme)", async () => {
    const css = await Bun.file(`${import.meta.dir}/../../src/app/globals.css`).text();
    const first = (name: string): string | undefined =>
      new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})\\s*;`).exec(css)?.[1];
    expect(first("accent")?.toLowerCase()).toBe(THEME_COLOR.toLowerCase());
    expect(first("surface-page")?.toLowerCase()).toBe(BACKGROUND_COLOR.toLowerCase());
  });
});
