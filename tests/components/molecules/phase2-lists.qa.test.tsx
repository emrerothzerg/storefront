// QA (QA-W3-molecules-C): T60 WishlistButton, ListItemRow, ShareListPanel
// (+ list-error-message, list-item-validation). Criteria: BACKLOG-phase2.md "### T60",
// standing rules SR2/SR3/SR6, contract _contracts/list-actions.ts, ruling R-T48-1.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appError } from "@/lib/result";
import type { ErrorCode, Product } from "@/lib/types";
import type { ListItemView } from "@/server/lists/list-service";
import { isAllowedInternalHref } from "@/content/routes";
import {
  LIST_FIELD,
  LIST_INPUT_LIMITS,
  type ListActionFn,
  type ListActionState,
} from "@/components/molecules/_contracts/list-actions";
import { WishlistButton, wishlistLabel, listErrorMessage } from "@/components/molecules/WishlistButton";
import { ListItemRow } from "@/components/molecules/ListItemRow";
import {
  validateNote,
  validatePriority,
  validateQuantity,
} from "@/components/molecules/ListItemRow/list-item-validation";
import { ShareListPanel } from "@/components/molecules/ShareListPanel";
import { expectFocused, expectNull } from "@/test/dom-assertions";

// ---------------------------------------------------------------- helpers

type Fields = Record<string, string>;

function snapshot(fd: FormData): Fields {
  const out: Fields = {};
  fd.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}
function userKeys(f: Fields): string[] {
  return Object.keys(f)
    .filter((k) => !k.startsWith("$ACTION"))
    .sort();
}
function scripted(steps: readonly ListActionState[], fallback: ListActionState = null) {
  const calls: Fields[] = [];
  const action: ListActionFn = async (_prev, fd) => {
    calls.push(snapshot(fd));
    return steps[calls.length - 1] ?? fallback;
  };
  return { action, calls };
}
function gated() {
  const calls: Fields[] = [];
  const resolvers: Array<(s: ListActionState) => void> = [];
  const action: ListActionFn = (_prev, fd) => {
    calls.push(snapshot(fd));
    return new Promise<ListActionState>((res) => resolvers.push(res));
  };
  const release = async (s: ListActionState) => {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        resolvers.splice(0).forEach((r) => r(s));
        await new Promise((r) => setTimeout(r, 5));
      });
      if (resolvers.length === 0 && i > 2) break;
    }
  };
  return { action, calls, release };
}
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}
function fail(code: ErrorCode, message: string, extra: Partial<Record<"retryAfterSeconds", number>> & { fieldErrors?: Record<string, string> } = {}): ListActionState {
  return { ok: false, error: appError(code, message), message, ...extra };
}
/** Strip React's form-replay bootstrap script (React adds it for function form actions). */
function stripReplay(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (s) => (s.includes("requestFormReset") || s.includes("$$reactFormReplay") || s.includes("addEventListener(\"submit\"") ? "" : s));
}
function countNestedForms(root: ParentNode): number {
  return root.querySelectorAll("form form").length;
}

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
const RTL = "\u202Eمرحبا שלום";
const ZW = "Oak\u200B\u200DDesk\uFEFF";
const LONG_WORD = "W".repeat(10_000);
const noop: ListActionFn = async () => null;

const ROOT = join(import.meta.dir, "../../../src/components/molecules");
const FILES = [
  "WishlistButton/WishlistButton.tsx",
  "WishlistButton/list-error-message.ts",
  "ListItemRow/ListItemRow.tsx",
  "ListItemRow/list-item-validation.ts",
  "ShareListPanel/ShareListPanel.tsx",
];

// ---------------------------------------------------------------- grep gates

describe("T60 source gates", () => {
  for (const file of FILES) {
    test(`${file}: no any / ts-ignore / ts-expect-error / eslint-disable / dangerouslySetInnerHTML / style= / runtime server import`, () => {
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src).not.toMatch(/:\s*any\b|<any>|as any\b|any\[\]/);
      expect(src).not.toMatch(/@ts-(ignore|expect-error|nocheck)/);
      expect(src).not.toContain("eslint-disable");
      expect(src).not.toContain("dangerouslySetInnerHTML");
      expect(src).not.toMatch(/\bstyle=/);
      for (const line of src.split("\n").filter((l) => /from ["']@\/server\//.test(l))) {
        expect(line).toMatch(/^import type /);
      }
    });
  }
});

// ---------------------------------------------------------------- list-error-message

describe("listErrorMessage (shared by T60 molecules)", () => {
  const cases: Array<[number | undefined, string]> = [
    [61, "Too many requests. Please try again in 2 minutes."],
    [60, "Too many requests. Please try again in 1 minute."],
    [1, "Too many requests. Please try again in 1 minute."],
    [3600, "Too many requests. Please try again in 60 minutes."],
    [3601, "Too many requests. Please try again in 61 minutes."],
  ];
  for (const [seconds, want] of cases) {
    test(`RATE_LIMITED retryAfterSeconds=${seconds} -> "${want}"`, () => {
      const s = fail("RATE_LIMITED", "server text", { retryAfterSeconds: seconds });
      expect(listErrorMessage(s as Extract<NonNullable<ListActionState>, { ok: false }>)).toBe(want);
    });
  }
  for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    test(`RATE_LIMITED retryAfterSeconds=${String(bad)} -> generic "later" text, never NaN/0/Infinity`, () => {
      const s: ListActionState = { ok: false, error: appError("RATE_LIMITED", "x"), message: "x", ...(bad === undefined ? {} : { retryAfterSeconds: bad }) };
      const text = listErrorMessage(s as Extract<NonNullable<ListActionState>, { ok: false }>);
      expect(text).toBe("Too many requests. Please try again later.");
      expect(text).not.toMatch(/NaN|Infinity|\b0 minute/);
    });
  }
  for (const code of ["NOT_FOUND", "PRODUCT_NOT_FOUND", "LIMIT_REACHED", "FORBIDDEN", "INVALID_INPUT", "INVALID_QUANTITY", "VALIDATION_FAILED", "TOO_LONG"] as ErrorCode[]) {
    test(`${code}: verbatim user-safe server message; blank -> generic`, () => {
      const s = fail(code, `  msg for ${code}  `) as Extract<NonNullable<ListActionState>, { ok: false }>;
      expect(listErrorMessage(s)).toBe(`msg for ${code}`);
      const blank = fail(code, "   ") as Extract<NonNullable<ListActionState>, { ok: false }>;
      expect(listErrorMessage(blank)).toBe("Something went wrong. Please try again.");
    });
  }
});

