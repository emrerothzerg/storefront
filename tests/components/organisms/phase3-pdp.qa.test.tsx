// QA (T164, Phase 3 wave B2): PDP organisms against T159/T160 acceptance criteria and CONTRACTS
// P rows (reference pending). BuyBox v3, ReviewsSection, QASection, FrequentlyBoughtTogether,
// CompareTable. DOM nodes never go into `expect` inside waitFor (see @/test/dom-assertions).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CartActionFn, CartActionFnV2, CartActionStateV2 } from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn } from "@/components/molecules/_contracts/list-actions";
import type { QaActionFn, QaVoteActionFn } from "@/components/molecules/_contracts/qa-actions";
import type { ReviewActionFn, VoteActionFn } from "@/components/molecules/_contracts/review-actions";
import type { StockAlertActionFn } from "@/components/molecules/_contracts/stock-alert-actions";
import { savingLabel } from "@/components/molecules/StockBadge/SavingBadge";
import { BUY_BOX_MAX_QUANTITY, BuyBox, type BuyBoxProps } from "@/components/organisms/BuyBox";
import { CompareTable } from "@/components/organisms/CompareTable";
import { makeDetail } from "@/components/organisms/CompareTable/test-fixtures";
import { FBT_HEADING, FrequentlyBoughtTogether } from "@/components/organisms/FrequentlyBoughtTogether";
import { QASection, type QASectionProps } from "@/components/organisms/QASection";
import { ReviewsSection, type ReviewsSectionProps } from "@/components/organisms/ReviewsSection";
import { isAllowedInternalHref } from "@/content/routes";
import { ok } from "@/lib/result";
import type { Product } from "@/lib/types";
import type { QaListResult, QuestionView } from "@/server/qa/qa-service";
import type { ReviewListResult, ReviewView } from "@/server/reviews/review-service";
import { expectFocused } from "@/test/dom-assertions";

