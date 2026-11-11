// QA (T147, Phase 3 wave A): ProductCard v3 + PriceBlock (T137) against BACKLOG-phase3 T137 AC1-AC7,
// T147 AC3/AC4 and CONTRACTS L-12 / H-3 / H-16. Independent of the colocated ProductCard tests.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, within } from "@testing-library/react";
import type { CartActionFn } from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import {
  CARD_BADGE_MAX,
  CARD_BADGE_NEW_DAYS,
  PRODUCT_CARD_COMPACT_IMAGE_SIZES,
  ProductCard,
  cardBadges,
  normalizeCardBadges,
  type CardBadgeProduct,
  type ProductCardBadge,
  type ProductCardProps,
} from "@/components/molecules/ProductCard";
import { PriceBlock } from "@/components/molecules/PriceBlock";
import type { Product } from "@/lib/types";
import { expectNull } from "@/test/dom-assertions";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-08T12:00:00.000Z");
const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>&amp; "q" ‮evil`;

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
}

const base: Product = {
  id: "p_1",
  slug: "blue-mug",
  name: "Blue Mug",
  description: "A mug.",
  priceCents: 1250,
  currency: "USD",
  imageUrl: "/images/blue-mug.svg",
  stock: 10,
};
const make = (over: Partial<Product> = {}): Product => ({ ...base, ...over });
const bp = (over: Partial<CardBadgeProduct> = {}): CardBadgeProduct => ({ priceCents: 1000, ...over });
const daysAgo = (d: number, extraMs = 0) => new Date(NOW.getTime() - d * DAY - extraMs).toISOString();

const noopCart: CartActionFn = async () => null;
const noopList: ListActionFn = async () => null;

let refSeq = 0;
/** Mimics a Next server reference as React SSR sees it (`$$FORM_ACTION`), kept across `.bind`. */
function serverLike<T>(): T {
  const id = ++refSeq;
  const fields = () => ({ name: `$ACTION_REF_${id}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  const mk = (): unknown => Object.assign(async () => null, { $$FORM_ACTION: fields, bind: () => mk() });
  return mk() as T;
}

function extras(over: Partial<ProductCardProps> = {}): Partial<ProductCardProps> {
  return {
    quickAdd: { action: noopCart },
    wishlist: { inList: false, addAction: noopList, removeAction: noopList },
    compare: { selected: [], basePath: "/search?q=mug" },
    ...over,
  };
}

const classesOf = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
const allClasses = (root: ParentNode) =>
  [...root.querySelectorAll("[class]")].flatMap((el) => classesOf(el));

/** Text a screen reader reads: aria-hidden subtrees skipped. */
function spoken(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node instanceof Element && node.getAttribute("aria-hidden") === "true") return "";
  return [...node.childNodes].map(spoken).join("");
}

