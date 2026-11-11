// QA (QA-W4-organisms-D / T90): T82 CartTable v2 + CartLineItem v2 + SavedForLaterSection.
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { computeLineSavingsCents, computeLineTotalCents } from "@/components/molecules/CartLineItem";
import type {
  CartActionFn,
  CartActionFnV2,
  CartActionState,
  CartActionStateV2,
} from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn, ListActionState } from "@/components/molecules/_contracts/list-actions";
import {
  CartTable,
  SavedForLaterSection,
  type CartTableData,
  type CartTableLine,
  type CartTableProps,
  type SavedForLaterActions,
} from "@/components/organisms/CartTable";
import { isAllowedInternalHref } from "@/content/routes";
import { formatMoney } from "@/lib/money";
import { fail, ok } from "@/lib/result";
import type { Product } from "@/lib/types";
import type { SavedForLaterLine } from "@/server/cart/cart-service";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "q" 's' ‮evil`;
const SRC = join(import.meta.dir, "../../../src/components");
const usd = (c: number) => formatMoney(c, "USD");

type Posted = Record<string, FormDataEntryValue[]>;
function entries(fd: FormData): Posted {
  const out: Posted = {};
  for (const [k, v] of fd.entries()) (out[k] ??= []).push(v);
  return out;
}
function cartRec<S extends CartActionState | CartActionStateV2>(result: S | (() => S)) {
  const calls: Posted[] = [];
  const action = async (_p: S | null, fd: FormData): Promise<S> => {
    calls.push(entries(fd));
    return typeof result === "function" ? (result as () => S)() : result;
  };
  return { action, calls };
}
function listRec(result: ListActionState) {
  const calls: Posted[] = [];
  const action: ListActionFn = async (_p, fd) => {
    calls.push(entries(fd));
    return result;
  };
  return { action, calls };
}
function deferredV2() {
  const calls: Posted[] = [];
  const resolvers: ((s: CartActionStateV2) => void)[] = [];
  const action: CartActionFnV2 = (_p, fd) => {
    calls.push(entries(fd));
    return new Promise((res) => resolvers.push(res));
  };
  return { action, calls, resolve: (s: CartActionStateV2) => resolvers.shift()?.(s) };
}

const OK = ok({ itemCount: 1, subtotalCents: 100, message: "Updated" });
const noopCart = cartRec<CartActionState>(null).action as CartActionFn;
const noopV2 = cartRec<CartActionStateV2>(null).action as CartActionFnV2;
const noopList = listRec(null).action;

function line(n: number, over: Partial<CartTableLine> = {}): CartTableLine {
  return {
    productId: `qa-p${n}`,
    name: `QA Item ${n}`,
    slug: `qa-item-${n}`,
    imageUrl: `/images/qa-${n}.jpg`,
    quantity: 2,
    unitPriceCents: 1250,
    lineTotalCents: 2500,
    availableStock: 10,
    status: "ok",
    ...over,
  };
}
function cart(items: CartTableLine[], over: Partial<CartTableData> = {}): CartTableData {
  return { items, subtotalCents: 2500 * items.length, currency: "USD", itemCount: items.length * 2, canCheckout: true, ...over };
}
function product(n: number, over: Partial<Product> = {}): Product {
  return {
    id: `qa-s${n}`,
    slug: `qa-saved-${n}`,
    name: `QA Saved ${n}`,
    description: "",
    priceCents: 900,
    currency: "USD",
    imageUrl: `/images/s-${n}.jpg`,
    stock: 3,
    ...over,
  };
}
function saved(n: number, over: Partial<SavedForLaterLine> = {}): SavedForLaterLine {
  return {
    productId: `qa-s${n}`,
    product: product(n),
    quantityDesired: 1,
    available: true,
    priceCents: 900,
    priceDroppedByCents: null,
    addedAt: "2026-11-07T10:00:00.000Z",
    ...over,
  };
}
function savedActions(over: Partial<SavedForLaterActions> = {}): SavedForLaterActions {
  return { moveToCart: noopV2, removeSaved: noopList, ...over };
}
function table(over: Partial<CartTableProps> = {}) {
  return <CartTable cart={cart([line(1)])} updateQuantity={noopCart} removeItem={noopCart} {...over} />;
}
function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}
function lineEl(name: string): HTMLElement {
  const li = screen
    .getAllByRole("listitem")
    .find((el) => el.textContent?.includes(name) && el.querySelector("form"));
  if (!li) throw new Error(`no row for ${name}`);
  return li;
}

// ---------------------------------------------------------------------------
describe("T82.1 MVP test files kept (coverage never deleted)", () => {
  // T164: Phase 3 rule R5 lets implementers update existing tests (T161 restyled CartTable and
  // re-pinned its MVP tests), so the "untouched since 2026-11-07" mtime check is gone. The intent
  // (no MVP coverage deleted or skipped) is kept: the files exist, keep at least their test
  // counts at T161 hand-off, and contain no skip/todo/only.
  test("MVP CartTable/CartLineItem/AddToCartForm test files keep their tests (no skip/todo/only)", () => {
    const minimum: Record<string, number> = {
      "organisms/CartTable/CartTable.test.tsx": 17,
      "molecules/CartLineItem/CartLineItem.test.tsx": 17,
      "molecules/AddToCartForm/AddToCartForm.test.tsx": 12,
    };
    for (const [f, min] of Object.entries(minimum)) {
      expect(statSync(join(SRC, f)).isFile()).toBe(true);
      const src = readFileSync(join(SRC, f), "utf8");
      expect({ f, enough: (src.match(/^\s*test\(/gm)?.length ?? 0) >= min }).toEqual({ f, enough: true });
      expect({ f, skipped: /\b(test|it|describe)\.(skip|todo|only)\b/.test(src) }).toEqual({ f, skipped: false });
    }
  });
});

describe("T82 v2 defaults in CartTable", () => {
  test("lineTotal defaults to computed: visible 'Line total:' = unit x quantity (ignores inconsistent server value)", () => {
    render(table({ cart: cart([line(1, { unitPriceCents: 1999, quantity: 3, lineTotalCents: 1 })]) }));
    const row = lineEl("QA Item 1");
    expect(within(row).getByTestId("line-total-label")).toHaveTextContent("Line total:");
    expect(within(row).getByTestId("line-total")).toHaveTextContent(usd(5997));
  });

  test("name links to /products/<slug>; empty / whitespace slug -> plain text", () => {
    render(table({ cart: cart([line(1), line(2, { slug: "" }), line(3, { slug: "   " })]) }));
    expect(screen.getByRole("link", { name: "QA Item 1" })).toHaveAttribute("href", "/products/qa-item-1");
    expect(screen.queryByRole("link", { name: "QA Item 2" })).toBeNull();
    expect(screen.queryByRole("link", { name: "QA Item 3" })).toBeNull();
    expect(screen.getByText("QA Item 2")).toBeInTheDocument();
  });

  test("Remove / Save for later accessible names carry the product name (T82.5)", () => {
    render(table({ saveForLaterAction: noopV2 }));
    expect(screen.getByRole("button", { name: "Remove QA Item 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save for later: QA Item 1" })).toBeInTheDocument();
  });
});

describe("T82.4 computeLineTotalCents exact near 2^53; fallback on overflow", () => {
  test("exact values", () => {
    expect(computeLineTotalCents(Number.MAX_SAFE_INTEGER, 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(computeLineTotalCents(4503599627370495, 2)).toBe(9007199254740990);
    expect(computeLineTotalCents(3002399751580331, 3)).toBeNull(); // 9007199254740993 > 2^53 - 1
    expect(computeLineTotalCents(3002399751580330, 3)).toBe(9007199254740990);
    expect(computeLineTotalCents(1, 0)).toBe(0);
    expect(computeLineTotalCents(0, 99)).toBe(0);
  });

  test("overflow / invalid -> null", () => {
    expect(computeLineTotalCents(4503599627370496, 2)).toBeNull();
    expect(computeLineTotalCents(Number.MAX_SAFE_INTEGER, 2)).toBeNull();
    expect(computeLineTotalCents(Number.NaN, 1)).toBeNull();
    expect(computeLineTotalCents(-1, 1)).toBeNull();
    expect(computeLineTotalCents(1.5, 2)).toBeNull();
    expect(computeLineTotalCents(100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("rendering: exact large total; overflowing product falls back to the server lineTotalCents", () => {
    const big = 4503599627370495;
    const { unmount } = render(
      table({ cart: cart([line(1, { unitPriceCents: big, quantity: 2, lineTotalCents: 7 })], { subtotalCents: 0 }) }),
    );
    expect(within(lineEl("QA Item 1")).getByTestId("line-total")).toHaveTextContent(usd(9007199254740990));
    unmount();
    render(
      table({
        cart: cart([line(1, { unitPriceCents: 4503599627370496, quantity: 2, lineTotalCents: 123456 })], {
          subtotalCents: 0,
        }),
      }),
    );
    expect(within(lineEl("QA Item 1")).getByTestId("line-total")).toHaveTextContent(usd(123456));
  });
});

describe("T82.4 'You save $X' only for positive valid savings", () => {
  test("list > unit -> (list - unit) x billable quantity", () => {
    render(table({ cart: cart([line(1, { unitPriceCents: 1000, quantity: 3, listPriceCents: 1500 })]) }));
    expect(within(lineEl("QA Item 1")).getByTestId("line-savings")).toHaveTextContent(`You save ${usd(1500)}`);
  });

  for (const listPriceCents of [1000, 999, 0, -500, Number.NaN, 1500.5, null, undefined, Number.POSITIVE_INFINITY]) {
    test(`listPriceCents ${String(listPriceCents)} (unit 1000) -> no savings text`, () => {
      render(table({ cart: cart([line(1, { unitPriceCents: 1000, listPriceCents })]) }));
      expect(screen.queryByTestId("line-savings")).toBeNull();
      expect(document.body.textContent).not.toMatch(/You save/);
    });
  }

  test("unavailable line -> no savings; savings overflow -> none", () => {
    render(
      table({
        cart: cart([
          line(1, { status: "unavailable", listPriceCents: 5000 }),
          line(2, { unitPriceCents: 1, listPriceCents: Number.MAX_SAFE_INTEGER, quantity: 2 }),
        ]),
      }),
    );
    expect(screen.queryByTestId("line-savings")).toBeNull();
    expect(computeLineSavingsCents(1, Number.MAX_SAFE_INTEGER, 2)).toBeNull();
    expect(computeLineSavingsCents(1000, 900, 1)).toBeNull();
  });
});

describe("T82.2 Save for later form", () => {
  test("separate native form posting exactly productId; aria-label 'Save for later: <name>'", async () => {
    const save = cartRec<CartActionStateV2>(OK);
    render(table({ saveForLaterAction: save.action as CartActionFnV2 }));
    const btn = screen.getByRole("button", { name: "Save for later: QA Item 1" });
    const form = btn.closest("form") as HTMLFormElement;
    expect(form.querySelectorAll("[name]")).toHaveLength(1);
    fireEvent.click(btn);
    await waitFor(() => expect(save.calls).toHaveLength(1));
    expect(save.calls[0]).toEqual({ productId: ["qa-p1"] });
  });

  test("pending: spinner/aria-busy on the button and the row; repeat click swallowed", async () => {
    const save = deferredV2();
    render(table({ saveForLaterAction: save.action }));
    const btn = screen.getByRole("button", { name: "Save for later: QA Item 1" });
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
    expect(btn.querySelector("svg, [role=status], [class*=animate-spin]")).not.toBeNull();
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 20));
    expect(save.calls).toHaveLength(1);
    await act(async () => save.resolve(fail("OUT_OF_STOCK", "Could not save.")));
    expect(await within(lineEl("QA Item 1")).findByRole("alert")).toHaveTextContent("Could not save.");
  });

  test("error shows in the failing row's alert only", async () => {
    const save = cartRec<CartActionStateV2>(fail("INTERNAL_ERROR", "Save failed."));
    render(table({ cart: cart([line(1), line(2)]), saveForLaterAction: save.action as CartActionFnV2 }));
    fireEvent.click(screen.getByRole("button", { name: "Save for later: QA Item 2" }));
    expect(await within(lineEl("QA Item 2")).findByRole("alert")).toHaveTextContent("Save failed.");
    expect(within(lineEl("QA Item 1")).queryByRole("alert")).toBeNull();
  });

  test("DEFECT D-T82-1: the row shows the Save-for-later error after an earlier update error", async () => {
    const update = cartRec<CartActionState>(fail("INSUFFICIENT_STOCK", "Update failed."));
    const save = cartRec<CartActionStateV2>(fail("INTERNAL_ERROR", "Save failed."));
    render(
      table({ updateQuantity: update.action as CartActionFn, saveForLaterAction: save.action as CartActionFnV2 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Update quantity for QA Item 1" }));
    await within(lineEl("QA Item 1")).findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Save for later: QA Item 1" }));
    await waitFor(() => expect(within(lineEl("QA Item 1")).getByRole("alert")).toHaveTextContent("Save failed."), {
      timeout: 300,
    });
  });
});

describe("T82.3 Saved-for-later section", () => {
  test("no items -> no section/heading/forms, but the polite live region stays (also via CartTable)", () => {
    const html = renderToStaticMarkup(table({ saved: { items: [], listId: "L", actions: savedActions() } }));
    const doc = parse(html);
    expect(doc.body.textContent).not.toMatch(/Saved for later \(/);
    const live = doc.querySelector('[data-testid="saved-live-region"]');
    expect(live?.getAttribute("aria-live")).toBe("polite");
    // Only the cart line forms (update + remove).
    expect(doc.querySelectorAll("form")).toHaveLength(2);
  });

  test("going from 1 item to 0 announces it; section disappears", () => {
    const { rerender } = render(
      <SavedForLaterSection items={[saved(1)]} actions={savedActions()} saveForLaterListId="L" />,
    );
    expect(screen.getByRole("region", { name: "Saved for later (1 item)" })).toBeInTheDocument();
    rerender(<SavedForLaterSection items={[]} actions={savedActions()} saveForLaterListId="L" />);
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByTestId("saved-live-region")).toHaveTextContent("Saved for later is empty");
  });

  test("row: thumbnail (alt = name), name link, Price, availability text", () => {
    render(<SavedForLaterSection items={[saved(1), saved(2)]} actions={savedActions()} saveForLaterListId="L" />);
    const region = screen.getByRole("region", { name: "Saved for later (2 items)" });
    const rows = within(region).getAllByRole("listitem");
    const first = rows[0] as HTMLElement;
    expect(within(first).getByRole("img", { name: "QA Saved 1" })).toBeInTheDocument();
    expect(within(first).getByRole("link", { name: "QA Saved 1" })).toHaveAttribute("href", "/products/qa-saved-1");
    expect(first.textContent).toContain(usd(900));
    expect(within(first).getByTestId("saved-availability")).toHaveTextContent("In stock");
  });

  test("availability texts: In stock / Out of stock / No longer available", () => {
    render(
      <SavedForLaterSection
        items={[saved(1), saved(2, { available: false }), saved(3, { product: null, priceCents: null, available: false })]}
        actions={savedActions()}
        saveForLaterListId="L"
      />,
    );
    expect(screen.getAllByTestId("saved-availability").map((e) => e.textContent)).toEqual([
      "In stock",
      "Out of stock",
      "No longer available",
    ]);
  });

  test("'Price dropped by $X' only for positive valid cents", () => {
    const cases: [number | null, boolean][] = [
      [150, true],
      [0, false],
      [-150, false],
      [Number.NaN, false],
      [1.5, false],
      [null, false],
      [Number.MAX_SAFE_INTEGER + 2, false],
    ];
    for (const [drop, shown] of cases) {
      const html = renderToStaticMarkup(
        <SavedForLaterSection items={[saved(1, { priceDroppedByCents: drop })]} actions={savedActions()} saveForLaterListId="L" />,
      );
      expect(html.includes("Price dropped by")).toBe(shown);
      if (shown) expect(html).toContain(`Price dropped by ${usd(150)}`);
    }
  });

  for (const [label, over] of [
    ["out of stock", { available: false }],
    ["vanished", { product: null, priceCents: null, available: false }],
  ] as const) {
    test(`Move to cart disabled + aria-describedby -> availability text (${label})`, () => {
      render(<SavedForLaterSection items={[saved(1, over)]} actions={savedActions()} saveForLaterListId="L" />);
      const row = screen.getAllByRole("listitem")[0] as HTMLElement;
      const btn = within(row).getAllByRole("button")[0] as HTMLButtonElement;
      expect(btn).toBeDisabled();
      const describedBy = btn.getAttribute("aria-describedby") ?? "";
      expect(describedBy).not.toBe("");
      expect(document.getElementById(describedBy)?.textContent).toMatch(/Out of stock|No longer available/);
    });
  }

  test("Move to cart posts exactly productId; Delete posts exactly listId + productId", async () => {
    const move = cartRec<CartActionStateV2>(OK);
    const del = listRec({ ok: true, kind: "removed", message: "Removed" });
    render(
      <SavedForLaterSection
        items={[saved(1)]}
        actions={savedActions({ moveToCart: move.action as CartActionFnV2, removeSaved: del.action })}
        saveForLaterListId="list-sfl"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Move to cart.*QA Saved 1/ }));
    fireEvent.click(screen.getByRole("button", { name: /Delete.*QA Saved 1/ }));
    await waitFor(() => expect(move.calls).toHaveLength(1));
    await waitFor(() => expect(del.calls).toHaveLength(1));
    expect(move.calls[0]).toEqual({ productId: ["qa-s1"] });
    expect(del.calls[0]).toEqual({ listId: ["list-sfl"], productId: ["qa-s1"] });
  });

  test("Delete hidden when saveForLaterListId is null", () => {
    render(<SavedForLaterSection items={[saved(1)]} actions={savedActions()} saveForLaterListId={null} />);
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Move to cart/ })).toBeInTheDocument();
  });

  test("move / delete errors are per row", async () => {
    const move = cartRec<CartActionStateV2>(fail("OUT_OF_STOCK", "That item is out of stock."));
    const del = listRec({ ok: false, error: { code: "NOT_FOUND", message: "Gone." }, message: "Gone." });
    render(
      <SavedForLaterSection
        items={[saved(1), saved(2)]}
        actions={savedActions({ moveToCart: move.action as CartActionFnV2, removeSaved: del.action })}
        saveForLaterListId="L"
      />,
    );
    const [r1, r2] = screen.getAllByRole("listitem") as HTMLElement[];
    fireEvent.click(within(r1 as HTMLElement).getByRole("button", { name: /Move to cart/ }));
    expect(await within(r1 as HTMLElement).findByTestId("saved-move-error")).toHaveTextContent("That item is out of stock.");
    expect(within(r2 as HTMLElement).queryByRole("alert")).toBeNull();
    fireEvent.click(within(r2 as HTMLElement).getByRole("button", { name: /Delete/ }));
    expect(await within(r2 as HTMLElement).findByTestId("saved-remove-error")).toHaveTextContent("Gone.");
    expect(within(r1 as HTMLElement).queryByTestId("saved-remove-error")).toBeNull();
  });

  test("forged fields ignored: every saved/cart form posts only its contract fields", () => {
    const html = renderToStaticMarkup(
      table({
        saveForLaterAction: noopV2,
        saved: { items: [saved(1)], listId: "L", actions: savedActions({ addToList: noopList }) },
      }),
    );
    const doc = parse(html);
    const allowed = new Set(["productId", "quantity", "listId", "productSlug"]);
    for (const f of doc.querySelectorAll("form")) {
      for (const el of f.querySelectorAll("[name]")) expect(allowed.has(el.getAttribute("name") ?? "")).toBe(true);
    }
    expect(doc.querySelectorAll('[name*="price" i], [name*="session" i], [name*="total" i]')).toHaveLength(0);
  });
});

describe("T82.1 checkout link only when canCheckout && every line ok", () => {
  const cases: [boolean, CartTableLine["status"][], boolean][] = [
    [true, ["ok", "ok"], true],
    [false, ["ok"], false],
    [true, ["ok", "reduced"], false],
    [true, ["unavailable"], false],
    [false, ["reduced"], false],
  ];
  for (const [canCheckout, statuses, shown] of cases) {
    test(`canCheckout=${canCheckout} statuses=${statuses.join(",")} -> ${shown ? "link" : "no link"}`, () => {
      render(table({ cart: cart(statuses.map((status, i) => line(i + 1, { status })), { canCheckout }) }));
      expect(screen.queryByRole("link", { name: "Proceed to checkout" }) !== null).toBe(shown);
    });
  }

  test("saved items never enable checkout of an empty cart", () => {
    render(table({ cart: cart([], { canCheckout: true }), saved: { items: [saved(1)], listId: "L", actions: savedActions() } }));
    expect(screen.queryByRole("link", { name: "Proceed to checkout" })).toBeNull();
    expect(screen.getByText("Your cart is empty")).toBeInTheDocument();
  });
});

describe("T82 structure, hostile text, hrefs, 320px", () => {
  const full = () =>
    renderToStaticMarkup(
      table({
        cart: cart([line(1, { name: HOSTILE }), line(2)]),
        saveForLaterAction: noopV2,
        thumbnails: true,
        saved: {
          items: [saved(1, { product: product(1, { name: HOSTILE }) }), saved(2, { product: null, priceCents: null, available: false })],
          listId: "L",
          actions: savedActions({ addToList: noopList }),
        },
      }),
    );

  test("no nested forms; every form has a hidden productId", () => {
    const doc = parse(full());
    expect(doc.querySelectorAll("form form")).toHaveLength(0);
    for (const f of doc.querySelectorAll("form")) expect(f.querySelector('input[type="hidden"][name="productId"]')).not.toBeNull();
  });

  test("hostile names render as text (content and accessible names)", () => {
    const doc = parse(full());
    expect(doc.querySelector("img[src=x]")).toBeNull();
    for (const s of doc.querySelectorAll("script")) expect(s.textContent).not.toContain("alert(2)");
    expect(doc.body.textContent).toContain(HOSTILE);
    expect([...doc.querySelectorAll("[aria-label]")].some((e) => e.getAttribute("aria-label") === `Remove ${HOSTILE}`)).toBe(true);
    expect(
      [...doc.querySelectorAll("[aria-label]")].some((e) => e.getAttribute("aria-label") === `Save for later: ${HOSTILE}`),
    ).toBe(true);
  });

  test("landmarks: one 'Cart summary' region and one saved region; ids unique", () => {
    const doc = parse(full());
    expect(doc.querySelectorAll('section[aria-label="Cart summary"]')).toHaveLength(1);
    expect(doc.querySelectorAll("section[aria-labelledby]")).toHaveLength(1);
    const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every href with ordinary slugs passes isAllowedInternalHref", () => {
    const doc = parse(full());
    for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("DEFECT D-T82-2: cart/saved name links only render hrefs that pass isAllowedInternalHref", () => {
    const doc = parse(
      renderToStaticMarkup(
        table({
          cart: cart([line(1, { slug: ".." })]),
          saved: { items: [saved(1, { product: product(1, { slug: "." }) })], listId: "L", actions: savedActions() },
        }),
      ),
    );
    for (const a of doc.querySelectorAll("a[href]")) expect(isAllowedInternalHref(a.getAttribute("href") ?? "")).toBe(true);
  });

  test("320px: no fixed widths without a breakpoint, no inline style props in sources", () => {
    for (const file of [
      "organisms/CartTable/CartTable.tsx",
      "organisms/CartTable/SavedForLaterSection.tsx",
      "molecules/CartLineItem/CartLineItem.tsx",
    ]) {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src).not.toMatch(/\bstyle=\{/);
      expect(src).not.toMatch(/(?<![a-z]:)\b(?:w|min-w)-(?:\d{2,}|\[)/);
    }
    const doc = parse(full());
    for (const li of doc.querySelectorAll("li")) expect(li.className).toContain("min-w-0");
  });
});

// ---------------------------------------------------------------------------
// Resume rulings: hideSummary (T108), R-CART-1, no-JS POST shape, 44px targets, unique names.
let refSeq = 0;
/** Mimics a Next server reference as React SSR sees it (`$$FORM_ACTION`, kept across `.bind`). */
function serverLike<T>(): T {
  const id = ++refSeq;
  const fields = () => ({ name: `$ACTION_REF_${id}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  const make = (): unknown => Object.assign(async () => null, { $$FORM_ACTION: fields, bind: () => make() });
  return make() as T;
}
const TOUCH = /\b(?:min-h-touch|size-touch|min-h-12)\b/;
function serverTable(over: Partial<CartTableProps> = {}) {
  return (
    <CartTable
      cart={cart([line(1), line(2, { listPriceCents: 2000 })])}
      updateQuantity={serverLike<CartActionFn>()}
      removeItem={serverLike<CartActionFn>()}
      saveForLaterAction={serverLike<CartActionFnV2>()}
      thumbnails
      saved={{
        items: [saved(1), saved(2, { available: false })],
        listId: "list-sfl",
        actions: {
          moveToCart: serverLike<CartActionFnV2>(),
          removeSaved: serverLike<ListActionFn>(),
          addToList: serverLike<ListActionFn>(),
        },
      }}
      {...over}
    />
  );
}