// ---------------------------------------------------------------- WishlistButton

function renderWishlist(over: Partial<Parameters<typeof WishlistButton>[0]> = {}, add: ListActionFn = noop, remove: ListActionFn = noop) {
  return render(
    <WishlistButton
      productId="p1"
      productSlug="oak-desk"
      productName="Oak Desk"
      inList={false}
      addAction={add}
      removeAction={remove}
      {...over}
    />,
  );
}
const heart = () => screen.getByRole("button", { name: /Wish List/ });

describe("T60 AC1 WishlistButton: no-JS form, aria-pressed, label, 44px", () => {
  test("static markup: exactly one form, contract hidden fields, aria-pressed=false, no script, no nested form", () => {
    const html = stripReplay(
      renderToStaticMarkup(
        <WishlistButton productId="p1" productSlug="oak-desk" productName="Oak Desk" inList={false} addAction={noop} removeAction={noop} />,
      ),
    );
    expect(html.match(/<form/g)?.length).toBe(1);
    expect(html).not.toContain("<script");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(countNestedForms(doc)).toBe(0);
    const hidden = Array.from(doc.querySelectorAll('input[type="hidden"]')).map((i) => [i.getAttribute("name"), i.getAttribute("value")]);
    expect(hidden).toEqual([
      [LIST_FIELD.productId, "p1"],
      [LIST_FIELD.productSlug, "oak-desk"],
      [LIST_FIELD.listId, ""],
    ]);
    const btn = doc.querySelector("button")!;
    expect(btn.getAttribute("type")).toBe("submit");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Add Oak Desk to Wish List");
    expect(btn.className).toMatch(/size-touch|min-h-touch/);
  });

  test("static markup inList: aria-pressed=true, 'Remove … from Wish List', hidden listId = given list", () => {
    const html = renderToStaticMarkup(
      <WishlistButton productId="p1" productSlug="oak-desk" productName="Oak Desk" inList listId="L7" addAction={noop} removeAction={noop} />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const btn = doc.querySelector("button")!;
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    expect(btn.getAttribute("aria-label")).toBe("Remove Oak Desk from Wish List");
    expect(doc.querySelector(`input[name="${LIST_FIELD.listId}"]`)!.getAttribute("value")).toBe("L7");
  });

  test("variant=button: native submit, aria-pressed, accessible name includes product, 44px", () => {
    renderWishlist({ variant: "button" });
    const btn = heart();
    expect(btn).toHaveAttribute("type", "submit");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAccessibleName(/Add\s+Oak Desk\s+to Wish List/);
    expect(btn.className).toMatch(/min-h-touch/);
  });

  for (const size of ["sm", "md", "lg"] as const) {
    test(`size=${size} keeps >= 44px target`, () => {
      renderWishlist({ size });
      expect(heart().className).toMatch(/size-touch|size-12|min-h-touch/);
    });
  }

  test("posts ONLY contract fields (productId, productSlug, listId)", async () => {
    const add = scripted([{ ok: true, kind: "added", message: "ok", listId: "L1" }]);
    renderWishlist({}, add.action);
    fireEvent.click(heart());
    await flush();
    expect(add.calls).toHaveLength(1);
    expect(userKeys(add.calls[0]!)).toEqual(["listId", "productId", "productSlug"]);
    expect(add.calls[0]).toMatchObject({ productId: "p1", productSlug: "oak-desk", listId: "" });
  });

  test("picker: 'Save to' select (name=listId) lists exactly the given lists, label associated, no duplicate listId", async () => {
    const add = scripted([{ ok: true, kind: "added", message: "ok", listId: "B" }]);
    const { container } = renderWishlist({ lists: [{ id: "A", name: "Wish List" }, { id: "B", name: "Birthday" }] }, add.action);
    const select = screen.getByLabelText("Save to") as HTMLSelectElement;
    expect(select.name).toBe(LIST_FIELD.listId);
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["A", "B"]);
    expect(container.querySelectorAll(`[name="${LIST_FIELD.listId}"]`)).toHaveLength(1);
    fireEvent.change(select, { target: { value: "B" } });
    fireEvent.click(heart());
    await flush();
    expect(add.calls[0]!.listId).toBe("B");
  });

  test("R-T48-1 kind 'added': pressed + polite 'Added to your Wish List'; next click removes from the server's listId", async () => {
    const add = scripted([{ ok: true, kind: "added", message: "x", listId: "L9" }]);
    const remove = scripted([{ ok: true, kind: "removed", message: "y", listId: "L9" }]);
    renderWishlist({}, add.action, remove.action);
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute("aria-pressed", "true"));
    const live = screen.getByTestId("wishlist-status");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveTextContent("Added to your Wish List");
    expect(heart()).toHaveAccessibleName("Remove Oak Desk from Wish List");
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute("aria-pressed", "false"));
    expect(remove.calls).toHaveLength(1);
    expect(remove.calls[0]).toMatchObject({ listId: "L9", productId: "p1" });
    expect(live).toHaveTextContent("Removed from your Wish List");
  });

  test("R-T48-1 kind 'already_present': pressed + 'Already in your Wish List' (no error)", async () => {
    const add = scripted([{ ok: true, kind: "already_present", message: "x", listId: "L1" }]);
    renderWishlist({}, add.action);
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("wishlist-status")).toHaveTextContent("Already in your Wish List");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  const errorCases: Array<[string, ListActionState, string]> = [
    ["RATE_LIMITED 61s", fail("RATE_LIMITED", "slow", { retryAfterSeconds: 61 }), "Too many requests. Please try again in 2 minutes."],
    ["RATE_LIMITED 60s", fail("RATE_LIMITED", "slow", { retryAfterSeconds: 60 }), "Too many requests. Please try again in 1 minute."],
    ["NOT_FOUND", fail("NOT_FOUND", "That list was not found."), "That list was not found."],
    ["PRODUCT_NOT_FOUND", fail("PRODUCT_NOT_FOUND", "That product is no longer available."), "That product is no longer available."],
    ["LIMIT_REACHED", fail("LIMIT_REACHED", "This list is full (200 items)."), "This list is full (200 items)."],
    ["VALIDATION_FAILED unexpected", fail("VALIDATION_FAILED", "Something went wrong."), "Something went wrong."],
    ["hostile message", fail("INVALID_INPUT", HOSTILE), HOSTILE],
  ];
  for (const [label, state, text] of errorCases) {
    test(`error ${label}: role=alert text, state unchanged (not pressed)`, async () => {
      const add = scripted([state]);
      const { container } = renderWishlist({}, add.action);
      fireEvent.click(heart());
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(text);
      expect(heart()).toHaveAttribute("aria-pressed", "false");
      expect(container.querySelector("img, script")).toBeNull();
    });
  }

  test("pending: aria-busy on the button; 5 rapid clicks -> 1 call", async () => {
    const g = gated();
    try {
      renderWishlist({}, g.action);
      const btn = heart();
      fireEvent.click(btn);
      await waitFor(() => expect(heart()).toHaveAttribute("aria-busy", "true"));
      for (let i = 0; i < 4; i++) fireEvent.click(heart());
      await flush();
      expect(g.calls).toHaveLength(1);
    } finally {
      await g.release({ ok: true, kind: "added", message: "x", listId: "L1" });
    }
  });

  test("hostile / RTL / zero-width / 10k-char product names: text only in the label, layout-safe wrapper", () => {
    for (const name of [HOSTILE, RTL, ZW, LONG_WORD]) {
      const { container, unmount } = renderWishlist({ productName: name, variant: "button" });
      expect(container.querySelector("img, script")).toBeNull();
      expect(heart().textContent).toContain(name.trim());
      expect(container.querySelector("form")!.className).toMatch(/min-w-0/);
      unmount();
    }
    expect(wishlistLabel(HOSTILE, false)).toBe(`Add ${HOSTILE} to Wish List`);
  });

  test("blank product name falls back to 'this item'", () => {
    expect(wishlistLabel("   ", false)).toBe("Add this item to Wish List");
    expect(wishlistLabel("", true)).toBe("Remove this item from Wish List");
  });

  test("AC5 keyboard: the toggle is a native, focusable submit button (Enter/Space handled by the browser)", () => {
    renderWishlist();
    const btn = heart();
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).not.toHaveAttribute("tabindex", "-1");
    btn.focus();
    expectFocused(btn);
  });
});

