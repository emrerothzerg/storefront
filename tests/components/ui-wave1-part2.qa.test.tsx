/**
 * T182 — QA of UI wave 1 part 2 (fixes for UI-REVIEW-2026-11-09 findings U07,
 * U13, U14, U17, U06 legends, U18 summaries) at component level. QA-owned.
 *
 * Page-level checks (listing toolbar on a real category page, PDP title and
 * coupon line, checkout form structure + no-JS POST, cart / confirmation /
 * order detail totals, home vs department art) live in
 * `tests/app/phase3-pages/ui-wave1-part2-pages.qa.test.tsx`.
 *
 * Markup checks run on `renderToStaticMarkup` output (the no-JS view) parsed
 * with DOMParser; hydrated checks use @testing-library. DOM nodes never go
 * into `expect` (src/test/dom-assertions.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { expectFocused, expectNotNull } from "@/test/dom-assertions";

import { SortSelect } from "@/components/molecules/SortSelect";
import { ProductCard } from "@/components/molecules/ProductCard";
import { WishlistButton } from "@/components/molecules/WishlistButton";
import { AddressFields } from "@/components/molecules/AddressFields";
import { PaymentFields } from "@/components/molecules/PaymentFields";
import { OrderSummary } from "@/components/organisms/OrderSummary";
import { CategoryRail } from "@/components/organisms/CategoryGrid";
import { CategoryDiscovery } from "@/components/organisms/CategoryDiscovery";
import {
  DEPARTMENT_TILE_ART,
  DISCOVERY_TILE_ART,
  FALLBACK_TILE_ART,
  getCategoryTileArt,
} from "@/content/home-art";
import { formatMoney } from "@/lib/money";
import type { Product } from "@/lib/types";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import { countClockReads, spokenText } from "../app/phase3-pages/_phase3";

const ROOT = join(import.meta.dir, "..", "..");
const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, "text/html");
}

function cls(el: Element | null | undefined): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** What a sighted user reads: textContent minus `.sr-only` subtrees, whitespace kept as is. */
function visibleText(el: Element | null | undefined): string {
  if (el === null || el === undefined) return "";
  const clone = el.cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll(".sr-only")) hidden.remove();
  return clone.textContent ?? "";
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p-qa",
    slug: "gooseneck-pour-over-kettle",
    name: "Gooseneck Pour-Over Kettle",
    description: "A kettle.",
    priceCents: 7900,
    listPriceCents: 9900,
    currency: "USD",
    imageUrl: "/images/kettle.jpg",
    stock: 10,
    ...overrides,
  };
}

