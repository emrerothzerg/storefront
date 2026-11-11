// QA (QA-W4-organisms-E / T90): T74 ProductCard v2 (+ QuickAddForm, excerpt) and ProductGrid v2.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn, CartActionState } from "@/components/molecules/_contracts/cart-actions";
import { LIST_FIELD, type ListActionFn } from "@/components/molecules/_contracts/list-actions";
import {
  EXCERPT_MAX,
  ProductCard,
  QuickAddForm,
  excerpt,
  normalizeCardBadges,
  type ProductCardBadge,
  type ProductCardProps,
} from "@/components/molecules/ProductCard";
import { ProductGrid, type ProductGridCardExtras } from "@/components/organisms/ProductGrid";
import { positionRankCardProps } from "@/components/templates/ListingTemplate";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";

const SRC = join(import.meta.dir, "../../../src/components");
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; ‮evil`;

const base: Product = {
  id: "p_1",
  slug: "canvas-tote-bag",
  name: "Canvas Tote Bag",
  description: "A sturdy tote.",
  priceCents: 2400,
  currency: "USD",
  imageUrl: "/images/products/canvas-tote-bag.jpg",
  stock: 12,
};
const make = (over: Partial<Product> = {}): Product => ({ ...base, ...over });

const noopCart: CartActionFn = async () => null;
const noopList: ListActionFn = async () => null;

/** A Next server reference as React SSR sees it: `$$FORM_ACTION`, kept across `.bind`. */
function serverLike<F extends (...args: never[]) => unknown>(fn: F): F {
  const formFields = () => ({
    name: "$ACTION_REF_1",
    action: "",
    encType: "multipart/form-data",
    method: "POST",
    data: null,
  });
  return Object.assign(fn, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}

const parse = (html: string): Document => new DOMParser().parseFromString(html, "text/html");

function allExtras(): Omit<ProductCardProps, "product"> {
  return {
    rating: { avg: 4.5, count: 1234 },
    listPriceCents: 3000,
    badges: ["best_seller", "deal", "new", "top_pick"],
    rank: 1,
    stock: 3,
    wishlist: { inList: false, addAction: noopList, removeAction: noopList },
    quickAdd: { action: noopCart },
    compare: { selected: ["x"], basePath: "/search?q=tote" },
  };
}

// --------------------------------------------------------------------------------------------
describe("T74 ProductCard: MVP call sites (criteria 1, 6)", () => {
  test("no v2 props renders identically to explicit defaults and contains no v2-only nodes", () => {
    const mvp = renderToStaticMarkup(<ProductCard product={make()} />);
    const explicit = renderToStaticMarkup(
      <ProductCard
        product={make()}
        priority={false}
        headingLevel={3}
        layout="grid"
        rating={undefined}
        badges={undefined}
        stock={undefined}
      />,
    );
    expect(explicit).toBe(mvp);
    const doc = parse(mvp);
    expect(doc.querySelectorAll("form")).toHaveLength(0);
    expect(doc.querySelectorAll("button, input")).toHaveLength(0);
    expect(doc.querySelectorAll("a")).toHaveLength(1);
    expect(doc.querySelector("s")).toBeNull();
    expect(mvp).not.toContain("% off");
    expect(mvp).not.toContain("stars");
    expect(doc.querySelector('[data-testid="product-card-badges"]')).toBeNull();
    expect(doc.querySelector("ul")).toBeNull();
    expect(doc.querySelector("h3")?.className).toContain("line-clamp-2");
  });

  test("the only markup delta an MVP call site sees is the additive data-layout + data-variant attributes (documented)", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} />);
    // Byte-equality against a pre-T74 snapshot is impossible (no VCS, no stored fixture); the article now
    // carries data-layout="grid" (T74) and data-variant="default" (T137, Phase 3 compact variant).
    // Pinned so any further MVP-visible change is caught.
    const article = parse(html).querySelector("article");
    expect(article?.getAttributeNames().sort()).toEqual(["class", "data-layout", "data-variant"]);
    expect(article?.getAttribute("data-layout")).toBe("grid");
    expect(article?.getAttribute("data-variant")).toBe("default");
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 ProductCard: exactly one link per card (criterion 1)", () => {
  const toggles = ["wishlist", "quickAdd", "compare", "list", "outOfStock", "decor"] as const;
  const combos: Array<Record<(typeof toggles)[number], boolean>> = [];
  for (let mask = 0; mask < 1 << toggles.length; mask += 1) {
    combos.push(Object.fromEntries(toggles.map((t, i) => [t, (mask & (1 << i)) !== 0])) as Record<(typeof toggles)[number], boolean>);
  }

  test(`all ${combos.length} v2 combinations: one <a>, to the product page; every other control is a button/input`, () => {
    for (const c of combos) {
      const props: ProductCardProps = {
        product: make(),
        layout: c.list ? "list" : "grid",
        stock: c.outOfStock ? 0 : 7,
        ...(c.wishlist ? { wishlist: { inList: true, listId: "L1", addAction: noopList, removeAction: noopList } } : {}),
        ...(c.quickAdd ? { quickAdd: { action: noopCart } } : {}),
        ...(c.compare ? { compare: { selected: ["a", "b"], basePath: "/deals?sort=price" } } : {}),
        ...(c.decor ? { rating: { avg: 3.9, count: 12 }, listPriceCents: 5000, badges: ["deal"], rank: 4, bullets: ["One", "Two"] } : {}),
      };
      const doc = parse(renderToStaticMarkup(<ProductCard {...props} />));
      const links = doc.querySelectorAll("a");
      expect({ combo: c, links: links.length }).toEqual({ combo: c, links: 1 });
      expect(links[0]?.getAttribute("href")).toBe("/products/canvas-tote-bag");
      for (const el of doc.querySelectorAll("button, input[type=checkbox], input[type=submit]")) {
        expect(el.closest("a")).toBeNull();
        expect(el.closest(".z-raised")).not.toBeNull();
      }
    }
  });

  test("rendered (hydrated) card with every option: one link role, and the link is not nested in a control", () => {
    render(<ProductCard product={make()} {...allExtras()} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getAllByRole("link")[0]?.closest("button")).toBeNull();
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 ProductCard: rating (criterion 2)", () => {
  const hidden: Array<[string, ProductCardProps["rating"], Partial<Product>]> = [
    ["count 0", { avg: 4, count: 0 }, {}],
    ["count -3", { avg: 4, count: -3 }, {}],
    ["count NaN", { avg: 4, count: Number.NaN }, {}],
    ["count 1.5", { avg: 4, count: 1.5 }, {}],
    ["count Infinity", { avg: 4, count: Number.POSITIVE_INFINITY }, {}],
    ["avg NaN", { avg: Number.NaN, count: 3 }, {}],
    ["explicit null over product data", null, { ratingAvg: 4.2, ratingCount: 10 }],
    ["product ratingCount 0", undefined, { ratingAvg: 0, ratingCount: 0 }],
    ["product without rating fields", undefined, {}],
  ];
  for (const [label, rating, over] of hidden) {
    test(`hidden for ${label} (no "0.0 stars", no "(0)")`, () => {
      const html = renderToStaticMarkup(<ProductCard product={make(over)} rating={rating} />);
      // T137: class names such as `items-start` contain "star", so the check reads the text, word-bounded.
      expect(parse(html).body.textContent ?? "").not.toMatch(/\bstars?\b/i);
      expect(html).not.toContain('data-testid="rating-stars"');
      expect(html).not.toContain("(0)");
      expect(html).not.toContain("0.0");
    });
  }

  test('counts are formatted "1,234" and the value is announced', () => {
    render(<ProductCard product={make()} rating={{ avg: 4.5, count: 1234 }} />);
    expect(document.body.textContent).toContain("(1,234)");
    expect(document.body.textContent).toMatch(/4\.5 out of 5 stars/);
  });

  test("falls back to product.ratingAvg/ratingCount (ProductSummary from listing service)", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ ratingAvg: 3.7, ratingCount: 1000000 })} />);
    expect(html).toContain("(1,000,000)");
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 ProductCard: list price, % off, badges, rank, stock", () => {
  test("list > price: struck list price + 'N% off' (floor)", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ priceCents: 2000 })} listPriceCents={3000} />);
    expect(parse(html).querySelector("s")?.textContent).toContain("$30.00");
    expect(html).toContain("33% off");
  });

  test("saving under 1%: strike shown, '% off' omitted", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ priceCents: 9950 })} listPriceCents={10000} />);
    expect(parse(html).querySelector("s")?.textContent).toContain("$100.00");
    expect(html).not.toContain("% off");
  });

  for (const list of [2400, 1000, -1, Number.NaN, 2500.5, Number.POSITIVE_INFINITY, null]) {
    test(`list price ${String(list)} vs price 2400: no strike, no '% off', no throw`, () => {
      const html = renderToStaticMarkup(<ProductCard product={make()} listPriceCents={list} />);
      expect(parse(html).querySelector("s")).toBeNull();
      expect(html).not.toContain("% off");
    });
  }

  test("explicit listPriceCents=null overrides product.listPriceCents", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ listPriceCents: 5000 })} listPriceCents={null} />);
    expect(html).not.toContain("% off");
  });

  test("badges: text, in order, deduped; unknown and prototype keys ignored", () => {
    const raw = ["deal", "deal", "bogus", "toString", "__proto__", "constructor", "new", "deal"] as unknown as ProductCardBadge[];
    expect(normalizeCardBadges(raw)).toEqual(["deal", "new"]);
    const html = renderToStaticMarkup(<ProductCard product={make()} badges={raw} />);
    const text = parse(html).querySelector('[data-testid="product-card-badges"]')?.textContent;
    expect(text).toBe("DealNew");
  });

  test("all badge labels are text; at most 2 per card (T137 CARD_BADGE_MAX)", () => {
    const four = renderToStaticMarkup(<ProductCard product={make()} badges={["best_seller", "deal", "new", "top_pick"]} />);
    const shown = [...parse(four).querySelectorAll('[data-testid="product-card-badges"] > span')].map((el) => el.textContent);
    expect(shown).toEqual(["Best Seller", "Deal"]);
    const rest = renderToStaticMarkup(<ProductCard product={make()} badges={["new", "top_pick", "sale"]} />);
    const shownRest = [...parse(rest).querySelectorAll('[data-testid="product-card-badges"] > span')].map((el) => el.textContent);
    expect(shownRest).toEqual(["New", "Top pick"]);
    const sale = renderToStaticMarkup(<ProductCard product={make()} badges={["sale"]} />);
    expect(parse(sale).querySelector('[data-testid="product-card-badges"]')?.textContent).toBe("Sale");
  });

  for (const rank of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
    test(`rank ${String(rank)} is hidden`, () => {
      const html = renderToStaticMarkup(<ProductCard product={make()} rank={rank} />);
      expect(html).not.toMatch(/Rank/);
      expect(html).not.toContain("#");
    });
  }

  test("rank 1 renders '#1' with an sr-only 'Rank' prefix", () => {
    render(<ProductCard product={make()} rank={1} />);
    expect(document.querySelector('[data-testid="product-card-badges"]')?.textContent).toBe("Rank #1");
  });

  test("stock prop -> StockUrgency text; absent -> MVP StockBadge", () => {
    const urgent = renderToStaticMarkup(<ProductCard product={make({ stock: 50 })} stock={3} />);
    expect(urgent).toContain("Only 3 left in stock");
    const mvp = renderToStaticMarkup(<ProductCard product={make({ stock: 50 })} />);
    expect(mvp).not.toContain("left in stock");
    expect(mvp).toContain("In stock");
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 QuickAddForm (criterion 3)", () => {
  test("no-JS shape with a server action: POST multipart, hidden productId + quantity=1, no stepper", () => {
    const action = serverLike<CartActionFn>(async () => null);
    const html = renderToStaticMarkup(<ProductCard product={make()} quickAdd={{ action }} />);
    const form = parse(html).querySelector("form");
    expect(form?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(form?.getAttribute("action") ?? "").not.toContain("javascript:");
    const named = [...(form?.querySelectorAll("input[name]") ?? [])]
      .map((i) => [i.getAttribute("name"), i.getAttribute("type"), i.getAttribute("value")])
      .filter(([n]) => !n?.startsWith("$ACTION"));
    expect(named).toEqual([
      ["productId", "hidden", "p_1"],
      ["quantity", "hidden", "1"],
    ]);
    expect(form?.querySelector("select, input[type=number]")).toBeNull();
  });

  test('button names are "Add to cart: <name>" and distinct per card in a grid', () => {
    const products = [make({ id: "a", slug: "a", name: "Alpha" }), make({ id: "b", slug: "b", name: "Beta" }), make({ id: "c", slug: "c", name: "Gamma" })];
    render(<ProductGrid products={products} cardProps={() => ({ quickAdd: { action: noopCart } })} />);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    expect(names).toEqual(["Add to cart: Alpha", "Add to cart: Beta", "Add to cart: Gamma"]);
    expect(new Set(names).size).toBe(3);
  });

  for (const stock of [0, -2, Number.NaN, 1.5]) {
    test(`stock ${String(stock)}: disabled "Out of stock" button and NO form`, () => {
      const html = renderToStaticMarkup(<ProductCard product={make()} stock={stock} quickAdd={{ action: noopCart }} />);
      const doc = parse(html);
      expect(doc.querySelector("form")).toBeNull();
      const button = doc.querySelector("button");
      expect(button?.hasAttribute("disabled")).toBe(true);
      expect(button?.textContent).toBe("Out of stock: Canvas Tote Bag");
    });
  }

  test("falls back to product.stock 0 when no stock prop", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ stock: 0 })} quickAdd={{ action: noopCart }} />);
    expect(parse(html).querySelector("form")).toBeNull();
  });

  test("pending: submit button gets aria-busy until the action settles; posts productId + quantity", async () => {
    let release: (s: CartActionState) => void = () => undefined;
    const posted: string[][] = [];
    const action: CartActionFn = (_prev, fd) => {
      posted.push([...fd.entries()].map(([k, v]) => `${k}=${String(v)}`));
      return new Promise<CartActionState>((resolve) => {
        release = resolve;
      });
    };
    render(<QuickAddForm productId="p_9" productName="Nine" stock={4} action={action} />);
    const button = screen.getByRole("button", { name: /^Add to cart\s*: Nine$/ });
    await act(async () => {
      fireEvent.submit(button.closest("form") as HTMLFormElement);
    });
    expect(posted).toEqual([["productId=p_9", "quantity=1"]]);
    expect(screen.getByRole("button").getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      release(null);
    });
    expect(screen.getByRole("button").hasAttribute("aria-busy")).toBe(false);
  });

  test('error state renders role="alert" with the message as text', async () => {
    const action: CartActionFn = async () => ({
      ok: false,
      error: { code: "OUT_OF_STOCK", message: `Sold out ${HOSTILE}` },
    }) as unknown as CartActionState;
    const { container } = render(<QuickAddForm productId="p_9" productName="Nine" stock={4} action={action} />);
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(`Sold out ${HOSTILE}`);
    expect(container.querySelector("img, script")).toBeNull();
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 ProductCard list layout (criterion 4, 5, R-T74-1)", () => {
  const longDescription = `${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(8)}`;

  test("excerpt <= 160 incl. ellipsis, <= 3 bullets, name clamp 3 lines", () => {
    const html = renderToStaticMarkup(
      <ProductCard
        product={make({ description: longDescription })}
        layout="list"
        bullets={["One", "  ", "Two", "Three", "Four", "Five"]}
      />,
    );
    const doc = parse(html);
    const p = [...doc.querySelectorAll("p")].find((el) => el.textContent?.startsWith("Lorem"));
    expect(p).toBeDefined();
    expect(p?.textContent?.length ?? 999).toBeLessThanOrEqual(160);
    expect(p?.textContent?.endsWith("…")).toBe(true);
    const bullets = [...doc.querySelectorAll("ul li")].map((li) => li.textContent);
    expect(bullets).toEqual(["One", "Two", "Three"]);
    expect(doc.querySelector("h3")?.className).toContain("line-clamp-3");
    expect(doc.querySelector("article")?.getAttribute("data-layout")).toBe("list");
  });

  test("short description is shown whole, without an ellipsis", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} layout="list" />);
    expect(html).toContain(">A sturdy tote.<");
    expect(html).not.toContain("…");
  });

  test("grid layout keeps line-clamp-2 and shows no excerpt/bullets", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ description: longDescription })} bullets={["One"]} />);
    const doc = parse(html);
    expect(doc.querySelector("h3")?.className).toContain("line-clamp-2");
    expect(doc.querySelector("h3")?.className).not.toContain("line-clamp-3");
    expect(html).not.toContain("Lorem");
    expect(doc.querySelector("ul")).toBeNull();
  });

  test("missing image -> placeholder in list layout with every option", () => {
    const html = renderToStaticMarkup(<ProductCard product={make({ imageUrl: "" })} layout="list" {...allExtras()} />);
    const doc = parse(html);
    expect(doc.querySelector("img")).toBeNull();
    // T137: the image is decorative (the card link is named by the product); the placeholder is aria-hidden.
    expect(doc.querySelector("[data-placeholder]")?.getAttribute("aria-hidden")).toBe("true");
    const link = doc.querySelector('a[href="/products/canvas-tote-bag"]');
    expect(link?.textContent?.trim()).toBe("Canvas Tote Bag");
  });

  test("bullet over 160 chars is excerpted", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} layout="list" bullets={["word ".repeat(80)]} />);
    const li = parse(html).querySelector("ul li");
    expect(li?.textContent?.length ?? 999).toBeLessThanOrEqual(160);
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 excerpt()", () => {
  test("never longer than max (incl. ellipsis) over many lengths and limits", () => {
    for (let n = 0; n < 400; n += 7) {
      for (const max of [2, 3, 10, 50, 160]) {
        const out = excerpt("ab cd ".repeat(n), max);
        expect(out.length).toBeLessThanOrEqual(max);
      }
    }
  });

  test("never splits a grapheme cluster (ZWJ family, flags, skin tones, combining marks)", () => {
    const clusters = ["👨‍👩‍👧‍👦", "🇬🇧", "👍🏽", "é", "ñ̃"];
    const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
    for (const cluster of clusters) {
      for (let pad = 0; pad < 14; pad += 1) {
        const text = `${"x".repeat(150 + pad)}${cluster.repeat(10)}`;
        const out = excerpt(text);
        expect(out.length).toBeLessThanOrEqual(160);
        const body = out.endsWith("…") ? out.slice(0, -1) : out;
        // Every grapheme of the result body must be an intact grapheme of the source.
        const graphemes = Array.from(seg.segment(body), (s) => s.segment);
        for (const g of graphemes) expect(g === "x" || g === cluster).toBe(true);
        expect(/[\uD800-\uDBFF]$/.test(body)).toBe(false);
      }
    }
  });

  test("prefers the last word boundary in the second half", () => {
    const text = `${"alpha ".repeat(30)}omega`;
    const out = excerpt(text, 40);
    expect(out.endsWith("alpha…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(40);
  });

  test("an unbroken word is hard-cut on a grapheme boundary", () => {
    const out = excerpt("x".repeat(500));
    expect(out).toBe(`${"x".repeat(159)}…`);
  });

  test("whitespace collapsed; exactly-max text untouched", () => {
    expect(excerpt("  a \n\t b  ")).toBe("a b");
    const exact = "y".repeat(160);
    expect(excerpt(exact)).toBe(exact);
  });

  test("invalid input -> ''", () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol.iterator]) {
      expect(excerpt(bad as unknown as string)).toBe("");
    }
  });

  test("invalid max -> 160", () => {
    const text = "z".repeat(400);
    for (const max of [Number.NaN, 0, 1, -5, 2.5, Number.POSITIVE_INFINITY]) {
      expect(excerpt(text, max).length).toBe(EXCERPT_MAX);
    }
  });

  test("EXCERPT_MAX is 160", () => {
    expect(EXCERPT_MAX).toBe(160);
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 hostile text and wishlist field names (SR3)", () => {
  test("hostile name/description/bullets render as text with every option", () => {
    const evil = make({ name: HOSTILE, description: HOSTILE, slug: "<x>" });
    const { container } = render(<ProductCard product={evil} layout="list" bullets={[HOSTILE]} {...allExtras()} />);
    expect(container.querySelector("script")).toBeNull();
    for (const el of container.querySelectorAll("*")) expect(el.hasAttribute("onerror")).toBe(false);
    for (const img of container.querySelectorAll("img")) expect(img.getAttribute("src")).not.toBe("x");
    expect(screen.getByRole("link").textContent).toBe(HOSTILE);
    expect(screen.getByRole("link").getAttribute("href")).toBe("/products/%3Cx%3E");
  });

  test("wishlist form posts only LIST_FIELD names (no-JS shape)", () => {
    const allowed = new Set<string>(Object.values(LIST_FIELD));
    for (const inList of [false, true]) {
      const action = serverLike<ListActionFn>(async () => null);
      const html = renderToStaticMarkup(
        <ProductCard product={make()} wishlist={{ inList, listId: inList ? "L1" : null, addAction: action, removeAction: action }} />,
      );
      const forms = [...parse(html).querySelectorAll("form")];
      expect(forms).toHaveLength(1);
      expect(forms[0]?.getAttribute("method")?.toLowerCase()).toBe("post");
      const names = [...(forms[0]?.querySelectorAll("[name]") ?? [])]
        .map((el) => el.getAttribute("name") ?? "")
        .filter((n) => !n.startsWith("$ACTION"));
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(allowed.has(n)).toBe(true);
    }
  });

  test("wishlist submit (JS) posts only LIST_FIELD names", async () => {
    const allowed = new Set<string>(Object.values(LIST_FIELD));
    const keys: string[] = [];
    const add: ListActionFn = async (_p, fd) => {
      keys.push(...fd.keys());
      return null;
    };
    const { container } = render(<ProductCard product={make()} wishlist={{ inList: false, addAction: add, removeAction: noopList }} />);
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(allowed.has(k)).toBe(true);
  });

  test("compare control is a GET form to /compare (no POST, no link)", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} compare={{ selected: [] }} />);
    const form = parse(html).querySelector("form");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.getAttribute("action")).toBe("/compare");
  });

  test("every href in a full card passes isAllowedInternalHref", () => {
    const html = renderToStaticMarkup(<ProductCard product={make()} {...allExtras()} />);
    for (const a of parse(html).querySelectorAll("[href]")) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 ProductGrid v2", () => {
  const products = [make({ id: "a", slug: "a", name: "Alpha" }), make({ id: "b", slug: "b", name: "Beta" })];

  test("cardProps cannot replace product (runtime) and className merges with w-full", () => {
    const hijack = { product: make({ id: "evil", slug: "evil", name: "Evil" }), className: "extra-class" } as unknown as ProductGridCardExtras;
    const html = renderToStaticMarkup(<ProductGrid products={products} cardProps={() => hijack} />);
    expect(html).not.toContain("Evil");
    const articles = [...parse(html).querySelectorAll("article")];
    expect(articles).toHaveLength(2);
    for (const a of articles) {
      expect(a.classList.contains("w-full")).toBe(true);
      expect(a.classList.contains("extra-class")).toBe(true);
    }
  });

  test("cardProps receives (product, index) and per-card extras apply", () => {
    const seen: string[] = [];
    const html = renderToStaticMarkup(
      <ProductGrid
        products={products}
        cardProps={(p, i) => {
          seen.push(`${p.id}:${i}`);
          return { badges: i === 0 ? ["deal"] : [] };
        }}
      />,
    );
    expect(seen).toEqual(["a:0", "b:1"]);
    expect((html.match(/Deal/g) ?? []).length).toBe(1);
  });

  test("positionRankCardProps: page 2 of 24 ranks start at #25; invalid page -> 1", () => {
    const html = renderToStaticMarkup(<ProductGrid products={products} cardProps={positionRankCardProps(2, 24)} />);
    expect(html).toContain("#25");
    expect(html).toContain("#26");
    const bad = renderToStaticMarkup(<ProductGrid products={products} cardProps={positionRankCardProps(Number.NaN, 24)} />);
    expect(bad).toContain("#1<");
    expect(bad).toContain("#2<");
  });

  test('layout="list": single column, data-layout on list and cards', () => {
    const doc = parse(renderToStaticMarkup(<ProductGrid products={products} layout="list" />));
    const ul = doc.querySelector("ul");
    expect(ul?.getAttribute("data-layout")).toBe("list");
    expect(ul?.className).toContain("flex-col");
    expect(ul?.className).not.toMatch(/grid-cols/);
    for (const a of doc.querySelectorAll("article")) expect(a.getAttribute("data-layout")).toBe("list");
  });

  test("unknown layout value falls back to the grid", () => {
    const doc = parse(renderToStaticMarkup(<ProductGrid products={products} layout={"table" as unknown as "grid"} />));
    expect(doc.querySelector("ul")?.getAttribute("data-layout")).toBe("grid");
  });

  // T156 (Phase 3): columns are 2 at base (never 1, CONTRACTS L-28), 3 from md, 4 from lg; gaps tightened.
  test('<ul role="list"> of <li class="flex min-w-0">; v3 column classes (2 / md 3 / lg 4, never 1 column)', () => {
    const doc = parse(renderToStaticMarkup(<ProductGrid products={products} />));
    const ul = doc.querySelector("ul");
    expect(ul?.getAttribute("role")).toBe("list");
    for (const cls of ["grid", "min-w-0", "grid-cols-2", "gap-x-2", "gap-y-4", "xs:gap-4", "md:grid-cols-3", "lg:grid-cols-4", "lg:gap-6"]) {
      expect({ cls, has: ul?.classList.contains(cls) }).toEqual({ cls, has: true });
    }
    expect([...(ul?.classList ?? [])].filter((c) => /(^|:)grid-cols-1$/.test(c))).toEqual([]);
    const lis = [...doc.querySelectorAll("ul > li")];
    expect(lis).toHaveLength(2);
    for (const li of lis) expect(li.className).toBe("flex min-w-0");
  });

  test("emptyState slot replaces the default; null/false fall back to the default", () => {
    render(<ProductGrid products={[]} emptyState={<p>Nothing matched your filters</p>} />);
    expect(screen.getByText("Nothing matched your filters")).toBeInTheDocument();
    expect(screen.queryByText("No products yet")).toBeNull();
    for (const slot of [null, false, undefined]) {
      const html = renderToStaticMarkup(<ProductGrid products={[]} emptyState={slot} />);
      expect(html).toContain("No products yet");
      expect(html).not.toContain("<ul");
    }
  });

  test("priority applies to the first priorityCount cards only", () => {
    const many = Array.from({ length: 6 }, (_, i) => make({ id: `p${i}`, slug: `p${i}`, imageUrl: "/images/products/x.jpg" }));
    const doc = parse(renderToStaticMarkup(<ProductGrid products={many} priorityCount={2} />));
    const loading = [...doc.querySelectorAll("img")].map((img) => img.getAttribute("loading") ?? "eager");
    expect(loading.slice(0, 2).every((l) => l !== "lazy")).toBe(true);
    expect(loading.slice(2).every((l) => l === "lazy")).toBe(true);
  });

  test("grid with quick add: no nested forms and one link per li", () => {
    const doc = parse(
      renderToStaticMarkup(
        <ProductGrid products={products} cardProps={() => ({ quickAdd: { action: noopCart }, compare: { selected: [] }, wishlist: { inList: false, addAction: noopList, removeAction: noopList } })} />,
      ),
    );
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
    for (const li of doc.querySelectorAll("ul[role=list] > li")) expect(li.querySelectorAll("a")).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------------------------
describe("T74 source hygiene", () => {
  const files = [
    "molecules/ProductCard/ProductCard.tsx",
    "molecules/ProductCard/QuickAddForm.tsx",
    "molecules/ProductCard/excerpt.ts",
    "organisms/ProductGrid/ProductGrid.tsx",
  ];
  for (const f of files) {
    test(`${f}: no any / ts-ignore / eslint-disable / dangerouslySetInnerHTML / style= / runtime server imports`, () => {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toMatch(/@ts-ignore|@ts-expect-error|eslint-disable/);
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/\sstyle=\{/);
      for (const line of src.split("\n").filter((l) => /from "@\/server\//.test(l))) {
        expect(line).toMatch(/^import type /);
      }
    });
  }

  test("rendered full card: no arbitrary values, palette colours or inline styles", () => {
    const { container } = render(<ProductCard product={make()} layout="list" bullets={["a"]} {...allExtras()} />);
    // next/image's own `style="color:transparent"` on <img> is the only allowed inline style.
    const styled = [...container.querySelectorAll("[style]")].filter((el) => !(el.tagName === "IMG" && /^color:\s*transparent;?$/.test(el.getAttribute("style") ?? "")));
    expect(styled.map((el) => el.tagName)).toEqual([]);
    const classes = [...container.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
    expect(classes.filter((c) => /(^|:)(bg|text|border|ring)-(gray|slate|red|blue|green|yellow|white|black)(-\d+)?$/.test(c))).toEqual([]);
  });

  test("controls in a full card meet the 44px touch target (min-h-touch on buttons)", () => {
    const { container } = render(<ProductCard product={make()} {...allExtras()} />);
    for (const b of container.querySelectorAll("button")) {
      expect(b.className).toMatch(/min-h-touch|h-touch/);
    }
  });

  test("full card in grid within a list: within() finds the product heading at the given level", () => {
    render(<ProductGrid products={[make()]} headingLevel={2} />);
    const item = screen.getByRole("listitem");
    expect(within(item).getByRole("heading", { level: 2 }).textContent).toBe("Canvas Tote Bag");
  });
});

// --------------------------------------------------------------------------------------------
// T156 (Phase 3) promo slots inside the grid list (QA T147 addendum; CONTRACTS L-11, L-13, L-14, L-17)
describe("T156 ProductGrid promoSlots", () => {
  const many = Array.from({ length: 12 }, (_, i) => make({ id: `p_${i}`, slug: `p-${i}`, name: `P ${i}` }));
  const tile = (heading: string, over: Record<string, unknown> = {}) => ({ heading, cta: { label: "Shop", href: "/deals" }, ...over });
  const slots = [
    { afterIndex: 2, tile: tile("A") },
    { afterIndex: 5, tile: tile("B") },
    { afterIndex: 7, tile: tile("C") },
    { afterIndex: 9, tile: tile("D") },
  ];
  const promoLis = (doc: Document) => [...doc.querySelectorAll("ul > li")].filter((li) => li.querySelector("article") === null);

  test("page 1: promo tiles are <li> children of the same list, max 3, at the requested positions", () => {
    const doc = parse(renderToStaticMarkup(<ProductGrid products={many} promoSlots={slots} />));
    const lis = [...doc.querySelectorAll("ul > li")];
    expect(lis).toHaveLength(12 + 3);
    expect(promoLis(doc).map((li) => li.querySelector("h3")?.textContent)).toEqual(["A", "B", "C"]);
    expect(lis.indexOf(promoLis(doc)[0]!)).toBe(3);
    expect(doc.querySelectorAll("ul").length).toBe(1);
  });

  test("page 2+ and list layout: no promo tiles", () => {
    for (const el of [
      <ProductGrid key="a" products={many} promoSlots={slots} page={2} />,
      <ProductGrid key="b" products={many} promoSlots={slots} layout="list" />,
    ]) {
      expect(promoLis(parse(renderToStaticMarkup(el)))).toHaveLength(0);
    }
  });

  test("promo heading levels are clamped to >= 3 (never h1/h2 inside the grid); one link each, allow-listed", () => {
    const doc = parse(
      renderToStaticMarkup(
        <ProductGrid products={many} promoSlots={[{ afterIndex: 2, tile: tile("Lvl", { headingLevel: 2 }) }, { afterIndex: 4, tile: tile("Four", { headingLevel: 4 }) }]} />,
      ),
    );
    expect(doc.querySelectorAll("h1, h2").length).toBe(0);
    expect(doc.querySelector("h4")?.textContent).toBe("Four");
    for (const li of promoLis(doc)) {
      const links = [...li.querySelectorAll("a")];
      expect(links).toHaveLength(1);
      expect(isAllowedInternalHref(links[0]?.getAttribute("href") ?? "")).toBe(true);
    }
  });

  test("blank heading, bad index, duplicate index and last position on a partial page are skipped", () => {
    const doc = parse(
      renderToStaticMarkup(
        <ProductGrid
          products={many}
          pageSize={24}
          promoSlots={[
            { afterIndex: 1, tile: tile("   ") },
            { afterIndex: -1, tile: tile("Neg") },
            { afterIndex: 1.5, tile: tile("Frac") },
            { afterIndex: 3, tile: tile("Ok") },
            { afterIndex: 3, tile: tile("Dup") },
            { afterIndex: 11, tile: tile("Last") },
          ]}
        />,
      ),
    );
    expect(promoLis(doc).map((li) => li.querySelector("h3")?.textContent)).toEqual(["Ok"]);
    const lis = [...doc.querySelectorAll("ul > li")];
    expect(lis[lis.length - 1]?.querySelector("article") === null ? "promo last" : "product last").toBe("product last");
  });
});