// ---------------------------------------------------------------- ListItemRow

const product: Product = {
  id: "p1",
  slug: "oak-desk",
  name: "Oak Desk",
  description: "A desk",
  priceCents: 19900,
  currency: "USD",
  imageUrl: "/images/products/oak-desk.svg",
  stock: 4,
};
function item(over: Partial<ListItemView> = {}): ListItemView {
  return {
    listId: "L1",
    productId: "p1",
    quantityDesired: 1,
    priority: 1,
    priceAtAddCents: 19900,
    note: null,
    addedAt: "2026-11-01T00:00:00.000Z",
    product,
    priceDroppedByCents: null,
    purchasedSinceAdded: false,
    available: true,
    ...over,
  };
}
interface RowActions {
  update?: ListActionFn;
  remove?: ListActionFn;
  move?: ListActionFn;
  addToCart?: (fd: FormData) => Promise<void>;
}
function renderRow(over: Partial<Parameters<typeof ListItemRow>[0]> = {}, a: RowActions = {}) {
  return render(
    <ul>
      <ListItemRow
        item={item()}
        listId="L1"
        otherLists={[{ id: "L2", name: "Birthday" }]}
        actions={{ update: a.update ?? noop, remove: a.remove ?? noop, move: a.move ?? noop, addToCart: a.addToCart ?? (async () => {}) }}
        {...over}
      />
    </ul>,
  );
}
const qtyInput = () => screen.getByLabelText(/Quantity wanted/) as HTMLInputElement;
const saveBtn = () => screen.getByRole("button", { name: /Save changes to/ });