describe("Resume: hideSummary (T108)", () => {
  test("hideSummary: no summary region, subtotal, warning, checkout or continue link; lines + saved still render", () => {
    const d = parse(
      renderToStaticMarkup(serverTable({ hideSummary: true, cart: cart([line(1), line(2, { status: "reduced", availableStock: 1 })]) })),
    );
    expect(d.querySelector('section[aria-label="Cart summary"]')).toBeNull();
    expect(d.body.textContent).not.toMatch(/Subtotal|Estimated total|Proceed to checkout|Continue shopping|Adjust the highlighted/);
    expect(d.querySelectorAll('ul[role="list"] > li').length).toBeGreaterThanOrEqual(4);
    expect(d.body.textContent).toContain("Saved for later (2 items)");
    expect(d.querySelector('[data-testid="cart-live-region"]')).not.toBeNull();
  });

  test("default (hideSummary omitted / false) keeps the summary and checkout link", () => {
    for (const hideSummary of [undefined, false]) {
      const d = parse(renderToStaticMarkup(serverTable({ hideSummary })));
      expect(d.querySelectorAll('section[aria-label="Cart summary"]')).toHaveLength(1);
      expect([...d.querySelectorAll("a")].some((a) => a.textContent === "Proceed to checkout")).toBe(true);
    }
  });

  test("hideSummary on an empty cart still shows the empty state", () => {
    const d = parse(renderToStaticMarkup(serverTable({ hideSummary: true, cart: cart([], { canCheckout: false }) })));
    expect(d.body.textContent).toContain("Your cart is empty");
  });
});

