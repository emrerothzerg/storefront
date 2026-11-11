// QA (QA-W4-organisms-B / T90): T75 ProductRail + FrequentlyBoughtTogether.
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ADD_MANY_MAX_ITEMS,
  type CartActionFnV2,
  type CartActionStateV2,
  type CartPerItemResult,
} from "@/components/molecules/_contracts/cart-actions";
import {
  FBT_HEADING,
  FBT_SUBMIT_LABEL,
  FrequentlyBoughtTogether,
  bundleItems,
  describePerItem,
  totalCentsOf,
} from "@/components/organisms/FrequentlyBoughtTogether";
import { ProductRail, productRailHref, railLabel } from "@/components/organisms/ProductRail";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney, sumCents } from "@/lib/money";
import type { Product } from "@/lib/types";
import type { Bundle } from "@/server/recommendations/recommendation-service";
import { expectFocused } from "@/test/dom-assertions";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "quoted" 'single' ‮evil`;
const ROOT = join(import.meta.dir, "../../../src/components/organisms");

function product(n: number, over: Partial<Product> = {}): Product {
  return {
    id: `qa-p${n}`,
    slug: `qa-product-${n}`,
    name: `QA Product ${n}`,
    description: "",
    priceCents: 2000 + n,
    currency: "USD",
    imageUrl: `/images/qa-${n}.jpg`,
    stock: 5,
    ...over,
  };
}

let warn: ReturnType<typeof spyOn> | null = null;
function silenceWarn(): ReturnType<typeof spyOn> {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  return warn;
}
afterEach(() => {
  warn?.mockRestore();
  warn = null;
});

function hrefsOf(root: ParentNode): string[] {
  return [...root.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
}

// ---------------------------------------------------------------------------
// ProductRail
// ---------------------------------------------------------------------------

describe("T75.1 ProductRail renders nothing when empty", () => {
  test("[] -> null in DOM and static markup (no empty heading)", () => {
    const { container } = render(<ProductRail title="Rail" products={[]} />);
    expect(container.innerHTML).toBe("");
    expect(renderToStaticMarkup(<ProductRail title="Rail" products={[]} />)).toBe("");
  });

  test("every product dropped (throwing hrefForProduct) -> null, with a dev warning", () => {
    const w = silenceWarn();
    const html = renderToStaticMarkup(
      <ProductRail
        title="Rail"
        products={[product(1), product(2)]}
        hrefForProduct={() => {
          throw new Error("boom");
        }}
      />,
    );
    expect(html).toBe("");
    expect(w).toHaveBeenCalledTimes(2);
  });
});

describe("T75.1 heading level prop, one link per card", () => {
  test("headingLevel 2 (default) and 3", () => {
    const { rerender } = render(<ProductRail title="Best sellers" products={[product(1)]} />);
    expect(screen.getByRole("heading", { level: 2, name: "Best sellers" })).toBeInTheDocument();
    rerender(<ProductRail title="Best sellers" products={[product(1)]} headingLevel={3} />);
    expect(screen.getByRole("heading", { level: 3, name: "Best sellers" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });

  // T163 pin move (T153/T137): compact v3 cards have ONE link (image + title); rating and the strike
  // price are siblings of that link inside the card; with `quickAdd` a sibling form posts
  // productId + quantity=1. Without `quickAdd` there is still no other interactive element.
  test("each list item contains exactly ONE link and no other interactive element", () => {
    const products = [1, 2, 3, 4].map((n) => product(n, { ratingCount: 3, ratingAvg: 4.5, listPriceCents: 9999 }));
    const { container } = render(<ProductRail title="Rail" products={products} />);
    const region = screen.getByRole("region", { name: railLabel("Rail") });
    const items = region.querySelectorAll(":scope > ul > li");
    expect(items).toHaveLength(4);
    for (const li of items) {
      expect(li.querySelectorAll("a")).toHaveLength(1);
      expect(li.querySelectorAll("button, input, select, textarea, form, [tabindex]")).toHaveLength(0);
      const a = li.querySelector("a") as HTMLAnchorElement;
      expect(a.querySelector("img")).not.toBeNull();
      expect(a.textContent).toContain("QA Product");
      // Rating and strike price are present in the card but outside the link.
      expect(li.querySelector("[data-testid=rating-stars]")).not.toBeNull();
      expect(a.querySelector("[data-testid=rating-stars]")).toBeNull();
      expect(li.querySelector("s")).not.toBeNull();
      expect(a.querySelector("s")).toBeNull();
    }
    expect(container.querySelectorAll("a a, a form, form a")).toHaveLength(0);
  });

  test("with quickAdd: one link + one sibling form per card posting productId + quantity=1", () => {
    const products = [1, 2, 3].map((n) => product(n, { ratingCount: 3, ratingAvg: 4.5, listPriceCents: 9999 }));
    const action = async () => null;
    const { container } = render(<ProductRail title="Rail" products={products} quickAdd={{ action }} />);
    const region = screen.getByRole("region", { name: railLabel("Rail") });
    const items = region.querySelectorAll(":scope > ul > li");
    expect(items).toHaveLength(3);
    items.forEach((li, i) => {
      expect(li.querySelectorAll("a")).toHaveLength(1);
      const forms = li.querySelectorAll("form");
      expect(forms).toHaveLength(1);
      const form = forms[0] as HTMLFormElement;
      expect(form.closest("a")).toBeNull();
      expect(form.querySelector('input[name="productId"]')?.getAttribute("value")).toBe(`qa-p${i + 1}`);
      expect(form.querySelector('input[name="quantity"]')?.getAttribute("value")).toBe("1");
      expect(within(form).getByRole("button", { name: `Add to cart: QA Product ${i + 1}` })).toBeInTheDocument();
    });
    expect(container.querySelectorAll("a a, a form, form a")).toHaveLength(0);
  });

  test("card link accessible name contains the product name", () => {
    render(<ProductRail title="Rail" products={[product(7)]} />);
    expect(screen.getByRole("link", { name: /QA Product 7/ })).toHaveAttribute("href", "/products/qa-product-7");
  });
});

describe("T75.2 works without JS as a native scrolling list", () => {
  test("static markup: named focusable region with overflow-x-auto holding a <ul> of <li> cards", () => {
    const html = renderToStaticMarkup(<ProductRail title="Rail" products={[product(1), product(2)]} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const region = doc.querySelector('[role="region"][aria-label="Rail, product list"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("tabindex")).toBe("0");
    expect(region?.className).toContain("overflow-x-auto");
    expect(region?.querySelectorAll("ul > li")).toHaveLength(2);
    expect(html).not.toContain("use client");
  });

  test("no `use client` directive in ProductRail.tsx (server component)", () => {
    const src = readFileSync(join(ROOT, "ProductRail/ProductRail.tsx"), "utf8");
    expect(src.trimStart().startsWith('"use client"')).toBe(false);
    expect(src).not.toMatch(/^\s*['"]use client['"]/m);
  });

  test("card images load lazily (rails are below the fold)", () => {
    const html = renderToStaticMarkup(<ProductRail title="Rail" products={[product(1), product(2)]} />);
    const imgs = html.match(/<img[^>]*>/g) ?? [];
    expect(imgs).toHaveLength(2);
    for (const img of imgs) expect(img).toContain('loading="lazy"');
  });
});

describe("T75.5 unique aria-labelledby and distinct region names", () => {
  test("two rails on one page: distinct heading ids, each section labelled by its own heading", () => {
    const { container } = render(
      <main>
        <ProductRail title="Customers also viewed" products={[product(1)]} />
        <ProductRail title="Customers also viewed" products={[product(2)]} />
      </main>,
    );
    const sections = [...container.querySelectorAll("section")];
    expect(sections).toHaveLength(2);
    const ids = sections.map((s) => s.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(2);
    for (const [i, s] of sections.entries()) {
      const target = container.querySelector(`[id="${ids[i] ?? ""}"]`);
      expect(target).not.toBeNull();
      expect(s.contains(target)).toBe(true);
    }
    const allIds = [...container.querySelectorAll("[id]")].map((el) => el.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  test("scroller region name is '<title>, product list' and differs from the section name", () => {
    render(<ProductRail title="Inspired by your browsing" products={[product(1)]} />);
    const section = screen.getByRole("region", { name: "Inspired by your browsing" });
    const scroller = screen.getByRole("region", { name: "Inspired by your browsing, product list" });
    expect(section).not.toBe(scroller);
    expect(section.contains(scroller)).toBe(true);
    expect(railLabel("X")).toBe("X, product list");
  });
});

describe("ProductRail: href safety, dedupe, rating and price rules", () => {
  test("invalid hrefs drop just that card with a dev warning; every rendered href is allowed", () => {
    const w = silenceWarn();
    const bad = ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "/admin", "/products/", "products/x", ""];
    const products = [product(0), ...bad.map((_, i) => product(i + 1))];
    const hrefFor = (p: Product) => (p.id === "qa-p0" ? productRailHref(p) : (bad[Number(p.id.slice(4)) - 1] ?? ""));
    const { container } = render(<ProductRail title="Rail" products={products} hrefForProduct={hrefFor} />);
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(w).toHaveBeenCalledTimes(bad.length);
    for (const href of hrefsOf(container)) expect(isAllowedInternalHref(href)).toBe(true);
  });

  test("hostile slugs are encoded or dropped, never produce an unsafe href", () => {
    silenceWarn();
    const slugs = ["../../admin", "a/b", "%2e%2e", "javascript:alert(1)", "x y", "ok-slug"];
    const products = slugs.map((slug, i) => product(i, { slug }));
    const { container } = render(<ProductRail title="Rail" products={products} />);
    const hrefs = hrefsOf(container);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(isAllowedInternalHref(href)).toBe(true);
    expect(hrefs).toContain("/products/ok-slug");
  });

  test("throwing hrefForProduct for one product drops only that card (no crash) and warns", () => {
    const w = silenceWarn();
    const { container } = render(
      <ProductRail
        title="Rail"
        products={[product(1), product(2)]}
        hrefForProduct={(p) => {
          if (p.id === "qa-p1") throw new Error("nope");
          return productRailHref(p);
        }}
      />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(1);
    expect(hrefsOf(container)).toEqual(["/products/qa-product-2"]);
    expect(w).toHaveBeenCalledTimes(1);
  });

  test("duplicate ids render once (first wins)", () => {
    const { container } = render(
      <ProductRail title="Rail" products={[product(1), product(1, { name: "Dup" }), product(2), product(1)]} />,
    );
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(screen.queryByText("Dup")).toBeNull();
  });

  test("rating only when ratingCount > 0 (0, undefined, NaN, negative hide it)", () => {
    const cases: Array<[Partial<Product>, boolean]> = [
      [{ ratingCount: 2, ratingAvg: 4 }, true],
      [{ ratingCount: 0, ratingAvg: 4 }, false],
      [{}, false],
      [{ ratingCount: Number.NaN, ratingAvg: 4 }, false],
      [{ ratingCount: -3, ratingAvg: 4 }, false],
    ];
    for (const [over, shown] of cases) {
      const { container, unmount } = render(<ProductRail title="Rail" products={[product(1, over)]} />);
      expect(container.querySelector("[data-testid=rating-stars]") !== null).toBe(shown);
      unmount();
    }
  });

  test("strike-through list price only when listPrice > price", () => {
    const cases: Array<[number | null | undefined, boolean]> = [
      [3000, true],
      [2001, false], // equal to price (2000 + 1)
      [1500, false],
      [null, false],
      [undefined, false],
    ];
    for (const [listPriceCents, shown] of cases) {
      const { container, unmount } = render(
        <ProductRail title="Rail" products={[product(1, { listPriceCents })]} />,
      );
      expect(container.querySelector("s") !== null).toBe(shown);
      unmount();
    }
  });

  test("hostile product name and title render as text only", () => {
    const { container } = render(
      <ProductRail title={HOSTILE} products={[product(1, { name: HOSTILE })]} seeAllHref="/best-sellers" />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(HOSTILE);
    const html = renderToStaticMarkup(<ProductRail title={HOSTILE} products={[product(1, { name: HOSTILE })]} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  test("seeAllHref: allowed -> one extra link with a unique accessible name; disallowed -> omitted with warning", () => {
    render(<ProductRail title="Deals" products={[product(1)]} seeAllHref="/deals" />);
    expect(screen.getByRole("link", { name: "See all Deals" })).toHaveAttribute("href", "/deals");
    const w = silenceWarn();
    const { container } = render(<ProductRail title="X" products={[product(1)]} seeAllHref="https://evil.example" />);
    expect(within(container).queryByRole("link", { name: /See all/ })).toBeNull();
    expect(w).toHaveBeenCalled();
  });

  test("320px: no arbitrary or fixed widths in ProductRail source; root is min-w-0", () => {
    const src = readFileSync(join(ROOT, "ProductRail/ProductRail.tsx"), "utf8");
    expect(src).not.toMatch(/\bw-\[|\bmin-w-\[|\bstyle=/);
    const fixed = (src.match(/\b(?:min-)?w-(?:\d+|screen)\b/g) ?? []).filter((c) => c !== "min-w-0");
    expect(fixed).toEqual([]);
    const html = renderToStaticMarkup(<ProductRail title="Rail" products={[product(1)]} />);
    expect(html).toMatch(/<section[^>]*class="[^"]*min-w-0/);
  });
});

// ---------------------------------------------------------------------------
// FrequentlyBoughtTogether
// ---------------------------------------------------------------------------

const A = product(1, { name: "Alpha", priceCents: 1999 });
const B = product(2, { name: "Bravo", priceCents: 1 });
const C = product(3, { name: "Charlie", priceCents: 123457 });
const bundle3: Bundle = { items: [A, B, C], totalCents: 125457 };
const noop: CartActionFnV2 = async () => null;

function boxes(container: HTMLElement): HTMLInputElement[] {
  return [...container.querySelectorAll('input[type="checkbox"]')] as HTMLInputElement[];
}
function form(container: HTMLElement): HTMLFormElement {
  return container.querySelector("form") as HTMLFormElement;
}
function totalLine(container: HTMLElement): string {
  const p = [...container.querySelectorAll("p[aria-live]")].find((el) =>
    /Total|Select at least|unavailable/.test(el.textContent ?? ""),
  );
  return p?.textContent ?? "";
}
function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Add selected to cart|Adding/ }) as HTMLButtonElement;
}
function success(perItem: CartPerItemResult[], message = "Cart updated."): CartActionStateV2 {
  return { ok: true, value: { itemCount: 3, subtotalCents: 1, message, kind: "added_many", perItem } };
}

describe("T75.3 FBT static markup (no JS)", () => {
  test("one form, all boxes checked and enabled, total equals bundle.totalCents and exact sumCents", () => {
    const html = renderToStaticMarkup(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    expect((html.match(/<form\b/g) ?? []).length).toBe(1);
    const inputs = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(3);
    for (const i of inputs) {
      expect(i).toContain("checked");
      expect(i).not.toMatch(/\sdisabled(=|\s|\/|>)/);
    }
    const exact = sumCents([1999, 1, 123457]);
    expect(exact.ok && exact.value).toBe(125457);
    expect(bundle3.totalCents).toBe(125457);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const line = [...doc.querySelectorAll("p")].map((p) => p.textContent ?? "").find((t) => t.startsWith("Total"));
    expect(line).toBe(`Total for 3 items: ${formatMoney(125457, "USD")}`);
    expect(line).toContain("$1,254.57");
  });

  test("static markup posts nothing but productId fields (never a price or total)", () => {
    const html = renderToStaticMarkup(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const names = [...html.matchAll(/\sname="([^"]*)"/g)].map((m) => m[1] ?? "").filter((n) => !n.startsWith("$ACTION"));
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n).toBe("productId");
    expect(html).not.toMatch(/name="(price|priceCents|total|totalCents|sessionId|quantity)"/);
  });

  test("heading and section labelled by it", () => {
    render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} headingLevel={3} />);
    const region = screen.getByRole("region", { name: FBT_HEADING });
    expect(within(region).getByRole("heading", { level: 3, name: FBT_HEADING })).toBeInTheDocument();
  });
});

describe("T75.3 FBT with JS: unchecking, posting, at-least-one", () => {
  test("unchecking recomputes the exact integer total, re-checking restores it", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const [, b, c] = boxes(container) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    fireEvent.click(b);
    expect(totalLine(container)).toBe(`Total for 2 items: ${formatMoney(1999 + 123457, "USD")}`);
    fireEvent.click(c);
    expect(totalLine(container)).toBe(`Total for 1 item: ${formatMoney(1999, "USD")}`);
    fireEvent.click(b);
    fireEvent.click(c);
    expect(totalLine(container)).toBe(`Total for 3 items: ${formatMoney(125457, "USD")}`);
  });

  test("posts only checked ids as a repeated productId field", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const f = form(container);
    expect(new FormData(f).getAll("productId")).toEqual(["qa-p1", "qa-p2", "qa-p3"]);
    fireEvent.click(boxes(container)[0] as HTMLInputElement); // main unchecked while others remain
    expect(new FormData(f).getAll("productId")).toEqual(["qa-p2", "qa-p3"]);
    expect([...new FormData(f).keys()].every((k) => k === "productId")).toBe(true);
  });

  test("main is locked ONLY when it is the last checked: disabled + hidden input keeps posting it", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const [main, b, c] = boxes(container) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    expect(main.disabled).toBe(false);
    fireEvent.click(b);
    expect(main.disabled).toBe(false);
    fireEvent.click(c);
    expect(main.disabled).toBe(true);
    expect(main.checked).toBe(true);
    expect(main.getAttribute("aria-describedby")).toBeTruthy();
    expect(new FormData(form(container)).getAll("productId")).toEqual(["qa-p1"]);
    expect(container.querySelectorAll('input[type="hidden"][name="productId"]')).toHaveLength(1);
    // Clicking the locked box changes nothing.
    fireEvent.click(main);
    expect(main.checked).toBe(true);
    expect(totalLine(container)).toBe(`Total for 1 item: ${formatMoney(1999, "USD")}`);
    // Re-checking a companion unlocks main and removes the hidden duplicate.
    fireEvent.click(b);
    expect(main.disabled).toBe(false);
    expect(container.querySelectorAll('input[type="hidden"][name="productId"]')).toHaveLength(0);
    expect(new FormData(form(container)).getAll("productId")).toEqual(["qa-p1", "qa-p2"]);
  });

  test("a companion is never locked; with main unchecked, all boxes can be cleared", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const [main, b, c] = boxes(container) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    fireEvent.click(main);
    fireEvent.click(b);
    expect(c.disabled).toBe(false);
    fireEvent.click(c);
    expect(boxes(container).every((x) => !x.checked)).toBe(true);
    expect(totalLine(container)).toBe("Select at least one item.");
    expect(submitButton().disabled).toBe(true);
    expect(new FormData(form(container)).getAll("productId")).toEqual([]);
  });

  test("0 checked: submit disabled so the action is never called", () => {
    const action = mock<CartActionFnV2>(async () => null);
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    for (const box of boxes(container)) fireEvent.click(box);
    // main was clicked first, so all three end unchecked
    expect(boxes(container).filter((b) => b.checked)).toHaveLength(0);
    fireEvent.click(submitButton());
    expect(action).toHaveBeenCalledTimes(0);
  });
});

describe("T75.4 FBT submit outcomes", () => {
  test("pending: aria-busy; a second click while pending does not call the action again", async () => {
    let release: () => void = () => {};
    const action = mock<CartActionFnV2>(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return success([{ productId: "qa-p1", result: "added" }]);
    });
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitButton()).toHaveAttribute("aria-busy", "true"));
    fireEvent.click(submitButton());
    fireEvent.click(submitButton());
    await act(async () => release());
    await screen.findByText("Added: Alpha.");
    expect(action).toHaveBeenCalledTimes(1);
  });

  test("perItem mixed results read 'Added: A, B. Out of stock: C.' in a polite region; unknown ids are 'another item'", async () => {
    const action: CartActionFnV2 = async () =>
      success([
        { productId: "qa-p1", result: "added" },
        { productId: "qa-p2", result: "added" },
        { productId: "qa-p3", result: "out_of_stock" },
        { productId: "forged-id", result: "unavailable" },
      ]);
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(submitButton());
    const msg = await screen.findByText("Added: Alpha, Bravo. Out of stock: Charlie. Unavailable: another item.");
    expect(msg).toHaveAttribute("aria-live", "polite");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("describePerItem: all four outcomes in fixed order; empty -> ''; hostile names stay plain strings", () => {
    const items = [A, B, C, { id: "x", name: HOSTILE }];
    expect(
      describePerItem(
        [
          { productId: "x", result: "unavailable" },
          { productId: "qa-p3", result: "capped" },
          { productId: "qa-p2", result: "out_of_stock" },
          { productId: "qa-p1", result: "added" },
        ],
        items,
      ),
    ).toBe(`Added: Alpha. Out of stock: Bravo. Already at the cart limit: Charlie. Unavailable: ${HOSTILE}.`);
    expect(describePerItem([], items)).toBe("");
  });

  test("error state renders in role=alert and keeps the form usable", async () => {
    const action: CartActionFnV2 = async () => ({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
    });
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(submitButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Try again shortly.");
    expect(submitButton().disabled).toBe(false);
  });

  test("forged fields injected into the DOM are not produced by the component; it adds only productId", async () => {
    let keys: string[] = [];
    const action: CartActionFnV2 = async (_p, fd) => {
      keys = [...fd.keys()];
      return success([{ productId: "qa-p1", result: "added" }]);
    };
    render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    fireEvent.click(submitButton());
    await screen.findByText("Added: Alpha.");
    expect(keys.length).toBe(3);
    expect(keys.every((k) => k === "productId")).toBe(true);
  });
});

describe("FBT dedupe, cap, invalid prices, hostile text, form reset", () => {
  test("duplicates collapse and at most ADD_MANY_MAX_ITEMS boxes render; posted ids are unique", () => {
    const many = Array.from({ length: ADD_MANY_MAX_ITEMS + 4 }, (_, i) => product(i + 1, { priceCents: 100 }));
    const items = [many[0] as Product, many[0] as Product, ...many, many[1] as Product];
    const { container } = render(
      <FrequentlyBoughtTogether bundle={{ items, totalCents: 0 }} action={noop} />,
    );
    expect(boxes(container)).toHaveLength(ADD_MANY_MAX_ITEMS);
    const posted = new FormData(form(container)).getAll("productId");
    expect(new Set(posted).size).toBe(posted.length);
    expect(posted).toHaveLength(ADD_MANY_MAX_ITEMS);
    expect(bundleItems({ items, totalCents: 0 })).toHaveLength(ADD_MANY_MAX_ITEMS);
    expect(totalLine(container)).toBe(`Total for 10 items: ${formatMoney(1000, "USD")}`);
  });

  test("invalid price anywhere -> 'Total unavailable.' (never NaN or a float)", () => {
    silenceWarn();
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
    for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
      const items = [A, product(9, { priceCents: bad })];
      expect(totalCentsOf(items)).toBeNull();
      const { container, unmount } = render(
        <FrequentlyBoughtTogether bundle={{ items, totalCents: 0 }} action={noop} />,
      );
      expect(totalLine(container)).toBe("Total unavailable.");
      expect(container.textContent ?? "").not.toContain("NaN");
      unmount();
    }
    } finally {
      errSpy.mockRestore();
    }
  });

  test("overflowing sum -> 'Total unavailable.'", () => {
    const items = [product(1, { priceCents: Number.MAX_SAFE_INTEGER }), product(2, { priceCents: 1 })];
    expect(totalCentsOf(items)).toBeNull();
  });

  test("hostile names render as text (labels, image alts, results)", async () => {
    const H = product(4, { name: HOSTILE });
    const action: CartActionFnV2 = async () => success([{ productId: "qa-p4", result: "out_of_stock" }]);
    const { container } = render(
      <FrequentlyBoughtTogether bundle={{ items: [A, H], totalCents: 1999 + 2004 }} action={action} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.textContent).toContain(HOSTILE);
    fireEvent.click(submitButton());
    expect(await screen.findByText(`Out of stock: ${HOSTILE}.`)).toBeInTheDocument();
    const html = renderToStaticMarkup(<FrequentlyBoughtTogether bundle={{ items: [A, H], totalCents: 0 }} action={noop} />);
    // React appends its own form-replay <script> to static markup; the hostile name must not add another.
    expect((html.match(/<script>/g) ?? []).length).toBe((html.match(/<script>addEventListener\("submit"/g) ?? []).length);
    expect(html).not.toContain("<script>alert(2)");
  });

  test("React 19 automatic form reset after an action: DOM boxes, posted ids and the total stay in sync", async () => {
    const action: CartActionFnV2 = async () => success([{ productId: "qa-p1", result: "added" }]);
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={action} />);
    const [, b] = boxes(container) as [HTMLInputElement, HTMLInputElement];
    fireEvent.click(b);
    fireEvent.click(submitButton());
    await screen.findByText("Added: Alpha.");
    const checked = boxes(container).filter((x) => x.checked);
    const posted = new FormData(form(container)).getAll("productId");
    expect(posted).toEqual(checked.map((x) => x.value));
    const sum = totalCentsOf(bundle3.items.filter((p) => posted.includes(p.id)));
    expect(totalLine(container)).toBe(
      `Total for ${checked.length} ${checked.length === 1 ? "item" : "items"}: ${formatMoney(sum ?? -1, "USD")}`,
    );
  });

  test("native form.reset() (reset button / browser) re-checks everything and the total follows", async () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const [, b, c] = boxes(container) as [HTMLInputElement, HTMLInputElement, HTMLInputElement];
    fireEvent.click(b);
    fireEvent.click(c);
    await act(async () => form(container).reset());
    const states = boxes(container).map((x) => x.checked);
    const posted = new FormData(form(container)).getAll("productId");
    expect(posted).toEqual(boxes(container).filter((x) => x.checked).map((x) => x.value));
    const n = states.filter(Boolean).length;
    const sum = totalCentsOf(bundle3.items.filter((p) => posted.includes(p.id)));
    expect(totalLine(container)).toBe(`Total for ${n} ${n === 1 ? "item" : "items"}: ${formatMoney(sum ?? -1, "USD")}`);
  });

  test("fewer than 2 distinct items renders nothing", () => {
    expect(renderToStaticMarkup(<FrequentlyBoughtTogether bundle={{ items: [A, A], totalCents: 0 }} action={noop} />)).toBe("");
    expect(renderToStaticMarkup(<FrequentlyBoughtTogether bundle={{ items: [], totalCents: 0 }} action={noop} />)).toBe("");
  });

  test("keyboard: Space toggles a companion checkbox and the total follows", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const c = boxes(container)[2] as HTMLInputElement;
    c.focus();
    expectFocused(c);
    fireEvent.click(c); // happy-dom: Space activation dispatches click
    expect(totalLine(container)).toBe(`Total for 2 items: ${formatMoney(2000, "USD")}`);
  });

  test("image links and every href pass isAllowedInternalHref; checkbox labels are associated", () => {
    const { container } = render(<FrequentlyBoughtTogether bundle={bundle3} action={noop} />);
    const hrefs = hrefsOf(container);
    expect(hrefs).toHaveLength(3);
    for (const h of hrefs) expect(isAllowedInternalHref(h)).toBe(true);
    expect(screen.getByRole("checkbox", { name: /This item: Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /Bravo/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: FBT_SUBMIT_LABEL })).toBeInTheDocument();
  });

  test("FBT source: type-only server import, no inline style, no raw HTML", () => {
    const src = readFileSync(join(ROOT, "FrequentlyBoughtTogether/FrequentlyBoughtTogether.tsx"), "utf8");
    for (const line of src.split("\n").filter((l) => l.includes("@/server/"))) {
      expect(line).toMatch(/^import type /);
    }
    expect(src).not.toMatch(/style=|dangerouslySetInnerHTML/);
  });
});