describe("T60 ListItemRow static markup and contract", () => {
  test("4 real forms (update, add-to-cart, move, delete), no nested form, no script, hidden fields per contract", () => {
    const html = stripReplay(
      renderToStaticMarkup(
        <ListItemRow
          item={item()}
          listId="L1"
          otherLists={[{ id: "L2", name: "Birthday" }]}
          actions={{ update: noop, remove: noop, move: noop, addToCart: async () => {} }}
        />,
      ),
    );
    expect(html).not.toContain("<script");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const forms = Array.from(doc.querySelectorAll("form"));
    expect(forms).toHaveLength(4);
    expect(countNestedForms(doc)).toBe(0);
    const names = forms.map((f) =>
      Array.from(f.querySelectorAll("input[name], select[name], textarea[name]"))
        .map((el) => el.getAttribute("name"))
        .sort(),
    );
    expect(names).toContainEqual(["listId", "note", "priority", "productId", "quantityDesired"]);
    expect(names).toContainEqual(["productId"]); // add to cart (CART_FIELD.productId)
    expect(names).toContainEqual(["listId", "productId", "toListId"]);
    expect(names).toContainEqual(["listId", "productId"]);
    // No forged / privileged fields.
    expect(html).not.toMatch(/name="(sessionId|ownerKey|price|priceCents|isDefault)"/);
  });

  test("no-JS: native validation present before hydration (min/max/step, note maxLength=200), no noValidate", () => {
    const html = renderToStaticMarkup(
      <ListItemRow item={item()} listId="L1" otherLists={[]} actions={{ update: noop, remove: noop, move: noop }} />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const qty = doc.querySelector('input[name="quantityDesired"]')!;
    expect(qty.getAttribute("type")).toBe("number");
    expect(qty.getAttribute("min")).toBe(String(LIST_INPUT_LIMITS.quantityMin));
    expect(qty.getAttribute("max")).toBe(String(LIST_INPUT_LIMITS.quantityMax));
    expect(qty.getAttribute("step")).toBe("1");
    expect(doc.querySelector('textarea[name="note"]')!.getAttribute("maxlength")).toBe(String(LIST_INPUT_LIMITS.noteMax));
    const updateForm = qty.closest("form")!;
    expect(updateForm.hasAttribute("novalidate")).toBe(false);
    expect(Array.from(doc.querySelectorAll('select[name="priority"] option')).map((o) => o.getAttribute("value"))).toEqual(["0", "1", "2"]);
  });

  test("readOnly renders NO form, input, select, textarea or button (also for a vanished product)", () => {
    for (const it of [item({ note: "hi" }), item({ product: null })]) {
      const html = renderToStaticMarkup(
        <ListItemRow item={it} listId="" otherLists={[{ id: "L2", name: "x" }]} actions={{ update: noop, remove: noop, move: noop, addToCart: async () => {} }} readOnly />,
      );
      expect(html).not.toMatch(/<(form|input|select|textarea|button)\b/);
    }
  });

  test("move Select lists only otherLists (in order); empty otherLists hides Move", async () => {
    const move = scripted([{ ok: true, kind: "moved", message: "Moved to Gifts.", listId: "L3" }]);
    const { unmount } = renderRow({ otherLists: [{ id: "L2", name: "Birthday" }, { id: "L3", name: "Gifts" }] }, { move: move.action });
    const select = screen.getByLabelText("Move to") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["L2", "Birthday"],
      ["L3", "Gifts"],
    ]);
    fireEvent.change(select, { target: { value: "L3" } });
    fireEvent.click(screen.getByRole("button", { name: /^Move/ }));
    await flush();
    expect(move.calls[0]).toMatchObject({ listId: "L1", productId: "p1", toListId: "L3" });
    expect(userKeys(move.calls[0]!)).toEqual(["listId", "productId", "toListId"]);
    unmount();
    renderRow({ otherLists: [] });
    expect(screen.queryByLabelText("Move to")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Move/ })).toBeNull();
  });

  test("add to cart posts productId only; hidden when unavailable or no action", async () => {
    const posted: Fields[] = [];
    const { unmount } = renderRow({}, { addToCart: async (fd) => void posted.push(snapshot(fd)) });
    fireEvent.click(screen.getByRole("button", { name: /Add\s+Oak Desk\s+to cart/ }));
    await flush();
    expect(posted.map(userKeys)).toEqual([["productId"]]);
    unmount();
    renderRow({ item: item({ available: false }) });
    expect(screen.queryByRole("button", { name: /to cart/ })).toBeNull();
  });

  test("product link href passes isAllowedInternalHref", () => {
    renderRow();
    const href = screen.getByRole("link", { name: "Oak Desk" }).getAttribute("href")!;
    expect(href).toBe("/products/oak-desk");
    expect(isAllowedInternalHref(href)).toBe(true);
  });
});