const ORG = join(import.meta.dir, "../../../src/components/organisms");
const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "q" 's' ‮evil`;
const DARK_PREFIX = ["da", "rk:"].join("");

const parse = (html: string): Document => new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
const doc = (el: ReactElement): Document => parse(renderToStaticMarkup(el));
const squash = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const classesOf = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

function allClasses(root: ParentNode): string[] {
  const nodes = root instanceof Element ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
  return nodes.flatMap((n) => classesOf(n));
}
function expectTokenOnlyClasses(root: ParentNode, where: string) {
  const bad = allClasses(root).filter(
    (c) =>
      c.includes(DARK_PREFIX) ||
      /\[/.test(c) ||
      /(^|:)(bg|text|border|ring|fill|stroke)-(red|blue|green|gray|slate|zinc|neutral|stone|orange|amber|yellow|lime|emerald|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose)-\d/.test(c),
  );
  expect({ where, bad }).toEqual({ where, bad: [] });
}
function visibleText(html: string): string {
  const body = parse(html).body;
  for (const s of body.querySelectorAll("script")) s.remove();
  return body.textContent ?? "";
}
function expectNoInjectedMarkup(html: string) {
  const d = parse(html);
  expect(d.querySelectorAll('img[src="x"], img[onerror]')).toHaveLength(0);
  for (const sc of d.querySelectorAll("script")) expect(sc.textContent?.includes("alert(")).toBe(false);
}
function expectBrandFree(html: string) {
  const lower = html.toLowerCase();
  for (const word of ["kmart", "onepass", "afterpay", "zip pay"]) expect({ word, found: lower.includes(word) }).toEqual({ word, found: false });
  expect(/\btarget\b/i.test(visibleText(html))).toBe(false);
}
function expectHrefsAllowed(root: ParentNode) {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("mailto:")) continue; // ShareLink "Email a friend" (accepted by design, T104a)
    expect({ href, ok: isAllowedInternalHref(href) }).toEqual({ href, ok: true });
  }
}

/** A Next server reference as React SSR sees it (`$$FORM_ACTION`), so no-JS markup posts for real. */
function serverLike<F extends (...args: never[]) => unknown>(fn: F, ref: string): F {
  const formFields = () => ({ name: ref, action: "", encType: "multipart/form-data", method: "POST", data: null });
  return Object.assign(fn, {
    $$FORM_ACTION: formFields,
    bind(): unknown {
      return Object.assign(async () => null, { $$FORM_ACTION: formFields });
    },
  });
}

// ---------------------------------------------------------------------------
// BuyBox v3 (T159; P-5..P-10, P-14)
// ---------------------------------------------------------------------------

type Posted = Record<string, string[]>;
const entriesOf = (fd: FormData): Posted => {
  const out: Posted = {};
  for (const [k, v] of fd.entries()) (out[k] ??= []).push(String(v));
  return out;
};
const SUCCESS: CartActionStateV2 = ok({ itemCount: 1, subtotalCents: 1999, message: "Added to cart" });
function cartRecorder() {
  const calls: Posted[] = [];
  const action = async (_prev: unknown, fd: FormData) => {
    calls.push(entriesOf(fd));
    return SUCCESS;
  };
  return { action, calls };
}
const noopList: ListActionFn = async () => null;
const noopAlert: StockAlertActionFn = async () => null;

function buyBoxProps(over: Partial<BuyBoxProps> = {}, product: Partial<BuyBoxProps["product"]> = {}): BuyBoxProps {
  return {
    product: { id: "qa-p1", slug: "qa-lamp", name: "QA Lamp", priceCents: 1999, listPriceCents: 2499, currency: "USD", stock: 42, ...product },
    actions: {
      addToCart: cartRecorder().action as CartActionFn,
      buyNow: cartRecorder().action as CartActionFnV2,
      addToList: noopList,
      removeFromList: noopList,
      subscribeStockAlert: noopAlert,
      unsubscribeStockAlert: noopAlert,
    },
    viewer: { inWishlist: false, alertRegistered: false },
    delivery: { estimate: { start: "2026-11-10T12:00:00.000Z", end: "2026-11-12T12:00:00.000Z" }, methodName: "Standard" },
    ...over,
  };
}
const buyBox = (over: Partial<BuyBoxProps> = {}, product: Partial<BuyBoxProps["product"]> = {}) => <BuyBox {...buyBoxProps(over, product)} />;

describe("T159 BuyBox v3: surface and price group (P-6)", () => {
  test("white Card section labelled by a visually hidden 'Buying options' h2 (h3 with headingLevel 3)", () => {
    const d = doc(buyBox());
    const section = d.querySelector("section") as HTMLElement;
    const cls = classesOf(section);
    for (const c of ["rounded-lg", "bg-surface-raised", "shadow-sm", "border-border-default", "min-w-0"]) expect({ c, has: cls.includes(c) }).toEqual({ c, has: true });
    const heading = d.getElementById(section.getAttribute("aria-labelledby") ?? "");
    expect(heading?.tagName).toBe("H2");
    expect(heading?.textContent).toBe("Buying options");
    expect(classesOf(heading)).toContain("sr-only");
    expect(doc(buyBox({ headingLevel: 3 })).querySelector("section h3")?.textContent).toBe("Buying options");
  });

  test("inline superscript price: accessible '$19.99', visible part aria-hidden; 'Was $24.99' in <s>; SavingBadge 'Save $5.00 (20%)'", () => {
    const d = doc(buyBox());
    const group = d.querySelector('[data-slot="buy-box-price"]') as HTMLElement;
    expect(group.querySelector('[data-layout="inline"]')).not.toBeNull();
    const sup = group.querySelector('[data-slot="price-superscript"]');
    expect(sup?.getAttribute("aria-hidden")).toBe("true");
    expect(squash(sup?.parentElement?.querySelector(".sr-only")?.textContent)).toBe("$19.99");
    const was = group.querySelectorAll("s");
    expect(was).toHaveLength(1);
    expect(squash(was[0]?.textContent)).toBe("Was $24.99");
    expect(squash(group.querySelector("[data-saving-badge]")?.textContent)).toBe("Save $5.00 (20%)");
    expect(classesOf(group.querySelector("[data-saving-badge]"))).toContain("rounded-full");
  });

  test("T164 AC3 saving edge cases: equal prices, list < price, 1 cent, floor, < 1%, invalid list", () => {
    const cases: Array<[number, number | null, string | null]> = [
      [1999, 2499, "Save $5.00 (20%)"],
      [1999, 1999, null],
      [2499, 1999, null],
      [1, 2, "Save $0.01 (50%)"],
      [1, 100, "Save $0.99 (99%)"],
      [2, 3, "Save $0.01 (33%)"],
      [9999, 10000, "Save $0.01"],
      [1999, null, null],
      [1999, Number.NaN, null],
      [1999, -5, null],
      [1999, 2499.5, null],
    ];
    for (const [price, list, expected] of cases) {
      expect({ price, list, label: savingLabel(price, list, "USD") }).toEqual({ price, list, label: expected });
      const d = doc(buyBox({}, { priceCents: price, listPriceCents: list }));
      const badge = d.querySelector("[data-saving-badge]");
      expect({ price, list, badge: badge === null ? null : squash(badge.textContent) }).toEqual({ price, list, badge: expected });
      if (expected === null) expect({ price, list, struck: d.querySelectorAll("[data-slot='buy-box-price'] s").length }).toEqual({ price, list, struck: 0 });
    }
  });

  test("coupon line only when code and description are both non-blank; hostile text stays text", () => {
    const line = (c: BuyBoxProps["promotedCoupon"]) => {
      const t = visibleText(renderToStaticMarkup(buyBox({ promotedCoupon: c })));
      return t.includes("Save with code");
    };
    expect(line({ code: "SAVE10", description: "10% off lamps" })).toBe(true);
    expect(line({ code: "  ", description: "x" })).toBe(false);
    expect(line({ code: "X", description: "   " })).toBe(false);
    expect(line(null)).toBe(false);
    const html = renderToStaticMarkup(buyBox({ promotedCoupon: { code: HOSTILE, description: HOSTILE } }));
    expectNoInjectedMarkup(html);
    expect(visibleText(html)).toContain(`Save with code ${HOSTILE}: ${HOSTILE}`);
  });
});

describe("T159 BuyBox v3: stock, delivery, purchase (P-7, P-8, P-10)", () => {
  test("one stock pill: in stock text once; low stock 'Only 3 left in stock'; text, not colour only", () => {
    const inStock = visibleText(renderToStaticMarkup(buyBox()));
    expect(inStock.match(/In stock/g)?.length ?? 0).toBe(1);
    const low = doc(buyBox({}, { stock: 3 }));
    const pills = low.querySelectorAll("[data-stock-status]");
    expect(pills).toHaveLength(1);
    expect(squash(pills[0]?.textContent)).toBe("Only 3 left in stock");
    expect(classesOf(pills[0])).toContain("rounded-full");
  });

  test("delivery estimate renders as text with the method", () => {
    const t = squash(visibleText(renderToStaticMarkup(buyBox())));
    expect(t).toContain("Arrives Tue, Nov 10");
    expect(t).toContain("Standard");
  });

  test("purchase pills: Add to cart (primary) + Buy Now (outline) in ONE form with productId + quantity, both full-width 44px pills; no price field (SR9)", () => {
    const d = doc(buyBox());
    const add = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Add to cart");
    const buy = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Buy Now");
    expect(add?.closest("form") === buy?.closest("form")).toBe(true);
    for (const b of [add, buy]) {
      const cls = classesOf(b);
      expect(b?.getAttribute("type")).toBe("submit");
      for (const c of ["rounded-full", "min-h-touch", "w-full"]) expect({ text: b?.textContent, c, has: cls.includes(c) }).toEqual({ text: b?.textContent, c, has: true });
    }
    expect(classesOf(add)).toContain("bg-accent");
    expect(classesOf(buy)).toContain("border-accent");
    const form = add?.closest("form") as HTMLFormElement;
    const names = [...form.querySelectorAll("input[name]")].map((i) => i.getAttribute("name"));
    expect(names.sort()).toEqual(["productId", "quantity"]);
    expect(form.querySelector('input[name="productId"]')?.getAttribute("value")).toBe("qa-p1");
    expect(form.querySelector('label[for="' + (form.querySelector('input[name="quantity"]')?.id ?? "") + '"]')?.textContent).toBe("Quantity");
  });

  test("no-JS (server references): Add to cart form and Buy Now formAction are real POST targets, not javascript:", () => {
    const add = serverLike(cartRecorder().action, "$ACTION_REF_ADD");
    const buy = serverLike(cartRecorder().action, "$ACTION_REF_BUY");
    const props = buyBoxProps();
    const html = renderToStaticMarkup(<BuyBox {...props} actions={{ ...props.actions, addToCart: add as unknown as CartActionFn, buyNow: buy as unknown as CartActionFnV2 }} />);
    const d = parse(html);
    const buyBtn = [...d.querySelectorAll("button")].find((b) => squash(b.textContent) === "Buy Now");
    const form = buyBtn?.closest("form");
    expect((form?.getAttribute("action") ?? "").startsWith("javascript:")).toBe(false);
    expect((form?.getAttribute("method") ?? "").toLowerCase()).toBe("post");
    expect((buyBtn?.getAttribute("formAction") ?? buyBtn?.getAttribute("formaction") ?? "").startsWith("javascript:")).toBe(false);
  });

  test("quantity stepper caps at min(stock, 10)", () => {
    for (const [stock, cap] of [
      [3, 3],
      [42, BUY_BOX_MAX_QUANTITY],
    ] as const) {
      const { container, unmount } = render(buyBox({}, { stock }));
      const inc = within(container).getByRole("button", { name: "Increase quantity" });
      for (let i = 0; i < 15; i++) if (!(inc as HTMLButtonElement).disabled) fireEvent.click(inc);
      expect({ stock, value: (container.querySelector('input[name="quantity"]') as HTMLInputElement).value, disabled: (inc as HTMLButtonElement).disabled }).toEqual({
        stock,
        value: String(cap),
        disabled: true,
      });
      unmount();
    }
  });

  test("Add to cart and Buy Now post their own action with productId + quantity", async () => {
    const add = cartRecorder();
    const buy = cartRecorder();
    const props = buyBoxProps();
    render(<BuyBox {...props} actions={{ ...props.actions, addToCart: add.action as CartActionFn, buyNow: buy.action as CartActionFnV2 }} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(add.calls.length).toBe(1));
    expect(add.calls[0]).toEqual({ productId: ["qa-p1"], quantity: ["1"] });
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    await waitFor(() => expect(buy.calls.length).toBe(1));
    expect(buy.calls[0]?.productId).toEqual(["qa-p1"]);
    expect(add.calls.length).toBe(1);
  });

  test("out of stock (0, NaN, -1, 1.5): no quantity / Add / Buy; StockAlertForm instead; wish list stays", () => {
    for (const stock of [0, Number.NaN, -1, 1.5]) {
      const d = doc(buyBox({}, { stock }));
      const texts = [...d.querySelectorAll("button")].map((b) => squash(b.textContent));
      expect({ stock, add: texts.includes("Add to cart"), buy: texts.includes("Buy Now"), qty: d.querySelector('input[name="quantity"]') !== null }).toEqual({ stock, add: false, buy: false, qty: false });
      expect({ stock, alert: texts.some((t) => t.startsWith("Notify me when available")) }).toEqual({ stock, alert: true });
      expect(texts.some((t) => t.includes("Wish List"))).toBe(true);
    }
  });

  test("wish list is a full-width pill; compare/share row only when either is given; trust list is the last block", () => {
    const d = doc(buyBox({ compare: { selected: [] }, shareUrl: "/products/qa-lamp" }));
    const wish = [...d.querySelectorAll("button")].find((b) => squash(b.textContent).includes("Wish List"));
    expect(classesOf(wish)).toContain("w-full");
    expect(classesOf(wish)).toContain("rounded-full");
    const row = d.querySelector('[data-slot="buy-box-secondary"]');
    expect(row?.querySelector('input[type="checkbox"][name="p"]')).not.toBeNull();
    expect(row?.querySelector("details summary")?.textContent).toContain("Share");
    expect(doc(buyBox()).querySelector('[data-slot="buy-box-secondary"]')).toBeNull();
    expect(doc(buyBox({ shareUrl: "   " })).querySelector('[data-slot="buy-box-secondary"]')).toBeNull();
    const section = d.querySelector("section") as HTMLElement;
    const last = section.lastElementChild;
    expect(last?.tagName).toBe("UL");
    expect([...(last?.querySelectorAll("li") ?? [])].map((li) => squash(li.textContent))).toEqual([
      "Secure transaction",
      "Free returns within 30 days (sample policy)",
      "Ships from Northwind Goods",
    ]);
  });
});

describe("T159 BuyBox v3: focus order (P-9) and sticky (P-14)", () => {
  test("tab order: quantity -> Add to cart -> Buy Now -> Add to list -> compare -> share", () => {
    const { container } = render(buyBox({ compare: { selected: [] }, shareUrl: "/products/qa-lamp" }));
    const focusables = [...container.querySelectorAll<HTMLElement>("a[href], button, input:not([type='hidden']), select, textarea, summary, [tabindex]")].filter(
      (el) => !(el as HTMLButtonElement).disabled && el.getAttribute("tabindex") !== "-1",
    );
    const idx = (pred: (el: HTMLElement) => boolean) => focusables.findIndex(pred);
    const order = [
      idx((el) => el.getAttribute("name") === "quantity"),
      idx((el) => squash(el.textContent) === "Add to cart"),
      idx((el) => squash(el.textContent) === "Buy Now"),
      idx((el) => squash(el.textContent).includes("Wish List")),
      idx((el) => el.getAttribute("name") === "p"),
      idx((el) => el.tagName === "SUMMARY" && squash(el.textContent).includes("Share")),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Nothing focusable sits before the quantity control except the stepper's own decrease button.
    expect(focusables.slice(0, order[0]).map((el) => el.getAttribute("aria-label"))).toEqual(order[0] === 0 ? [] : ["Decrease quantity"].slice(0, order[0]));
  });

  test("sticky is opt-in and lg-only; descendants always keep scroll margins", () => {
    const off = classesOf(doc(buyBox()).querySelector("section"));
    expect(off.filter((c) => /sticky|(^|:)top-/.test(c))).toEqual([]);
    expect(off).toContain("**:scroll-mt-4");
    expect(off).toContain("**:scroll-mb-4");
    const on = classesOf(doc(buyBox({ sticky: true })).querySelector("section"));
    expect(on.filter((c) => /sticky|(^|:)top-|self-start/.test(c)).sort()).toEqual(["lg:self-start", "lg:sticky", "lg:top-4"]);
    expect(doc(buyBox({ sticky: true })).querySelector("section")?.hasAttribute("data-sticky")).toBe(true);
  });

  test("hostile product name / seller stay text; token-only classes; brand-free; hrefs allow-listed", () => {
    const html = renderToStaticMarkup(buyBox({ sellerName: HOSTILE, compare: { selected: [] }, shareUrl: "/products/qa-lamp" }, { name: HOSTILE, stock: 0 }));
    expectNoInjectedMarkup(html);
    expect(visibleText(html)).toContain(`Ships from ${HOSTILE}`);
    const d = parse(renderToStaticMarkup(buyBox({ compare: { selected: [] }, shareUrl: "/products/qa-lamp", promotedCoupon: { code: "A", description: "B" } }, { stock: 3 })));
    expectTokenOnlyClasses(d.body, "BuyBox");
    expectBrandFree(d.body.innerHTML);
    expectHrefsAllowed(d);
  });
});

// ---------------------------------------------------------------------------
// ReviewsSection (T160)
// ---------------------------------------------------------------------------

const BASE = "/products/qa-lamp";
const submitReview: ReviewActionFn = async () => null;
const voteReviewHelpful: VoteActionFn = async () => null;
function review(n: number, over: Partial<ReviewView> = {}): ReviewView {
  return {
    id: `qa-rev-${n}`,
    productId: "qa-p1",
    displayName: `QA Shopper ${n}`,
    rating: 5,
    title: `QA title ${n}`,
    body: `QA body ${n}`,
    verifiedPurchase: true,
    helpfulCount: 0,
    status: "published",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    ...over,
  };
}
const summary = { count: 30, avg: 4, histogram: { 5: 15, 4: 8, 3: 4, 2: 2, 1: 1 } } as const;
const emptySummary = { count: 0, avg: 0, histogram: { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 } } as const;
function reviewList(over: Partial<ReviewListResult> = {}): ReviewListResult {
  return { items: [review(1), review(2)], total: 30, page: 1, pageCount: 3, summary: { ...summary, histogram: { ...summary.histogram } }, ...over };
}
function reviewsProps(over: Partial<ReviewsSectionProps> = {}): ReviewsSectionProps {
  return {
    productId: "qa-p1",
    productSlug: "qa-lamp",
    list: reviewList(),
    query: { sort: "helpful" },
    basePath: BASE,
    actions: { submitReview, voteReviewHelpful },
    viewer: { signedInName: null, alreadyReviewed: false },
    ...over,
  };
}

describe("T160 ReviewsSection restyle", () => {
  test("section#reviews labelled by its h2; summary Card, sunken controls band, list Card (white)", () => {
    const d = doc(<ReviewsSection {...reviewsProps()} />);
    const section = d.querySelector("section#reviews") as HTMLElement;
    expect(d.getElementById(section.getAttribute("aria-labelledby") ?? "")?.tagName).toBe("H2");
    const summaryCard = classesOf(section.querySelector('[data-testid="reviews-summary-card"]'));
    expect(summaryCard).toEqual(expect.arrayContaining(["rounded-lg", "bg-surface-raised"]));
    expect(classesOf(section.querySelector('[data-testid="reviews-controls"]'))).toEqual(expect.arrayContaining(["rounded-lg", "bg-surface-sunken"]));
    expect(classesOf(section.querySelector('[data-testid="reviews-list-card"]'))).toEqual(expect.arrayContaining(["rounded-lg", "bg-surface-raised"]));
  });

  test("GET sort form: action = path#reviews, method get, labelled select name=sort; stars/verified kept, rpage dropped; Apply is an outline pill", () => {
    const d = doc(<ReviewsSection {...reviewsProps({ query: { sort: "recent", stars: 4, verifiedOnly: true }, list: reviewList({ page: 2 }) })} />);
    const form = d.querySelector('form[aria-label="Sort reviews"]') as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe(`${BASE}#reviews`);
    const select = form.querySelector('select[name="sort"]') as HTMLSelectElement;
    expect(form.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("Sort by");
    const names = [...form.querySelectorAll("[name]")].map((el) => el.getAttribute("name"));
    expect(names.sort()).toEqual(["sort", "stars", "verified"]);
    const apply = form.querySelector('button[type="submit"]');
    expect(squash(apply?.textContent)).toBe("Apply");
    expect(classesOf(apply)).toEqual(expect.arrayContaining(["rounded-full", "border-accent", "min-h-touch"]));
  });

  test("filter chips are 44px pill links; selected chip marked with aria-current; histogram values are text (T160 AC2)", () => {
    const d = doc(<ReviewsSection {...reviewsProps({ query: { sort: "helpful", verifiedOnly: true } })} />);
    const chips = [...d.querySelectorAll('ul[aria-label="Review filters"] a')];
    expect(chips.length).toBeGreaterThanOrEqual(2);
    for (const a of chips) expect(classesOf(a)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
    const verified = chips.find((a) => squash(a.textContent) === "Verified purchase only");
    expect(verified?.getAttribute("aria-current")).toBe("true");
    const allStars = chips.find((a) => squash(a.textContent) === "All stars");
    expect(allStars?.getAttribute("aria-current")).toBe("true");
    const histogram = [...d.querySelectorAll('[data-testid="reviews-summary-card"] a[aria-label]')];
    expect(histogram.map((a) => a.getAttribute("aria-label"))).toEqual(["5 star: 50%", "4 star: 27%", "3 star: 13%", "2 star: 7%", "1 star: 3%"]);
    for (const a of histogram) expect(squash(a.textContent)).toMatch(/^\d star\s*\d+%$/);
    expectTokenOnlyClasses(d.body, "ReviewsSection");
  });

  test("empty: sunken empty Card, no controls band, write-review disclosure open; hostile review text stays text", () => {
    const empty = doc(<ReviewsSection {...reviewsProps({ list: reviewList({ items: [], total: 0, pageCount: 0, summary: { ...emptySummary, histogram: { ...emptySummary.histogram } } }) })} />);
    expect(empty.querySelector('[data-testid="reviews-controls"]')).toBeNull();
    expect(classesOf(empty.querySelector('[data-testid="reviews-empty"]')?.parentElement)).toContain("bg-surface-sunken");
    expect(empty.querySelector("details")?.hasAttribute("open")).toBe(true);
    const html = renderToStaticMarkup(<ReviewsSection {...reviewsProps({ list: reviewList({ items: [review(1, { title: HOSTILE, body: HOSTILE, displayName: HOSTILE })] }) })} />);
    expectNoInjectedMarkup(html);
    expect(visibleText(html)).toContain(HOSTILE);
    expectHrefsAllowed(parse(html));
    expectBrandFree(html);
  });
});