describe("Resume: R-CART-1 later-unpublished line (service sends status unavailable, slug '', zero totals)", () => {
  const unpublished = line(1, { name: "Withdrawn item", slug: "", status: "unavailable", unitPriceCents: 0, lineTotalCents: 0, availableStock: 0, listPriceCents: 5000 });

  test("no product link, 'No longer available', $0.00 line total, no savings, no checkout", () => {
    render(table({ cart: cart([unpublished, line(2)], { canCheckout: false, subtotalCents: 2500 }) }));
    expect(screen.queryByRole("link", { name: "Withdrawn item" })).toBeNull();
    const row = lineEl("Withdrawn item");
    expect(row.textContent).toContain("No longer available");
    expect(within(row).getByTestId("line-total")).toHaveTextContent(usd(0));
    expect(within(row).queryByTestId("line-savings")).toBeNull();
    expect(screen.queryByRole("link", { name: "Proceed to checkout" })).toBeNull();
    expect(document.body.textContent).toContain("Remove unavailable items to continue to checkout");
    expect(row.querySelector("a[href]")).toBeNull();
  });

  test("even with a stale canCheckout=true the unavailable line blocks checkout", () => {
    render(table({ cart: cart([unpublished], { canCheckout: true }) }));
    expect(screen.queryByRole("link", { name: "Proceed to checkout" })).toBeNull();
  });
});