describe("T60 AC2 ListItemRow states in text; note as text", () => {
  test("'Price dropped by $X', 'Purchased', 'Out of stock' are text", () => {
    renderRow({ item: item({ priceDroppedByCents: 1250, purchasedSinceAdded: true, available: false }) });
    expect(screen.getByText("Price dropped by $12.50")).toBeInTheDocument();
    expect(screen.getByText("Purchased")).toBeInTheDocument();
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });
  for (const bad of [0, -100, Number.NaN, 10.5, Number.POSITIVE_INFINITY, null]) {
    test(`priceDroppedByCents=${String(bad)} renders no drop text (never NaN / negative)`, () => {
      const { container } = renderRow({ item: item({ priceDroppedByCents: bad }) });
      expect(container.textContent).not.toMatch(/Price dropped|NaN|-\$/);
    });
  }
  test("hostile / RTL / zero-width / 10k-word note and name: text only, wrapping classes", () => {
    for (const s of [HOSTILE, RTL, ZW, LONG_WORD]) {
      const { container, unmount } = renderRow({ item: item({ note: s, product: { ...product, name: s } }) });
      expect(container.querySelector("img:not([alt]), script")).toBeNull();
      expect(container.querySelectorAll("img")).toHaveLength(1); // only the product thumbnail
      const note = screen.getByTestId("list-item-note");
      expect(note.textContent).toBe(`Note: ${s}`);
      expect(note.className).toMatch(/break-words/);
      expect(container.querySelector("h3")!.className).toMatch(/break-words/);
      expect(container.querySelector("article")!.className).toMatch(/min-w-0/);
      unmount();
    }
  });
  test("vanished product: 'This item is no longer available' + Delete only", () => {
    const { container } = renderRow({ item: item({ product: null }) });
    expect(screen.getByText("This item is no longer available")).toBeInTheDocument();
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
  });
});

describe("T60 AC3 quantity/priority/note validation mirrors server limits", () => {
  const qtyCases: Array<[string, boolean]> = [
    ["1", true],
    ["99", true],
    [" 5 ", true],
    ["0", false],
    ["100", false],
    ["-1", false],
    ["2.5", false],
    ["1e1", false],
    ["abc", false],
    ["", false],
    ["\u0663", false], // Arabic-Indic 3
  ];
  for (const [raw, ok] of qtyCases) {
    test(`validateQuantity(${JSON.stringify(raw)}) -> ${ok ? "valid" : "error"}`, () => {
      expect(validateQuantity(raw) === null).toBe(ok);
    });
  }
  test("validatePriority accepts exactly 0/1/2", () => {
    for (const v of ["0", "1", "2"]) expect(validatePriority(v)).toBeNull();
    for (const v of ["3", "-1", "", "01", " 1", "high"]) expect(validatePriority(v)).not.toBeNull();
  });
  test("validateNote: 200 ok, 201 error", () => {
    expect(validateNote("n".repeat(LIST_INPUT_LIMITS.noteMax))).toBeNull();
    expect(validateNote("n".repeat(LIST_INPUT_LIMITS.noteMax + 1))).not.toBeNull();
  });

  // DEFECT D-T60-1: the client accepts 3-digit forms with leading zeros that the server
  // (lists-core.ts QUANTITY_PATTERN = /^\d{1,2}$/) rejects with INVALID_QUANTITY.
  test("DEFECT D-T60-1: validateQuantity rejects what the server rejects ('001', '010', '099')", () => {
    for (const raw of ["001", "010", "099"]) expect(validateQuantity(raw)).not.toBeNull();
  });
  test("evidence D-T60-1 (fixed): client rejects '099' like the server pattern (1-2 digits)", () => {
    expect(validateQuantity("099")).not.toBeNull();
    expect(validateQuantity("99")).toBeNull();
    const server = readFileSync(join(import.meta.dir, "../../../src/app/actions/lists-core.ts"), "utf8");
    expect(server).toContain("const QUANTITY_PATTERN = /^\\d{1,2}$/;");
  });

  test("invalid quantity: inline error, aria-invalid, submit blocked, focus on the field", async () => {
    const upd = scripted([{ ok: true, kind: "updated", message: "Saved." }]);
    renderRow({}, { update: upd.action });
    fireEvent.change(qtyInput(), { target: { value: "0" } });
    expect(await screen.findByText("Please enter a whole number from 1 to 99.")).toBeInTheDocument();
    expect(qtyInput()).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(saveBtn());
    await flush();
    expect(upd.calls).toHaveLength(0);
    expectFocused(qtyInput());
  });

  test("invalid priority value (forged option) -> inline error and blocked", async () => {
    const upd = scripted([null]);
    renderRow({}, { update: upd.action });
    const sel = screen.getByLabelText("Priority") as HTMLSelectElement;
    const opt = document.createElement("option");
    opt.value = "9";
    sel.appendChild(opt);
    fireEvent.change(sel, { target: { value: "9" } });
    fireEvent.click(saveBtn());
    await flush();
    expect(upd.calls).toHaveLength(0);
    expect(screen.getByText("Please choose low, medium or high priority.")).toBeInTheDocument();
  });

  test("valid edit posts exactly the contract fields with the typed values", async () => {
    const upd = scripted([{ ok: true, kind: "updated", message: "List item updated." }]);
    renderRow({}, { update: upd.action });
    fireEvent.change(qtyInput(), { target: { value: "7" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: "for the office" } });
    fireEvent.click(saveBtn());
    await flush();
    expect(upd.calls).toHaveLength(1);
    expect(userKeys(upd.calls[0]!)).toEqual(["listId", "note", "priority", "productId", "quantityDesired"]);
    expect(upd.calls[0]).toMatchObject({ listId: "L1", productId: "p1", quantityDesired: "7", priority: "2", note: "for the office" });
    expect(await screen.findByText("List item updated.")).toBeInTheDocument();
  });

  test("server fieldErrors render inline and open the disclosure; non-field error -> role=alert", async () => {
    const upd = scripted([
      fail("INVALID_QUANTITY", "Please enter a whole number from 1 to 99.", { fieldErrors: { quantityDesired: "Server says no." } }),
      fail("RATE_LIMITED", "slow", { retryAfterSeconds: 61 }),
    ]);
    const { container } = renderRow({}, { update: upd.action });
    fireEvent.click(saveBtn());
    expect(await screen.findByText("Server says no.")).toBeInTheDocument();
    expect(container.querySelector("details")!.open).toBe(true);
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Too many requests. Please try again in 2 minutes."));
  });
});