// ============================================================ AC1 / T147 AC3: cardBadges boundaries
describe("T137 AC1 / T147 AC3: cardBadges(product, now) rules and boundaries", () => {
  test("no list price / list == price / list < price / invalid list: no Sale", () => {
    for (const listPriceCents of [undefined, null, 1000, 999, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1000.5]) {
      expect({ listPriceCents, badges: cardBadges(bp({ listPriceCents }), NOW) }).toEqual({ listPriceCents, badges: [] });
    }
  });

  test("list price one cent above the price: Sale", () => {
    expect(cardBadges(bp({ listPriceCents: 1001 }), NOW)).toEqual(["sale"]);
  });

  test("New: day 29 and exactly day 30 are New (inclusive); day 30 + 1 ms and day 31 are not (documented boundary)", () => {
    expect(CARD_BADGE_NEW_DAYS).toBe(30);
    expect(cardBadges(bp({ publishedAt: daysAgo(29) }), NOW)).toEqual(["new"]);
    expect(cardBadges(bp({ publishedAt: daysAgo(30) }), NOW)).toEqual(["new"]);
    expect(cardBadges(bp({ publishedAt: daysAgo(30, 1) }), NOW)).toEqual([]);
    expect(cardBadges(bp({ publishedAt: daysAgo(31) }), NOW)).toEqual([]);
  });

  test("New: published exactly now is New; 1 ms in the future (not yet published) is not", () => {
    expect(cardBadges(bp({ publishedAt: NOW.toISOString() }), NOW)).toEqual(["new"]);
    expect(cardBadges(bp({ publishedAt: new Date(NOW.getTime() + 1).toISOString() }), NOW)).toEqual([]);
  });

  test("New: garbage dates and an invalid `now` never throw and never yield New", () => {
    for (const publishedAt of ["", "yesterday", "2026-13-45", "   "]) {
      expect(cardBadges(bp({ publishedAt }), NOW)).toEqual([]);
    }
    expect(cardBadges(bp({ publishedAt: daysAgo(1), listPriceCents: 2000 }), new Date(Number.NaN))).toEqual(["sale"]);
  });

  test("Top pick: 4.5 with 4 reviews is not; 4.49 with 5 is not; 4.5 with 5 is; 5.0 with 1000 is", () => {
    expect(cardBadges(bp({ ratingAvg: 4.5, ratingCount: 4 }), NOW)).toEqual([]);
    expect(cardBadges(bp({ ratingAvg: 4.49, ratingCount: 5 }), NOW)).toEqual([]);
    expect(cardBadges(bp({ ratingAvg: 4.5, ratingCount: 5 }), NOW)).toEqual(["top_pick"]);
    expect(cardBadges(bp({ ratingAvg: 5, ratingCount: 1000 }), NOW)).toEqual(["top_pick"]);
  });

  test("Top pick: non-integer, NaN or infinite counts and NaN averages never qualify", () => {
    for (const [ratingAvg, ratingCount] of [
      [4.8, 5.5],
      [4.8, Number.NaN],
      [4.8, Number.POSITIVE_INFINITY],
      [Number.NaN, 50],
      [Number.POSITIVE_INFINITY, 50],
    ] as const) {
      expect({ ratingAvg, ratingCount, b: cardBadges(bp({ ratingAvg, ratingCount }), NOW) }).toEqual({ ratingAvg, ratingCount, b: [] });
    }
  });

  test("> 2 qualifying: only two, in priority order sale > new > top pick", () => {
    expect(CARD_BADGE_MAX).toBe(2);
    const all = bp({ listPriceCents: 2000, publishedAt: daysAgo(1), ratingAvg: 4.9, ratingCount: 99 });
    expect(cardBadges(all, NOW)).toEqual(["sale", "new"]);
    expect(cardBadges(bp({ publishedAt: daysAgo(1), ratingAvg: 4.9, ratingCount: 99 }), NOW)).toEqual(["new", "top_pick"]);
    expect(cardBadges(bp({ listPriceCents: 2000, ratingAvg: 4.9, ratingCount: 99 }), NOW)).toEqual(["sale", "top_pick"]);
  });

  test("pure: same input + now gives the same output, input not mutated", () => {
    const input = Object.freeze(bp({ listPriceCents: 2000, publishedAt: daysAgo(3), ratingAvg: 4.9, ratingCount: 9 }));
    const a = cardBadges(input, NOW);
    const b = cardBadges(input, new Date(NOW.getTime()));
    expect(a).toEqual(b);
    expect(input.listPriceCents).toBe(2000);
  });

  test("normalizeCardBadges: known keys only, deduped, order kept, capped at 2; non-arrays -> []", () => {
    const raw = ["top_pick", "__proto__", "top_pick", "sale", "new"] as unknown as ProductCardBadge[];
    expect(normalizeCardBadges(raw)).toEqual(["top_pick", "sale"]);
    expect(normalizeCardBadges(undefined)).toEqual([]);
    expect(normalizeCardBadges("sale" as unknown as ProductCardBadge[])).toEqual([]);
  });
});