// ---------------------------------------------------------------------------
// QASection (T160)
// ---------------------------------------------------------------------------

const ask: QaActionFn = async () => null;
const vote: QaVoteActionFn = async () => null;
function question(n: number, over: Partial<QuestionView> = {}): QuestionView {
  return { id: `qa-q-${n}`, productId: "qa-p1", displayName: `Asker ${n}`, body: `Question ${n}?`, helpfulCount: 0, status: "published", createdAt: "2026-11-04T10:00:00.000Z", answers: [], ...over };
}
function qaProps(over: Partial<QASectionProps> = {}, list: Partial<QaListResult> = {}): QASectionProps {
  return {
    productId: "qa-p1",
    productSlug: "qa-lamp",
    list: { items: [question(1), question(2)], total: 12, page: 1, pageCount: 3, ...list },
    basePath: BASE,
    actions: { askQuestion: ask, answerQuestion: ask, voteQuestion: vote, voteAnswer: vote },
    viewer: { signedInName: null },
    ...over,
  };
}

describe("T160 QASection bands", () => {
  test("section#questions labelled by its h2; count text; 'Ask a question' bordered disclosure; ol of questions; pagination links allow-listed with #questions", () => {
    const d = doc(<QASection {...qaProps()} />);
    const section = d.querySelector("section#questions") as HTMLElement;
    expect(d.getElementById(section.getAttribute("aria-labelledby") ?? "")?.tagName).toBe("H2");
    expect(squash(section.querySelector('[data-testid="questions-count"]')?.textContent)).toBe("12 questions");
    const ask = section.querySelector("details");
    expect(squash(ask?.querySelector("summary")?.textContent)).toContain("Ask a question");
    expect(ask?.hasAttribute("open")).toBe(false);
    expect(section.querySelectorAll('ol[aria-label="Questions"] > li')).toHaveLength(2);
    const pages = [...section.querySelectorAll('nav[aria-label="Questions pagination"] a[href]')].map((a) => a.getAttribute("href") ?? "");
    expect(pages.length).toBeGreaterThan(0);
    for (const h of pages) {
      expect(isAllowedInternalHref(h)).toBe(true);
      expect(h.endsWith("#questions")).toBe(true);
    }
    expectTokenOnlyClasses(d.body, "QASection");
  });

  test("empty: sunken empty Card first, ask disclosure open; page past end: sunken Card + pill link to page 1", () => {
    const empty = doc(<QASection {...qaProps({}, { items: [], total: 0, pageCount: 0 })} />);
    expect(classesOf(empty.querySelector('[data-testid="questions-empty"]')?.parentElement)).toContain("bg-surface-sunken");
    expect(empty.querySelector("details")?.hasAttribute("open")).toBe(true);
    const past = doc(<QASection {...qaProps({}, { items: [], total: 12, page: 9 })} />);
    const card = past.querySelector('[data-testid="questions-page-empty"]');
    expect(classesOf(card)).toContain("bg-surface-sunken");
    const link = card?.querySelector("a");
    expect(classesOf(link)).toContain("rounded-full");
    expect(isAllowedInternalHref(link?.getAttribute("href") ?? "")).toBe(true);
  });

  test("hostile question text stays text; brand-free", () => {
    const html = renderToStaticMarkup(<QASection {...qaProps({}, { items: [question(1, { body: HOSTILE, displayName: HOSTILE })] })} />);
    expectNoInjectedMarkup(html);
    expect(visibleText(html)).toContain(HOSTILE);
    expectBrandFree(html);
  });
});