describe("T60 ListItemRow pending, delete, errors", () => {
  test("delete: posts listId+productId only; pending aria-busy; 5 rapid clicks -> 1 call", async () => {
    const g = gated();
    try {
      const { container } = renderRow({}, { remove: g.action });
      const del = () => screen.getByRole("button", { name: /Delete\s+Oak Desk/ });
      fireEvent.click(del());
      await waitFor(() => expect(container.querySelector("article")).toHaveAttribute("aria-busy", "true"));
      for (let i = 0; i < 4; i++) fireEvent.click(del());
      await flush();
      expect(g.calls).toHaveLength(1);
      expect(userKeys(g.calls[0]!)).toEqual(["listId", "productId"]);
    } finally {
      await g.release({ ok: true, kind: "removed", message: "Removed." });
    }
  });

  test("delete error (NOT_FOUND, hostile message) -> role=alert text; success -> polite region", async () => {
    const rm = scripted([fail("NOT_FOUND", HOSTILE), { ok: true, kind: "removed", message: "Removed from your list." }]);
    const { container } = renderRow({}, { remove: rm.action });
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(HOSTILE);
    expect(container.querySelector("img[src=x], script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }));
    await waitFor(() => {
      const live = Array.from(container.querySelectorAll('[aria-live="polite"]')).map((n) => n.textContent);
      expect(live).toContain("Removed from your list.");
    });
  });
});

describe("T60 AC5 / SR6 ListItemRow keyboard + touch targets", () => {
  test("every interactive control is natively focusable; Edit details is a <summary>", () => {
    const { container } = renderRow();
    const controls = Array.from(container.querySelectorAll("a, button, input:not([type=hidden]), select, textarea, summary"));
    expect(controls.length).toBeGreaterThanOrEqual(8);
    for (const c of controls) expect(c.getAttribute("tabindex")).not.toBe("-1");
    expect(container.querySelector("summary")!.textContent).toContain("Edit details");
  });

  test("buttons, select, inputs and the summary carry a 44px class", () => {
    const { container } = renderRow();
    for (const el of Array.from(container.querySelectorAll("button, select, input:not([type=hidden]), summary"))) {
      expect(`${el.tagName} ${el.className}`).toMatch(/min-h-touch|size-touch/);
    }
  });

  // DEFECT D-T60-2 (SR6): the product-name link uses the default `inline` Link variant
  // (no min-h-touch); it is a standalone control in a heading, not a link inside a sentence.
  test("DEFECT D-T60-2: product-name link meets the 44px touch target", () => {
    renderRow();
    expect(screen.getByRole("link", { name: "Oak Desk" }).className).toMatch(/min-h-touch|py-3|min-h-12/);
  });
  test("evidence D-T60-2 (fixed): link keeps the inline underline and adds the touch-target utility", () => {
    renderRow();
    const cls = screen.getByRole("link", { name: "Oak Desk" }).className;
    expect(cls).toMatch(/min-h-touch/);
    expect(cls).toContain("underline");
  });
});

// ---------------------------------------------------------------- ShareListPanel

const SITE = "https://shop.example.com";
function renderShare(over: Partial<Parameters<typeof ShareListPanel>[0]> = {}, action: ListActionFn = noop) {
  return render(
    <ShareListPanel listId="L1" listName="Birthday" kind="wishlist" isPublic={false} shareToken={null} action={action} siteUrl={SITE} {...over} />,
  );
}
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
function setClipboard(value: unknown) {
  Object.defineProperty(navigator, "clipboard", { value, configurable: true, writable: true });
}
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
});