/** rem value of a `--token: Nrem;` declaration in globals.css. */
function remToken(name: string): number {
  const m = new RegExp(`${name.replace(/[-]/g, "\\-")}:\\s*([\\d.]+)rem;`).exec(css);
  if (m === null) throw new Error(`token ${name} not found`);
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// U07 — SortSelect compact below md
// ---------------------------------------------------------------------------

describe("U07 SortSelect: compact below md, still a labelled no-JS GET form", () => {
  const html = renderToStaticMarkup(<SortSelect value="featured" base="/category/electronics" params={{ brand: ["a"] }} />);
  const doc = parse(html);
  const form = doc.querySelector("form");
  const select = doc.querySelector('select[name="sort"]');
  const label = select !== null ? doc.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;

  test("server HTML is a real GET form to the listing path with a visible Apply submit", () => {
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.getAttribute("action")).toBe("/category/electronics");
    const apply = [...(form?.querySelectorAll('button[type="submit"]') ?? [])].map((b) => [b.textContent, cls(b).includes("sr-only")]);
    expect(apply).toEqual([["Apply", false]]);
  });

  test("the select's accessible name is still exactly 'Sort by' (label[for] association, text kept for AT)", () => {
    expectNotNull(label);
    expect(spokenText(label)).toBe("Sort by");
    const text = label?.querySelector('[data-slot="sort-label-text"]');
    expect(cls(text)).toEqual(expect.arrayContaining(["sr-only", "md:not-sr-only"]));
    // The icon in the label is decorative.
    expect(label?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  test("select box: w-28 below sm, w-40 from sm, auto from md; min-w-0; the select fills it (w-full)", () => {
    const box = doc.querySelector('[data-slot="sort-select-box"]');
    expect(cls(box)).toEqual(expect.arrayContaining(["w-28", "min-w-0", "sm:w-40", "md:w-auto"]));
    expect(cls(select)).toContain("w-full");
    // 28 * 0.25rem = 7rem = 112px: below the 160px fixed-width audit threshold (audit FIXED_WIDTH skips < 40 units).
    expect(28 * remToken("--spacing")).toBe(7);
  });

  test("hydrated: Apply turns sr-only but reappears on focus; keyboard Tab order is select -> Apply", () => {
    render(<SortSelect value="featured" base="/products" params={{}} />);
    const combo = screen.getByRole("combobox", { name: "Sort by" });
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply.className).toContain("sr-only");
    expect(apply.className).toContain("focus:not-sr-only");
    combo.focus();
    expectFocused(combo);
    // DOM order = tab order (no positive tabindex anywhere).
    expect((combo.compareDocumentPosition(apply) & 4) !== 0).toBe(true);
    expect(document.querySelectorAll('[tabindex]:not([tabindex="-1"]):not([tabindex="0"])').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// U14 — ProductCard title reserves two lines in grid mode
// ---------------------------------------------------------------------------

describe("U14 ProductCard title: line-clamp-2 + two-line min height (grid), list unchanged", () => {
  function title(props: Parameters<typeof ProductCard>[0]): Element | null {
    return parse(renderToStaticMarkup(<ProductCard {...props} />)).querySelector("article h3");
  }

  test("token math: min-h-12 = 2 x text-body line-height; min-h-10 = 2 x text-small line-height", () => {
    const spacing = remToken("--spacing");
    expect(12 * spacing).toBe(2 * remToken("--text-body--line-height"));
    expect(10 * spacing).toBe(2 * remToken("--text-small--line-height"));
  });

  test("grid default: text-body + line-clamp-2 + min-h-12", () => {
    const t = title({ product: product() });
    expect(cls(t)).toEqual(expect.arrayContaining(["text-body", "line-clamp-2", "min-h-12"]));
    expect(cls(t)).not.toContain("line-clamp-3");
  });

  test("grid compact: text-small + line-clamp-2 + min-h-10 (compact ignores layout=list)", () => {
    for (const layout of ["grid", "list"] as const) {
      const t = title({ product: product(), variant: "compact", layout });
      expect([layout, cls(t).filter((c) => /^(text-(small|body)|line-clamp-\d|min-h-\d+)$/.test(c)).sort()]).toEqual([
        layout,
        ["line-clamp-2", "min-h-10", "text-small"],
      ]);
    }
  });

  test("list mode: unchanged line-clamp-3, no reserved min height", () => {
    const t = title({ product: product(), layout: "list" });
    expect(cls(t)).toContain("line-clamp-3");
    expect(cls(t).filter((c) => c.startsWith("min-h-") || c === "line-clamp-2")).toEqual([]);
  });

  test("a one-word title still reserves two lines; a 300-char title is clamped (text kept for AT)", () => {
    expect(cls(title({ product: product({ name: "Mug" }) }))).toContain("min-h-12");
    const long = "Kettle ".repeat(43).trim();
    const t = title({ product: product({ name: long }) });
    expect(t?.textContent).toBe(long);
    expect(cls(t)).toContain("line-clamp-2");
  });

  test("no clock reads when rendering cards without `now` (grid, compact, list)", async () => {
    const { reads, stacks } = await countClockReads(async () =>
      renderToStaticMarkup(
        <>
          <ProductCard product={product()} />
          <ProductCard product={product()} variant="compact" />
          <ProductCard product={product()} layout="list" />
        </>,
      ),
    );
    if (reads !== 0) console.info(stacks.join("\n"));
    expect(reads).toBe(0);
  });

  test("cards keep the superscript price style", () => {
    const doc = parse(renderToStaticMarkup(<ProductCard product={product()} />));
    expectNotNull(doc.querySelector('[data-slot="price-superscript"]'));
  });
});

// ---------------------------------------------------------------------------
// U13 — one art per category wherever it is listed
// ---------------------------------------------------------------------------

describe("U13 category art: CategoryRail and CategoryDiscovery use the same per-slug art", () => {
  const LEAVES = [
    { slug: "kettles", name: "Kettles" },
    { slug: "headphones", name: "Headphones" },
    { slug: "notebooks", name: "Notebooks" },
    { slug: "yoga-mats", name: "Yoga mats" },
  ];

  function artBySlug(html: string): Map<string, { src: string; alt: string | null }> {
    const out = new Map<string, { src: string; alt: string | null }>();
    for (const a of parse(html).querySelectorAll('a[href^="/category/"]')) {
      const slug = decodeURIComponent((a.getAttribute("href") ?? "").slice("/category/".length));
      const img = a.querySelector("img");
      out.set(slug, { src: img?.getAttribute("src") ?? "", alt: img?.getAttribute("alt") ?? null });
    }
    return out;
  }

  test("a leaf gets identical art in the department rail and the home discovery rail, in any order", () => {
    const rail = artBySlug(renderToStaticMarkup(<CategoryRail categories={LEAVES} title="Shop Home" />));
    const disc = artBySlug(renderToStaticMarkup(<CategoryDiscovery categories={[...LEAVES].reverse()} />));
    for (const { slug } of LEAVES) {
      const expected = getCategoryTileArt(slug).path;
      expect([slug, rail.get(slug)?.src.includes(expected), disc.get(slug)?.src.includes(expected)]).toEqual([slug, true, true]);
    }
  });

  test("leaves get a discovery pattern, never the fallback bag; departments keep their own art", () => {
    for (const { slug } of LEAVES) {
      const art = getCategoryTileArt(slug);
      expect([slug, DISCOVERY_TILE_ART.includes(art)]).toEqual([slug, true]);
    }
    for (const [slug, art] of Object.entries(DEPARTMENT_TILE_ART)) expect([slug, getCategoryTileArt(slug) === art]).toEqual([slug, true]);
    const rail = artBySlug(renderToStaticMarkup(<CategoryRail categories={[{ slug: "electronics", name: "Electronics" }]} />));
    expect(rail.get("electronics")?.src.includes(DEPARTMENT_TILE_ART.electronics?.path ?? "?")).toBe(true);
  });

  test("blank / whitespace / non-string / prototype-key slugs -> fallback; the getter never throws", () => {
    for (const slug of ["", "   ", undefined, null, 42, "__proto__", "constructor", "toString"] as unknown[]) {
      const art = getCategoryTileArt(slug as string);
      const expectFallback = typeof slug !== "string" || slug.trim() === "";
      if (expectFallback) expect([String(slug), art === FALLBACK_TILE_ART]).toEqual([String(slug), true]);
      else expect([String(slug), DISCOVERY_TILE_ART.includes(art)]).toEqual([String(slug), true]);
    }
    // Trimmed slug = same art.
    expect(getCategoryTileArt("  kettles ") === getCategoryTileArt("kettles")).toBe(true);
  });

  test("decorative art: every tile image has alt=\"\" and the link is named by the caption", () => {
    for (const html of [
      renderToStaticMarkup(<CategoryRail categories={LEAVES} />),
      renderToStaticMarkup(<CategoryDiscovery categories={LEAVES} />),
    ]) {
      const doc = parse(html);
      const imgs = [...doc.querySelectorAll("img")];
      expect(imgs.length).toBe(LEAVES.length);
      expect(imgs.map((i) => i.getAttribute("alt"))).toEqual(LEAVES.map(() => ""));
      const names = [...doc.querySelectorAll('a[href^="/category/"]')].map((a) => spokenText(a));
      expect(names.sort()).toEqual(LEAVES.map((l) => l.name).sort());
    }
  });
});

// ---------------------------------------------------------------------------
// U17 — wishlist button label
// ---------------------------------------------------------------------------

describe("U17 WishlistButton (button variant): single-spaced visible label, product name in the accessible name", () => {
  const noop: ListActionFn = async () => null;

  function button(inList: boolean, productName = "Gooseneck Pour-Over Kettle"): Element | null {
    const html = renderToStaticMarkup(
      <WishlistButton
        productId="p1"
        productSlug="kettle"
        productName={productName}
        inList={inList}
        listId={inList ? "l1" : null}
        addAction={noop}
        removeAction={noop}
        variant="button"
        fullWidth
      />,
    );
    return parse(html).querySelector('button[type="submit"]');
  }

  test.each([
    [false, "Add to Wish List", "Add Gooseneck Pour-Over Kettle to Wish List"],
    [true, "Remove from Wish List", "Remove Gooseneck Pour-Over Kettle from Wish List"],
  ])("inList=%p: visible %p, accessible %p", (inList, visible, accessible) => {
    const b = button(inList);
    expectNotNull(b);
    expect(visibleText(b).trim()).toBe(visible);
    expect(visibleText(b)).not.toMatch(/\s{2,}/);
    expect(spokenText(b)).toBe(accessible);
    // No aria-label overriding the content (so visible text is a prefix-compatible part of the name; WCAG 2.5.3 label-in-name).
    expect(b?.hasAttribute("aria-label")).toBe(false);
    expect(b?.getAttribute("aria-pressed")).toBe(String(inList));
  });

  test("label-in-name (WCAG 2.5.3): every visible word appears in the accessible name in order", () => {
    for (const inList of [false, true]) {
      const b = button(inList);
      const words = visibleText(b).trim().split(/\s+/);
      const name = spokenText(b) ?? "";
      let at = 0;
      for (const w of words) {
        const i = name.indexOf(w, at);
        expect([w, i >= 0]).toEqual([w, true]);
        at = i + w.length;
      }
    }
  });

  test("blank and hostile names: 'this item' fallback; markup is text, never HTML", () => {
    expect(spokenText(button(false, "   "))).toBe("Add this item to Wish List");
    const b = button(false, "<img src=x onerror=alert(1)>");
    expect(b?.querySelector("img")).toBeFalsy();
    expect(spokenText(b)).toBe("Add <img src=x onerror=alert(1)> to Wish List");
    expect(visibleText(b).trim()).toBe("Add to Wish List");
  });

  test("hydrated: the button is reachable by role with the full name in both states", () => {
    const { unmount } = render(
      <WishlistButton productId="p1" productSlug="k" productName="Kettle" inList={false} addAction={noop} removeAction={noop} variant="button" />,
    );
    const b = screen.getByRole("button", { name: "Add Kettle to Wish List" });
    b.focus();
    expectFocused(b);
    unmount();
    render(
      <WishlistButton productId="p1" productSlug="k" productName="Kettle" inList listId="l1" addAction={noop} removeAction={noop} variant="button" />,
    );
    expectNotNull(screen.getByRole("button", { name: "Remove Kettle from Wish List" }));
  });
});

// ---------------------------------------------------------------------------
// U06 — hidden legends still name their fieldsets
// ---------------------------------------------------------------------------

describe("U06 AddressFields / PaymentFields hideLegend", () => {
  test("hideLegend: the legend stays the fieldset's first child, sr-only, with its text", () => {
    for (const [name, html, text] of [
      ["address", renderToStaticMarkup(<AddressFields hideLegend />), "Shipping address"],
      ["payment", renderToStaticMarkup(<PaymentFields hideLegend />), "Payment"],
    ] as const) {
      const fs = parse(html).querySelector("fieldset");
      const legend = fs?.firstElementChild;
      expect([name, legend?.tagName, legend?.textContent, cls(legend).includes("sr-only")]).toEqual([name, "LEGEND", text, true]);
    }
  });

  test("default (no hideLegend): legend visible (no sr-only)", () => {
    for (const html of [renderToStaticMarkup(<AddressFields legend="New shipping address" />), renderToStaticMarkup(<PaymentFields />)]) {
      const legend = parse(html).querySelector("fieldset > legend");
      expectNotNull(legend);
      expect(cls(legend)).not.toContain("sr-only");
    }
  });

  test("hydrated: the fieldset is a group named by the hidden legend", () => {
    render(
      <>
        <AddressFields hideLegend idPrefix="qa-a" />
        <PaymentFields hideLegend idPrefix="qa-p" />
      </>,
    );
    expectNotNull(screen.getByRole("group", { name: "Shipping address" }));
    expectNotNull(screen.getByRole("group", { name: "Payment" }));
  });
});

// ---------------------------------------------------------------------------
// U18 — OrderSummary: one plain money format
// ---------------------------------------------------------------------------

describe("U18 OrderSummary: every amount is plain text ($79.00), visible = spoken", () => {
  const html = renderToStaticMarkup(
    <OrderSummary
      items={[{ productId: "p1", name: "Kettle", quantity: 1, unitPriceCents: 7900 }]}
      subtotalCents={7900}
      shippingCents={0}
      discountCents={0}
      totalCents={7900}
      currency="USD"
    />,
  );
  const doc = parse(html);

  test("no superscript split anywhere in the summary", () => {
    expect(doc.querySelectorAll('[data-slot="price-superscript"]').length).toBe(0);
  });

  test("Total and Subtotal read '$79.00' visibly and when spoken", () => {
    for (const label of ["Subtotal", "Total"]) {
      const dt = [...doc.querySelectorAll("dt")].find((d) => (spokenText(d) ?? "").startsWith(label));
      const dd = dt?.nextElementSibling ?? null;
      expect([label, spokenText(dd), visibleText(dd).replace(/\s+/g, " ").trim()]).toEqual([label, formatMoney(7900, "USD"), formatMoney(7900, "USD")]);
    }
  });

  test("whole-dollar and large amounts keep cents ($1,234.00)", () => {
    const d = parse(
      renderToStaticMarkup(
        <OrderSummary items={[]} subtotalCents={123400} shippingCents={0} totalCents={123400} currency="USD" />,
      ),
    );
    const total = [...d.querySelectorAll("dt")].find((x) => (spokenText(x) ?? "") === "Total")?.nextElementSibling ?? null;
    expect(visibleText(total).trim()).toBe("$1,234.00");
  });
});

// Keyboard sanity: no positive tabindex in any rendered fixture.
test("no positive tabindex in any static fixture", () => {
  const all = [
    renderToStaticMarkup(<SortSelect value="featured" base="/products" params={{}} />),
    renderToStaticMarkup(<ProductCard product={product()} />),
    renderToStaticMarkup(<AddressFields hideLegend />),
    renderToStaticMarkup(<PaymentFields hideLegend />),
  ].join("");
  const doc = parse(all);
  const positive = [...doc.querySelectorAll("[tabindex]")].filter((el) => Number(el.getAttribute("tabindex")) > 0);
  expect(positive.length).toBe(0);
});