describe("T137 badges on the card (CONTRACTS L-12: <= 2, texts from Sale/New/Top pick)", () => {
  const badgeTexts = (container: ParentNode) =>
    [...container.querySelectorAll('[data-testid="product-card-badges"] > span')].map((el) => el.textContent);

  test("derived from product data with the injected clock; texts are words, not colour only", () => {
    const { container } = render(
      <ProductCard product={make({ listPriceCents: 2000, publishedAt: daysAgo(2), ratingAvg: 4.8, ratingCount: 40 })} now={NOW} />,
    );
    expect(badgeTexts(container)).toEqual(["Sale", "New"]);
  });

  test("the card feeds the rules what it shows: rating={null} removes Top pick; listPriceCents={null} removes Sale", () => {
    const p = make({ listPriceCents: 2000, ratingAvg: 4.9, ratingCount: 50 });
    const { container, unmount } = render(<ProductCard product={p} now={NOW} rating={null} />);
    expect(badgeTexts(container)).toEqual(["Sale"]);
    unmount();
    const r = render(<ProductCard product={p} now={NOW} listPriceCents={null} />);
    expect(badgeTexts(r.container)).toEqual(["Top pick"]);
  });

  test("badges={[]} hides derived badges; no overlay and one tab stop without extras", () => {
    const { container } = render(<ProductCard product={make({ listPriceCents: 2000 })} badges={[]} now={NOW} />);
    expectNull(container.querySelector('[data-testid="product-card-badges"]'));
    expectNull(container.querySelector('[data-slot="product-card-overlay"]'));
    expect(container.querySelectorAll("a, button, input, select, textarea").length).toBe(1);
  });

  test("rank does not count against the 2-badge cap and is announced as 'Rank'", () => {
    const { container } = render(
      <ProductCard product={make({ listPriceCents: 2000, publishedAt: daysAgo(1), ratingAvg: 5, ratingCount: 9 })} rank={3} now={NOW} />,
    );
    expect(badgeTexts(container)).toEqual(["Rank #3", "Sale", "New"]);
  });

  test("every rendered badge text is one of the known labels (never empty)", () => {
    const allowed = new Set(["Sale", "New", "Top pick", "Deal", "Best Seller"]);
    for (const badges of [["sale", "new"], ["top_pick", "deal"], ["best_seller"]] as ProductCardBadge[][]) {
      const { container, unmount } = render(<ProductCard product={make()} badges={badges} />);
      for (const t of badgeTexts(container)) expect({ t, ok: allowed.has(t ?? "") }).toEqual({ t, ok: true });
      unmount();
    }
  });
});