describe("T60 AC4 ShareListPanel", () => {
  test("private (static): one enable form (listId, mode=enable); token NEVER rendered even when shareToken is set", () => {
    const html = stripReplay(
      renderToStaticMarkup(
        <ShareListPanel listId="L1" listName="Birthday" kind="wishlist" isPublic={false} shareToken="SECRETTOKEN123" action={noop} siteUrl={SITE} />,
      ),
    );
    expect(html).not.toContain("SECRETTOKEN123");
    expect(html).not.toContain("/lists/shared/");
    expect(html).not.toContain("<script");
    const doc = new DOMParser().parseFromString(html, "text/html");
    const forms = doc.querySelectorAll("form");
    expect(forms).toHaveLength(1);
    expect(Array.from(forms[0]!.querySelectorAll("input")).map((i) => [i.getAttribute("name"), i.getAttribute("value")])).toEqual([
      ["listId", "L1"],
      ["mode", "enable"],
    ]);
  });

  test("private (hydrated): token absent from DOM", () => {
    const { container } = renderShare({ shareToken: "SECRETTOKEN123" });
    expect(container.innerHTML).not.toContain("SECRETTOKEN123");
    expect(screen.queryByRole("button", { name: /Copy link/ })).toBeNull();
  });

  test("public (static, no JS): readonly link field, no Copy button, rotate form, disable form with REQUIRED confirm=yes checkbox, no nested forms", () => {
    const html = stripReplay(
      renderToStaticMarkup(
        <ShareListPanel listId="L1" listName="Birthday" kind="wishlist" isPublic shareToken="tok123" action={noop} siteUrl={SITE} />,
      ),
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("Copy link");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(countNestedForms(doc)).toBe(0);
    const link = doc.querySelector("input[readonly]")!;
    expect(link.getAttribute("value")).toBe(`${SITE}/lists/shared/tok123`);
    expect(doc.querySelector(`label[for="${link.id}"]`)!.textContent).toBe("Link to this list");
    const forms = Array.from(doc.querySelectorAll("form"));
    const modes = forms.map((f) => f.querySelector('input[name="mode"]')!.getAttribute("value"));
    expect(modes.sort()).toEqual(["disable", "rotate"]);
    const disable = forms.find((f) => f.querySelector('input[name="mode"]')!.getAttribute("value") === "disable")!;
    const confirm = disable.querySelector('input[type="checkbox"][name="confirm"]')!;
    expect(confirm.getAttribute("value")).toBe("yes");
    expect(confirm.hasAttribute("required")).toBe(true);
  });

  test("share URL contains only site + /lists/shared/<token> (no listId, list name or owner data)", () => {
    renderShare({ isPublic: true, shareToken: "tok123", listId: "LIST-ID-XYZ", listName: "Emre's list" });
    const v = (screen.getByLabelText("Link to this list") as HTMLInputElement).value;
    expect(v).toBe(`${SITE}/lists/shared/tok123`);
    expect(v).not.toMatch(/LIST-ID-XYZ|Emre|session|owner/i);
  });

  test("trailing slashes on siteUrl are collapsed", () => {
    renderShare({ isPublic: true, shareToken: "t", siteUrl: `${SITE}///` });
    expect((screen.getByLabelText("Link to this list") as HTMLInputElement).value).toBe(`${SITE}/lists/shared/t`);
  });

  // DEFECT D-T60-3: the `siteUrl` prop is used verbatim; a `javascript:` or protocol-relative
  // origin produces a share link the owner copies and pastes elsewhere. getSiteUrl() (the
  // default) validates http(s); the prop path does not.
  test("DEFECT D-T60-3: siteUrl 'javascript:' / '//evil' is rejected (falls back to a safe origin)", () => {
    for (const bad of ["javascript:alert(1)//", "//evil.example", "data:text/html,x"]) {
      const { unmount } = renderShare({ isPublic: true, shareToken: "tok", siteUrl: bad });
      const v = (screen.getByLabelText("Link to this list") as HTMLInputElement).value;
      expect(v).toMatch(/^https?:\/\/[^/]/);
      unmount();
    }
  });
  test("evidence D-T60-3 (fixed): hostile siteUrl never reaches the link field or the clipboard", async () => {
    const written: string[] = [];
    setClipboard({ writeText: async (s: string) => void written.push(s) });
    renderShare({ isPublic: true, shareToken: "tok", siteUrl: "javascript:alert(1)//" });
    const value = (screen.getByLabelText("Link to this list") as HTMLInputElement).value;
    expect(value).toMatch(/^https?:\/\/[^/]/);
    expect(value).not.toContain("javascript:");
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await flush();
    expect(written).toEqual([value]);
  });

  test("hydrated public: Copy link (clipboard) announces 'Link copied' politely", async () => {
    const written: string[] = [];
    setClipboard({ writeText: async (s: string) => void written.push(s) });
    renderShare({ isPublic: true, shareToken: "tok" });
    fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
    await waitFor(() => expect(screen.getByTestId("share-status")).toHaveTextContent("Link copied"));
    expect(screen.getByTestId("share-status")).toHaveAttribute("aria-live", "polite");
    expect(written).toEqual([`${SITE}/lists/shared/tok`]);
  });

  for (const [label, cb] of [
    ["missing", undefined],
    ["no writeText", {}],
    ["rejecting", { writeText: async () => Promise.reject(new Error("denied")) }],
  ] as const) {
    test(`Copy link with ${label} clipboard falls back to the readonly field (focused + message)`, async () => {
      setClipboard(cb);
      renderShare({ isPublic: true, shareToken: "tok" });
      fireEvent.click(screen.getByRole("button", { name: /Copy link/ }));
      await waitFor(() => expect(screen.getByTestId("share-status")).toHaveTextContent(/Copy the link from the field/));
      expectFocused(screen.getByLabelText("Link to this list"));
      expect(screen.getByLabelText("Link to this list")).toHaveAttribute("readonly");
    });
  }

  test("hydrated Stop sharing: confirm Dialog whose form posts listId, mode=disable, confirm=yes; Cancel closes without posting", async () => {
    const act1 = scripted([{ ok: true, kind: "sharing", message: "Sharing turned off.", sharePath: null }]);
    renderShare({ isPublic: true, shareToken: "tok" }, act1.action);
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(act1.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    const confirmBtn = Array.from(dialog.querySelectorAll("button")).find((b) => b.textContent === "Stop sharing")!;
    fireEvent.click(confirmBtn);
    await flush();
    expect(act1.calls).toHaveLength(1);
    expect(act1.calls[0]).toMatchObject({ listId: "L1", mode: "disable", confirm: "yes" });
    expect(userKeys(act1.calls[0]!)).toEqual(["confirm", "listId", "mode"]);
    // After disabling, the link is gone and focus moves to "Share this list".
    await waitFor(() => expectNull(screen.queryByLabelText("Link to this list")));
    await waitFor(() => expectFocused(screen.getByRole("button", { name: /Share this list/ })));
  });

  test("enable result shows the link from sharePath and focuses it; rotate posts mode=rotate", async () => {
    const a = scripted([
      { ok: true, kind: "sharing", message: "Sharing on.", sharePath: "/lists/shared/newtok" },
      { ok: true, kind: "sharing", message: "New link.", sharePath: "/lists/shared/rot" },
    ]);
    renderShare({}, a.action);
    fireEvent.click(screen.getByRole("button", { name: /Share this list/ }));
    await waitFor(() => expect((screen.getByLabelText("Link to this list") as HTMLInputElement).value).toBe(`${SITE}/lists/shared/newtok`));
    await waitFor(() => expectFocused(screen.getByLabelText("Link to this list")));
    fireEvent.click(screen.getByRole("button", { name: "Get a new link" }));
    await waitFor(() => expect((screen.getByLabelText("Link to this list") as HTMLInputElement).value).toBe(`${SITE}/lists/shared/rot`));
    expect(a.calls.map((c) => c.mode)).toEqual(["enable", "rotate"]);
  });

  test("save_for_later: disabled button, explanatory text, NO form, never a token", () => {
    const html = renderToStaticMarkup(
      <ShareListPanel listId="S" listName="Saved" kind="save_for_later" isPublic shareToken="LEAK" action={noop} siteUrl={SITE} />,
    );
    expect(html).not.toContain("<form");
    expect(html).not.toContain("LEAK");
    renderShare({ kind: "save_for_later", isPublic: true, shareToken: "LEAK" });
    expect(screen.getByRole("button", { name: /Share this list/ })).toBeDisabled();
    expect(screen.getByText("Saved items cannot be shared")).toBeInTheDocument();
  });

  for (const [label, state, text] of [
    ["FORBIDDEN", fail("FORBIDDEN", "Saved items cannot be shared."), "Saved items cannot be shared."],
    ["NOT_FOUND", fail("NOT_FOUND", "That list was not found."), "That list was not found."],
    ["RATE_LIMITED 61", fail("RATE_LIMITED", "x", { retryAfterSeconds: 61 }), "Too many requests. Please try again in 2 minutes."],
    ["hostile", fail("INVALID_INPUT", HOSTILE), HOSTILE],
  ] as const) {
    test(`error ${label} -> role=alert text, no link revealed`, async () => {
      const a = scripted([state]);
      const { container } = renderShare({ shareToken: "SECRET" }, a.action);
      fireEvent.click(screen.getByRole("button", { name: /Share this list/ }));
      expect((await screen.findByRole("alert")).textContent).toBe(text);
      expect(container.innerHTML).not.toContain("SECRET");
      expect(container.querySelector("img[src=x], script")).toBeNull();
    });
  }

  test("hostile / RTL / 10k list name: heading text only with break-words; hostile token stays inside the value attribute", () => {
    for (const name of [HOSTILE, RTL, LONG_WORD]) {
      const { container, unmount } = renderShare({ listName: name });
      expect(container.querySelector("h2")!.textContent).toBe(`Share ${name}`);
      expect(container.querySelector("h2")!.className).toMatch(/break-words/);
      expect(container.querySelector("script, img")).toBeNull();
      unmount();
    }
    const html = renderToStaticMarkup(
      <ShareListPanel listId="L1" listName="x" kind="wishlist" isPublic shareToken={`"><script>alert(1)</script>`} action={noop} siteUrl={SITE} />,
    );
    expect(stripReplay(html)).not.toContain("<script>alert");
  });

  test("SR6: every button / checkbox / input in both modes has a 44px class", () => {
    const html = renderToStaticMarkup(
      <ShareListPanel listId="L1" listName="x" kind="wishlist" isPublic shareToken="t" action={noop} siteUrl={SITE} />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    for (const el of Array.from(doc.querySelectorAll("button, input[readonly]"))) expect(el.className).toMatch(/min-h-touch|size-touch/);
    expect(doc.querySelector('input[type="checkbox"]')!.closest("label")!.className).toMatch(/min-h-touch/);
    renderShare({ isPublic: true, shareToken: "t" });
    for (const b of screen.getAllByRole("button")) expect(b.className).toMatch(/min-h-touch|size-touch/);
  });

  test("AC5 keyboard: all hydrated controls are native buttons/inputs reachable by Tab", () => {
    const { container } = renderShare({ isPublic: true, shareToken: "t" });
    const focusables = Array.from(container.querySelectorAll("button, input:not([type=hidden])"));
    expect(focusables.length).toBeGreaterThanOrEqual(4);
    for (const el of focusables) expect(el.getAttribute("tabindex")).not.toBe("-1");
  });
});