// ---------------------------------------------------------------------------
// FrequentlyBoughtTogether (T160 AC3)
// ---------------------------------------------------------------------------

const fbtItem = (n: number, over: Partial<Product> = {}): Product => ({
  id: `fbt-${n}`,
  slug: `fbt-${n}`,
  name: `Bundle item ${n}`,
  description: "",
  priceCents: 1000 * n + 99,
  currency: "USD",
  imageUrl: `/images/fbt-${n}.jpg`,
  stock: 5,
  ...over,
});

describe("T160 FrequentlyBoughtTogether", () => {
  const bundle = { items: [fbtItem(1), fbtItem(2), fbtItem(3)], totalCents: 1099 + 2099 + 3099 };

  test("no-JS: Card section + h2; every checkbox checked and named productId; server total = full bundle; one submit", () => {
    const d = doc(<FrequentlyBoughtTogether bundle={bundle} action={async () => SUCCESS} />);
    const section = d.querySelector("section") as HTMLElement;
    expect(classesOf(section)).toEqual(expect.arrayContaining(["rounded-lg", "bg-surface-raised"]));
    expect(d.getElementById(section.getAttribute("aria-labelledby") ?? "")?.textContent).toBe(FBT_HEADING);
    const boxes = [...d.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => [b.getAttribute("name"), b.getAttribute("value"), b.hasAttribute("checked")])).toEqual([
      ["productId", "fbt-1", true],
      ["productId", "fbt-2", true],
      ["productId", "fbt-3", true],
    ]);
    expect(squash(visibleText(renderToStaticMarkup(<FrequentlyBoughtTogether bundle={bundle} action={async () => SUCCESS} />)))).toContain("Total for 3 items: $62.97");
    expect(d.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(d.querySelector("form input[name*='price' i], form input[name*='total' i]")).toBeNull();
    for (const a of d.querySelectorAll("a[href]")) {
      expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
      expect(a.querySelector("img")?.getAttribute("alt")).toMatch(/^Bundle item \d$/);
    }
  });

  test("posts only the checked ids (repeated productId); unchecking updates the total", async () => {
    const calls: Posted[] = [];
    const action = async (_p: unknown, fd: FormData) => {
      calls.push(entriesOf(fd));
      return SUCCESS;
    };
    render(<FrequentlyBoughtTogether bundle={bundle} action={action as CartActionFnV2} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Bundle item 2/ }));
    expect(squash(screen.getByText(/^Total for/).textContent)).toBe("Total for 2 items: $41.98");
    fireEvent.click(screen.getByRole("button", { name: "Add selected to cart" }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual({ productId: ["fbt-1", "fbt-3"] });
  });

  test("main item locked while alone still posts (hidden input); hostile names are text", async () => {
    const calls: Posted[] = [];
    const action = async (_p: unknown, fd: FormData) => {
      calls.push(entriesOf(fd));
      return SUCCESS;
    };
    render(<FrequentlyBoughtTogether bundle={{ items: [fbtItem(1), fbtItem(2, { name: HOSTILE })], totalCents: 3198 }} action={action as CartActionFnV2} />);
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp("evil") }));
    const main = screen.getByRole("checkbox", { name: /Bundle item 1/ }) as HTMLInputElement;
    expect(main.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Add selected to cart" }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual({ productId: ["fbt-1"] });
    expect(document.querySelector('img[src="x"], script')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CompareTable pill toggle (T160)
// ---------------------------------------------------------------------------

describe("T160 CompareTable pill toggle", () => {
  test("differences toggle is a 44px outline pill link; href flips diff=1; state also as text", () => {
    const products = [makeDetail(1), makeDetail(2)];
    const off = doc(<CompareTable products={products} selectedSlugs={products.map((p) => p.slug)} />);
    const toggle = off.querySelector("a[data-differences-only]") as HTMLAnchorElement;
    expect(toggle.getAttribute("data-differences-only")).toBe("off");
    expect(squash(toggle.textContent)).toBe("Show differences only");
    expect(classesOf(toggle)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch", "border-accent"]));
    const href = toggle.getAttribute("href") ?? "";
    expect(isAllowedInternalHref(href)).toBe(true);
    expect(new URL(href, "http://qa.invalid").searchParams.get("diff")).toBe("1");
    const on = doc(<CompareTable products={products} selectedSlugs={products.map((p) => p.slug)} differencesOnly />);
    const t2 = on.querySelector("a[data-differences-only]");
    expect(t2?.getAttribute("data-differences-only")).toBe("on");
    expect(squash(t2?.textContent)).toBe("Show all details");
    expect(new URL(t2?.getAttribute("href") ?? "", "http://qa.invalid").searchParams.has("diff")).toBe(false);
    expect(on.body.textContent).toContain("Showing differences only.");
    expectTokenOnlyClasses(off.body, "CompareTable");
    expectHrefsAllowed(off);
  });
});

describe("source hygiene (T159/T160 files)", () => {
  const files = [
    "BuyBox/BuyBox.tsx",
    "BuyBox/BuyBoxPurchase.tsx",
    "ReviewsSection/ReviewsSection.tsx",
    "QASection/QASection.tsx",
    "FrequentlyBoughtTogether/FrequentlyBoughtTogether.tsx",
    "CompareTable/CompareTable.tsx",
  ];
  for (const file of files) {
    test(`${file}: no any, ts-ignore, dangerouslySetInnerHTML, style=, dark variant, runtime server import`, () => {
      const src = readFileSync(join(ORG, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|as any\b|<any>/);
      expect(src).not.toContain("@ts-ignore");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/style=\{/);
      expect(src.includes(DARK_PREFIX)).toBe(false);
      expect(src).not.toMatch(/^import (?!type )[^;]*["']@\/server/m);
    });
  }
});

// Focus helper kept referenced for keyboard checks below.
describe("keyboard: BuyBox share disclosure and stepper are native controls", () => {
  test("quantity stepper buttons are type=button with labels; focusing Add to cart works", () => {
    render(buyBox());
    for (const name of ["Decrease quantity", "Increase quantity"]) expect(screen.getByRole("button", { name })).toHaveAttribute("type", "button");
    const add = screen.getByRole("button", { name: "Add to cart" });
    add.focus();
    expectFocused(add);
  });
});