describe("Resume: every mutation is a real POST form without JS ($$FORM_ACTION fixture)", () => {
  test("update / save / remove / move / delete / add-to-list forms: method=POST, multipart, no javascript:", () => {
    const d = parse(renderToStaticMarkup(serverTable()));
    const forms = [...d.querySelectorAll("form")];
    // 2 lines x (update, save, remove) + saved: 2 x move + 2 x delete + 1 add-to-list (available row only... both rows have a product)
    expect(forms.length).toBeGreaterThanOrEqual(10);
    for (const f of forms) {
      expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(f.getAttribute("enctype")).toBe("multipart/form-data");
      expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
      expect([...f.querySelectorAll("[name]")].some((e) => /^\$ACTION_REF_/.test(e.getAttribute("name") ?? ""))).toBe(true);
    }
  });

  test(".bind(null, null) actions keep the POST shape", () => {
    const d = parse(
      renderToStaticMarkup(
        serverTable({ removeItem: serverLike<CartActionFn>().bind(null, null) as unknown as CartActionFn }),
      ),
    );
    for (const f of d.querySelectorAll("form")) expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
  });
});

describe("Resume: a11y basics", () => {
  test("button accessible names are unique per product (Remove / Save / Move / Delete / Update)", () => {
    const d = parse(renderToStaticMarkup(serverTable()));
    const names = [...d.querySelectorAll('button[type="submit"]')].map(
      (b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/QA (Item|Saved) \d/);
  });

  test("quantity inputs labelled with the product name; headings h2 for cart items and saved section", () => {
    render(serverTable());
    expect(screen.getByRole("textbox", { name: "Quantity for QA Item 1" })).toHaveAttribute("name", "quantity");
    expect(screen.getByRole("heading", { level: 2, name: "Cart items" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Saved for later (2 items)" })).toBeInTheDocument();
  });

  test("all buttons and controls meet 44px (non-link)", () => {
    const d = parse(renderToStaticMarkup(serverTable()));
    for (const el of d.querySelectorAll("button, summary, input:not([type=hidden]), select")) {
      const cls = `${el.getAttribute("class") ?? ""} ${el.closest("label")?.getAttribute("class") ?? ""}`;
      expect([el.tagName, el.textContent?.slice(0, 25), TOUCH.test(cls)]).toEqual([el.tagName, el.textContent?.slice(0, 25), true]);
    }
  });

  test("DEFECT D-T82-3: every link in CartTable (incl. product-name links) has a 44px target (SR6)", () => {
    const d = parse(renderToStaticMarkup(serverTable()));
    for (const a of d.querySelectorAll("a")) expect(TOUCH.test(a.getAttribute("class") ?? "")).toBe(true);
  });

  test("no session ids / owner keys / UUIDs in cart markup", () => {
    const html = renderToStaticMarkup(serverTable());
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(html).not.toMatch(/sessionId|ownerKey|owner_key|sf_session|sf_auth/i);
  });
});