// ============================================================ AC2-AC4: quick add + single link
describe("T137 AC2/AC4 + L-12: one link; '+ Add' form is a sibling with productId + quantity=1 only", () => {
  test("exactly one link to the PDP; it wraps image + title and contains no interactive element", () => {
    const { container } = render(<ProductCard product={make()} {...extras()} />);
    const pdpLinks = [...container.querySelectorAll("a")].filter((a) => a.getAttribute("href") === "/products/blue-mug");
    expect(pdpLinks).toHaveLength(1);
    const link = pdpLinks[0]!;
    expect(link.querySelectorAll("a, button, input, select, textarea, [tabindex]").length).toBe(0);
    expect(link.querySelector('[data-slot="product-card-image"]') === null ? "missing" : "image").toBe("image");
    expect(link.querySelector("h3")?.textContent).toBe("Blue Mug");
  });

  test("the quick-add form is NOT inside the link and posts only hidden productId + quantity=1 (SR9)", () => {
    const { container } = render(<ProductCard product={make()} {...extras({ wishlist: undefined, compare: undefined })} />);
    const forms = [...container.querySelectorAll("form")];
    expect(forms).toHaveLength(1);
    const form = forms[0]!;
    expect(form.closest("a") === null).toBe(true);
    const fields = [...form.querySelectorAll("input, select, textarea")].map((el) => [
      el.getAttribute("type"),
      el.getAttribute("name"),
      el.getAttribute("value"),
    ]);
    expect(fields).toEqual([
      ["hidden", "productId", "p_1"],
      ["hidden", "quantity", "1"],
    ]);
    expect(form.innerHTML).not.toMatch(/price|total|cents/i);
  });

  test("'+ Add' button: visible 'Add' with a plus icon, accessible name 'Add to cart: <name>', 44px outer hit area", () => {
    render(<ProductCard product={make()} quickAdd={{ action: noopCart }} />);
    const btn = screen.getByRole("button", { name: "Add to cart: Blue Mug" });
    expect(btn.getAttribute("type")).toBe("submit");
    expect(btn.querySelector('svg[data-icon="plus"]') === null ? "no plus" : "plus").toBe("plus");
    expect(spoken(btn).trim()).toBe("Add to cart: Blue Mug");
    expect(classesOf(btn)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch"]));
  });

  test("no-JS POST via $$FORM_ACTION fixture: method POST, multipart, never a javascript: action", () => {
    const doc = parse(renderToStaticMarkup(<ProductCard product={make()} quickAdd={{ action: serverLike<CartActionFn>() }} />));
    const form = doc.querySelector("form");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form?.getAttribute("action") ?? "").not.toContain("javascript:");
    expect(doc.querySelector('form input[name="productId"]')?.getAttribute("value")).toBe("p_1");
    expect(doc.querySelector('form input[name="quantity"]')?.getAttribute("value")).toBe("1");
  });

  for (const [label, stock] of [["0", 0], ["-1", -1], ["NaN", Number.NaN], ["2.5", 2.5]] as const) {
    test(`stock prop ${label}: no form, a disabled 'Out of stock' control, and still one PDP link`, () => {
      const { container } = render(<ProductCard product={make({ stock: 10 })} stock={stock} quickAdd={{ action: noopCart }} />);
      expect(container.querySelectorAll("form").length).toBe(0);
      const btn = within(container.querySelector('[data-slot="product-card-overlay"]') as HTMLElement).getByRole("button");
      expect(btn.hasAttribute("disabled")).toBe(true);
      expect(btn.textContent).toContain("Out of stock");
      expect(container.querySelectorAll('a[href="/products/blue-mug"]').length).toBe(1);
    });
  }

  test("product.stock 0 (no stock prop) also replaces the form", () => {
    const { container } = render(<ProductCard product={make({ stock: 0 })} quickAdd={{ action: noopCart }} />);
    expect(container.querySelectorAll("form").length).toBe(0);
    expect(container.textContent).toContain("Out of stock");
  });

  test("hostile product name: text only in heading, link and button names; nothing injected", () => {
    const { container } = render(<ProductCard product={make({ name: HOSTILE, brandName: HOSTILE })} {...extras()} />);
    expect(container.querySelectorAll("script, img[src='x'], [onerror]").length).toBe(0);
    expect(container.querySelector("h3")?.textContent).toBe(HOSTILE);
    expect(screen.getByRole("button", { name: `Add to cart: ${HOSTILE.trim()}` }).getAttribute("type")).toBe("submit");
  });

  test("wishlist heart and compare still render with 44px targets (AC7)", () => {
    render(<ProductCard product={make()} {...extras()} />);
    const heart = screen.getByRole("button", { name: "Add Blue Mug to Wish List" });
    expect(classesOf(heart)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch"]));
    const compareLabel = screen.getByText("Compare Blue Mug").closest("label");
    expect(classesOf(compareLabel)).toContain("min-h-touch");
  });
});

// ============================================================ AC5: price names
describe("T137 AC5 + L-12: price accessible names", () => {
  test("price reads '$12.50' (never '1250'); list price is in <s> and reads 'Was $19.00'", () => {
    const { container } = render(<ProductCard product={make({ listPriceCents: 1900 })} badges={[]} />);
    const priceArea = container.querySelector('[data-layout="inline"]') as HTMLElement;
    const text = spoken(priceArea).replace(/\s+/g, " ");
    expect(text).toContain("$12.50");
    expect(text).not.toMatch(/\b1250\b/);
    const s = priceArea.querySelector("s");
    expect(spoken(s as Node).trim()).toBe("Was $19.00");
  });

  test("whole-dollar price: visual drops .00, spoken stays $24.00 (ruling D-T131-2)", () => {
    const { container } = render(<ProductCard product={make({ priceCents: 2400 })} />);
    const area = container.querySelector('[data-layout="inline"]') as HTMLElement;
    expect(spoken(area)).toContain("$24.00");
    expect(area.querySelector('[data-slot="price-superscript"]')?.textContent).toBe("$24");
  });

  test("list <= price: no <s>, no 'Was'", () => {
    for (const listPriceCents of [1250, 1000, null]) {
      const { container, unmount } = render(<ProductCard product={make({ listPriceCents })} />);
      expectNull(container.querySelector("s"));
      expect(container.textContent).not.toContain("Was");
      unmount();
    }
  });

  test("PriceBlock inline + superscript alone: invalid price renders nothing and does not throw", () => {
    for (const priceCents of [-1, Number.NaN, 1.5]) {
      const html = renderToStaticMarkup(<PriceBlock priceCents={priceCents} currency="USD" display="superscript" layout="inline" />);
      expect(html.includes("$") ? "price shown" : "nothing").toBe("nothing");
    }
  });
});

// ============================================================ AC6 + compact variant
describe("T137 AC6 + compact variant (H-16)", () => {
  test("default: min-w-40, title line-clamp-2, fixed aspect image box; data-variant=default", () => {
    const { container } = render(<ProductCard product={make()} />);
    const article = container.querySelector("article");
    expect(article?.getAttribute("data-variant")).toBe("default");
    expect(classesOf(article)).toContain("min-w-40");
    expect(classesOf(container.querySelector("h3"))).toContain("line-clamp-2");
    expect(classesOf(container.querySelector('[data-slot="product-card-image"]'))).toContain("aspect-square");
  });

  test("compact: data-variant=compact, tighter padding, small title, compact image sizes, same data", () => {
    const p = make({ listPriceCents: 1900, brandName: "Acme", ratingAvg: 4.6, ratingCount: 12 });
    const { container } = render(<ProductCard product={p} variant="compact" {...extras()} />);
    const article = container.querySelector("article");
    expect(article?.getAttribute("data-variant")).toBe("compact");
    expect(classesOf(article)).toEqual(expect.arrayContaining(["p-2", "gap-1", "min-w-40"]));
    expect(classesOf(container.querySelector("h3"))).toEqual(expect.arrayContaining(["text-small", "line-clamp-2"]));
    // next/image drops `sizes` for SVG sources (served unoptimised); check with a raster path.
    const ssrImg = parse(renderToStaticMarkup(<ProductCard product={{ ...p, imageUrl: "/images/x.jpg" }} variant="compact" />)).querySelector("img");
    expect(ssrImg?.getAttribute("sizes")).toBe(PRODUCT_CARD_COMPACT_IMAGE_SIZES);
    expect(container.textContent).toContain("Acme");
    expect(spoken(container)).toContain("$12.50");
    expect(spoken(container)).toContain("Was $19.00");
    // still a "+ Add" form with a 44px outer target
    const add = screen.getByRole("button", { name: "Add to cart: Blue Mug" });
    expect(classesOf(add)).toEqual(expect.arrayContaining(["min-h-touch", "min-w-touch"]));
  });

  test("compact ignores layout='list' (no excerpt, no float)", () => {
    const { container } = render(<ProductCard product={make()} variant="compact" layout="list" bullets={["One"]} />);
    expect(container.querySelector("article")?.getAttribute("data-layout")).toBe("grid");
    expect(container.textContent).not.toContain("A mug.");
    expectNull(container.querySelector("ul"));
  });

  test("H-3: the card title is never h1/h2 by default; headingLevel is honoured", () => {
    const { container } = render(<ProductCard product={make()} />);
    expect(container.querySelectorAll("h1, h2").length).toBe(0);
    const r = render(<ProductCard product={make()} headingLevel={4} />);
    expect(r.container.querySelector("h4")?.textContent).toBe("Blue Mug");
  });
});

// ============================================================ cross-cutting: tokens / light-only / brand-free
describe("ProductCard v3 cross-cutting", () => {
  const variants = [
    <ProductCard key="a" product={make({ listPriceCents: 1900, publishedAt: daysAgo(1) })} now={NOW} {...extras()} />,
    <ProductCard key="b" product={make({ imageUrl: "" })} variant="compact" {...extras()} />,
    <ProductCard key="c" product={make({ stock: 0 })} layout="list" bullets={["x"]} {...extras()} rank={1} />,
  ];

  test("no arbitrary values, palette colours, dark: variants or inline style (except next/image)", () => {
    const doc = parse(renderToStaticMarkup(<>{variants}</>));
    const cls = allClasses(doc);
    expect(cls.filter((c) => /\[|^dark:|:dark:/.test(c))).toEqual([]);
    expect(
      cls.filter((c) => /(^|:)(bg|text|border|ring|fill|stroke|outline)-(gray|slate|zinc|neutral|stone|red|blue|green|yellow|amber|orange|white|black)(-\d+)?$/.test(c)),
    ).toEqual([]);
    expect([...doc.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG").length).toBe(0);
  });

  test("no outline-none on focusable elements (focus ring stays visible)", () => {
    const doc = parse(renderToStaticMarkup(<>{variants}</>));
    const bad = [...doc.querySelectorAll("a, button, input")].filter((el) =>
      classesOf(el).some((c) => /^(focus(-visible)?:)?outline-(none|0)$/.test(c)),
    );
    expect(bad.length).toBe(0);
  });

  test("brand-free copy", () => {
    const html = renderToStaticMarkup(<>{variants}</>).toLowerCase();
    for (const word of ["kmart", "onepass", "afterpay", "zip pay", "marketplace", "online only"]) expect({ word, hit: html.includes(word) }).toEqual({ word, hit: false });
  });
});
