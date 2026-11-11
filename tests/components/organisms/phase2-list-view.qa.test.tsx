// QA (QA-W4-organisms-D / T90): T85 ListView (owner + shared modes).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ListActionFn, ListActionState } from "@/components/molecules/_contracts/list-actions";
import {
  ListView,
  type ListViewActions,
  type OwnerListViewProps,
  type SharedListViewProps,
} from "@/components/organisms/ListView";
import { isAllowedInternalHref } from "@/content/routes";
import type { Product } from "@/lib/types";
import type { ListItemView, ListSort, ListView as ListViewData } from "@/server/lists/list-service";

const HOSTILE = `<img src=x onerror="alert(1)"><script>alert(2)</script>&amp; "q" 's' ‮evil`;
const SRC = join(import.meta.dir, "../../../src/components/organisms/ListView");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LIST_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "99999999-2222-4333-8444-555555555555";

type Posted = Record<string, FormDataEntryValue[]>;
function entries(fd: FormData): Posted {
  const out: Posted = {};
  for (const [k, v] of fd.entries()) (out[k] ??= []).push(v);
  return out;
}
function rec(result: ListActionState) {
  const calls: Posted[] = [];
  const action: ListActionFn = async (_p, fd) => {
    calls.push(entries(fd));
    return result;
  };
  return { action, calls };
}
const noop = rec(null).action;
function actions(over: Partial<ListViewActions> = {}): ListViewActions {
  return {
    renameList: noop,
    deleteList: noop,
    setListSharing: noop,
    addAllToCart: noop,
    updateListItem: noop,
    removeFromList: noop,
    moveListItem: noop,
    ...over,
  };
}
function product(n: number, over: Partial<Product> = {}): Product {
  return {
    id: `qa-p${n}`,
    slug: `qa-product-${n}`,
    name: `QA Product ${n}`,
    description: "",
    priceCents: 1000 * n,
    currency: "USD",
    imageUrl: `/images/qa-${n}.jpg`,
    stock: 5,
    ...over,
  };
}
function item(n: number, over: Partial<ListItemView> = {}): ListItemView {
  return {
    listId: LIST_ID,
    productId: `qa-p${n}`,
    quantityDesired: 1,
    priority: 1,
    priceAtAddCents: 1000 * n,
    note: null,
    addedAt: "2026-11-01T00:00:00.000Z",
    product: product(n),
    priceDroppedByCents: null,
    purchasedSinceAdded: false,
    available: true,
    ...over,
  };
}
function list(items: ListItemView[], over: Partial<ListViewData> = {}): ListViewData {
  return {
    id: LIST_ID,
    name: "Birthday ideas",
    kind: "wishlist",
    isDefault: true,
    isPublic: false,
    shareToken: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    items,
    itemCount: items.length,
    totalCents: items.reduce((s, i) => s + (i.product?.priceCents ?? 0), 0),
    ...over,
  };
}
function owner(over: Partial<OwnerListViewProps> = {}): OwnerListViewProps {
  return {
    mode: "owner",
    list: list([item(1), item(2, { available: false })]),
    otherLists: [
      { id: LIST_ID, name: "Birthday ideas", itemCount: 2, kind: "wishlist" },
      { id: OTHER_ID, name: "Other list", itemCount: 1, kind: "wishlist" },
    ],
    actions: actions(),
    sort: "added_desc",
    basePath: `/lists/${LIST_ID}`,
    ...over,
  };
}
const TOKEN = "Zt3x9QkLmN0pR5sT7vW2yA4bC6dE8fG1";
function shared(over: Partial<SharedListViewProps> = {}): SharedListViewProps {
  return {
    mode: "shared",
    shared: {
      name: "Shared ideas",
      itemCount: 2,
      // A service bug leaking the list id must still not reach the markup.
      items: [item(1, { note: "for mum" }), item(2, { product: null, available: false })],
    },
    sort: "added_desc",
    basePath: `/lists/shared/${TOKEN}`,
    ...over,
  };
}
const doc = (el: ReactElement) => new DOMParser().parseFromString(renderToStaticMarkup(el), "text/html");
const hrefs = (d: ParentNode) => [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");

// ---------------------------------------------------------------------------
describe("T85.3 owner: sort is a GET form; invalid value ignored", () => {
  test("method=get, action=basePath, Select name=sort with the four options in order", () => {
    const d = doc(<ListView {...owner({ sort: "price_desc" })} />);
    const form = d.querySelector('form[aria-label="Sort list"]') as HTMLFormElement;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe(`/lists/${LIST_ID}`);
    const select = form.querySelector('select[name="sort"]') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["added_desc", "price_asc", "price_desc", "priority"]);
    expect(select.querySelector("option[selected]")?.getAttribute("value")).toBe("price_desc");
    expect(d.querySelector(`label[for="${select.id}"]`)?.textContent).toBe("Sort by");
    expect([...form.querySelectorAll("[name]")].map((e) => e.getAttribute("name"))).toEqual(["sort"]);
  });

  for (const bogus of ["bogus", "", "PRICE_ASC", "<script>"]) {
    test(`unknown sort ${JSON.stringify(bogus)} -> added_desc preselected`, () => {
      const d = doc(<ListView {...owner({ sort: bogus as ListSort })} />);
      expect(d.querySelector('select[name="sort"] option[selected]')?.getAttribute("value")).toBe("added_desc");
    });
  }
});

describe("T85.5 owner: rename + delete", () => {
  test("rename disclosure form: Input name maxLength 60 + hidden listId only", () => {
    const d = doc(<ListView {...owner()} />);
    const input = d.querySelector('input[name="name"]') as HTMLInputElement;
    expect(input.getAttribute("maxlength")).toBe("60");
    expect(input.closest("details")).not.toBeNull();
    const form = input.closest("form") as HTMLFormElement;
    expect([...form.querySelectorAll("[name]")].map((e) => e.getAttribute("name")).sort()).toEqual(["listId", "name"]);
    expect(form.querySelector('input[type="hidden"][name="listId"]')?.getAttribute("value")).toBe(LIST_ID);
  });

  test("save_for_later: no rename, no delete", () => {
    const d = doc(<ListView {...owner({ list: list([item(1)], { kind: "save_for_later", isDefault: false }) })} />);
    expect(d.querySelector('input[name="name"]')).toBeNull();
    expect(d.querySelector('[name="confirm"]')).toBeNull();
    expect(d.body.textContent).not.toMatch(/Rename list|Delete list/);
  });

  test("no-JS delete: required Checkbox name=confirm value=yes in a form with hidden listId; no hidden confirm", () => {
    const d = doc(<ListView {...owner()} />);
    const box = d.querySelector('input[type="checkbox"][name="confirm"]') as HTMLInputElement;
    expect(box.getAttribute("value")).toBe("yes");
    expect(box.hasAttribute("required")).toBe(true);
    expect(d.querySelector(`label[for="${box.id}"]`)).not.toBeNull();
    const form = box.closest("form") as HTMLFormElement;
    expect(form.querySelector('input[type="hidden"][name="listId"]')?.getAttribute("value")).toBe(LIST_ID);
    expect(form.querySelector('input[type="hidden"][name="confirm"]')).toBeNull();
    expect(box.closest("details")).not.toBeNull();
  });

  test("with JS: Delete opens a Dialog whose form posts exactly listId + confirm=yes", async () => {
    const del = rec({ ok: false, error: { code: "FORBIDDEN", message: "You can't delete your only wish list." }, message: "You can't delete your only wish list." });
    render(<ListView {...owner({ actions: actions({ deleteList: del.action }) })} />);
    expect(document.querySelector('input[type="checkbox"][name="confirm"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Delete list/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this list?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete list" }));
    await waitFor(() => expect(del.calls).toHaveLength(1));
    expect(del.calls[0]).toEqual({ listId: [LIST_ID], confirm: ["yes"] });
    expect(await screen.findByText("You can't delete your only wish list.")).toHaveAttribute("role", "alert");
  });
});

describe("T85 owner: share panel, add-all, empty state, total", () => {
  test("ShareListPanel is rendered", () => {
    const d = doc(<ListView {...owner()} />);
    expect(d.querySelector('input[name="mode"]')).not.toBeNull();
    expect(d.body.textContent).toMatch(/Share Birthday ideas/);
  });

  test("T85.4 add-all: hidden listId only; label shows the in-stock count (gone + out-of-stock excluded)", () => {
    const items = [item(1), item(2, { available: false }), item(3, { product: null, available: false }), item(4)];
    const d = doc(<ListView {...owner({ list: list(items) })} />);
    const btn = [...d.querySelectorAll("button")].find((b) => /Add all to cart/.test(b.textContent ?? ""));
    expect(btn?.textContent).toContain("Add all to cart (2)");
    const form = btn?.closest("form") as HTMLFormElement;
    expect([...form.querySelectorAll("[name]")].map((e) => e.getAttribute("name"))).toEqual(["listId"]);
  });

  test("T85.4 add-all with zero in stock: disabled button + explanation", () => {
    const d = doc(<ListView {...owner({ list: list([item(1, { available: false })]) })} />);
    const btn = [...d.querySelectorAll("button")].find((b) => /Add all to cart/.test(b.textContent ?? ""));
    expect(btn?.textContent).toContain("(0)");
    expect(btn?.hasAttribute("disabled")).toBe(true);
    expect(d.body.textContent).toContain("No items in this list are in stock right now.");
  });

  test("T85.4 addAllResult.perItem rendered as text (hostile names stay text)", () => {
    const items = [item(1, { product: product(1, { name: HOSTILE }) }), item(2), item(3)];
    const d = doc(
      <ListView
        {...owner({
          list: list(items),
          addAllResult: {
            ok: true,
            kind: "add_all",
            message: "Added 1 item to your cart.",
            perItem: [
              { productId: "qa-p1", result: "added" },
              { productId: "qa-p2", result: "out_of_stock" },
              { productId: "qa-p3", result: "capped" },
              { productId: "qa-ghost", result: "unavailable" },
            ],
          },
        })}
      />,
    );
    const region = d.querySelector('[data-testid="add-all-results"]') as HTMLElement;
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toContain("Added 1 item to your cart.");
    expect(region.textContent).toContain(`Added: ${HOSTILE}.`);
    expect(region.textContent).toContain("Out of stock: QA Product 2.");
    expect(region.textContent).toContain("Limited by stock or the cart limit: QA Product 3.");
    expect(region.textContent).toContain("Unavailable: Unnamed item.");
    expect(region.querySelector("img, script")).toBeNull();
  });

  test("T85.4 interactive: add-all posts listId and shows the per-item results", async () => {
    const add = rec({ ok: true, kind: "add_all", message: "Done.", perItem: [{ productId: "qa-p1", result: "added" }] });
    render(<ListView {...owner({ actions: actions({ addAllToCart: add.action }) })} />);
    fireEvent.click(screen.getByRole("button", { name: /Add all to cart \(1\)/ }));
    await waitFor(() => expect(add.calls).toHaveLength(1));
    expect(add.calls[0]).toEqual({ listId: [LIST_ID] });
    await waitFor(() => expect(screen.getByTestId("add-all-results")).toHaveTextContent("Added: QA Product 1."));
  });

  test("T85.2 empty owner list: 'Browse products' + 'Best sellers' links (allowed), no sort / add-all", () => {
    const d = doc(<ListView {...owner({ list: list([]) })} />);
    const links = [...d.querySelectorAll("a")];
    const browse = links.find((a) => a.textContent === "Browse products");
    const best = links.find((a) => a.textContent === "Best sellers");
    expect(browse?.getAttribute("href")).toBe("/products");
    expect(best?.getAttribute("href")).toBe("/best-sellers");
    expect(isAllowedInternalHref("/products") && isAllowedInternalHref("/best-sellers")).toBe(true);
    expect(d.querySelector('select[name="sort"]')).toBeNull();
    expect(d.body.textContent).not.toMatch(/Add all to cart/);
  });

  test("T85.2 empty shared list: same links", () => {
    const d = doc(<ListView {...shared({ shared: { name: "S", itemCount: 0, items: [] } })} />);
    expect(hrefs(d)).toEqual(expect.arrayContaining(["/products", "/best-sellers"]));
  });

  test("total 'N items · $X' singular / plural; invalid total -> count only", () => {
    const one = doc(<ListView {...owner({ list: list([item(1)]) })} />);
    expect(one.querySelector('[data-testid="list-total"]')?.textContent).toBe("1 item · $10.00");
    const two = doc(<ListView {...owner({ list: list([item(1), item(2)]) })} />);
    expect(two.querySelector('[data-testid="list-total"]')?.textContent).toBe("2 items · $30.00");
    const bad = doc(<ListView {...owner({ list: list([item(1)], { totalCents: Number.NaN }) })} />);
    expect(bad.querySelector('[data-testid="list-total"]')?.textContent).toBe("1 item");
  });

  test("otherLists filters out the current list (switcher and move targets)", () => {
    const d = doc(<ListView {...owner()} />);
    expect(hrefs(d)).not.toContain(`/lists/${LIST_ID}`);
    expect(hrefs(d)).toContain(`/lists/${OTHER_ID}`);
    for (const sel of d.querySelectorAll('select[name="toListId"]')) {
      expect([...(sel as HTMLSelectElement).options].map((o) => o.value)).toEqual([OTHER_ID]);
    }
  });
});

describe("T85.3 unsafe basePath fallbacks", () => {
  for (const basePath of ["https://evil.example/x", "//evil.example", "javascript:alert(1)", "", "/lists/../admin", "/not-a-route"]) {
    test(`owner basePath ${JSON.stringify(basePath)} -> /lists/<id>`, () => {
      const d = doc(<ListView {...owner({ basePath })} />);
      expect(d.querySelector('form[aria-label="Sort list"]')?.getAttribute("action")).toBe(`/lists/${LIST_ID}`);
    });
    test(`shared basePath ${JSON.stringify(basePath)} -> no sort links`, () => {
      const d = doc(<ListView {...shared({ basePath })} />);
      expect(d.querySelector('nav[aria-label="Sort list"]')).toBeNull();
      for (const h of hrefs(d)) expect(isAllowedInternalHref(h)).toBe(true);
    });
  }

  test("query / hash stripped from a safe basePath", () => {
    const d = doc(<ListView {...owner({ basePath: `/lists/${LIST_ID}?sort=x#top` })} />);
    expect(d.querySelector('form[aria-label="Sort list"]')?.getAttribute("action")).toBe(`/lists/${LIST_ID}`);
  });
});

describe("T85.1 shared mode: read-only, no session-bound data", () => {
  const d = doc(<ListView {...shared({ sort: "price_asc" })} />);

  test("no <form>, no input/select/textarea/button anywhere", () => {
    expect(d.querySelectorAll("form")).toHaveLength(0);
    expect(d.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
  });

  test("no owner data: no UUID (list id), no email, no 'Default'/'Shared' badges, no share-panel text", () => {
    const html = renderToStaticMarkup(<ListView {...shared()} />);
    expect(html).not.toMatch(UUID);
    expect(html).not.toMatch(/[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}/i);
    expect(d.body.textContent).not.toMatch(/\bDefault\b|Share Shared ideas|Stop sharing|Your other lists/);
  });

  test("sort = GET links on the shared path with aria-current on the current sort; default omits ?sort", () => {
    const nav = d.querySelector('nav[aria-label="Sort list"]') as HTMLElement;
    const links = [...nav.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      `/lists/shared/${TOKEN}`,
      `/lists/shared/${TOKEN}?sort=price_asc`,
      `/lists/shared/${TOKEN}?sort=price_desc`,
      `/lists/shared/${TOKEN}?sort=priority`,
    ]);
    expect(links.filter((a) => a.hasAttribute("aria-current")).map((a) => a.textContent)).toEqual(["Price: Low to High"]);
  });

  test("unknown sort -> 'Recently added' current", () => {
    const u = doc(<ListView {...shared({ sort: "zzz" as ListSort })} />);
    const cur = u.querySelector('nav[aria-label="Sort list"] a[aria-current]');
    expect(cur?.textContent).toBe("Recently added");
  });

  test("items read-only with a 'View product' link to the PDP (accessible name includes product)", () => {
    const view = [...d.querySelectorAll("a")].filter((a) => a.textContent?.startsWith("View product"));
    expect(view).toHaveLength(1);
    expect(view[0]?.getAttribute("href")).toBe("/products/qa-product-1");
    expect(view[0]?.textContent).toBe("View product QA Product 1");
    expect(d.body.textContent).toContain("This item is no longer available");
    expect(d.body.textContent).toContain("for mum");
  });

  test("SharedListItemRow receives no function props across the server/client boundary", () => {
    const tree = ListView(shared()) as ReactElement<SharedListViewProps>;
    const body = (tree.type as (p: SharedListViewProps) => ReactNode)(tree.props);
    const offenders: string[] = [];
    let rows = 0;
    const walk = (node: ReactNode) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!isValidElement(node)) return;
      const p = node.props as Record<string, unknown>;
      if (typeof node.type === "function") {
        const name = (node.type as { name?: string }).name ?? "?";
        if (name === "SharedListItemRow") rows++;
        for (const [k, v] of Object.entries(p)) if (k !== "children" && typeof v === "function") offenders.push(`${name}.${k}`);
      }
      walk(p.children as ReactNode);
    };
    walk(body);
    expect(rows).toBe(2);
    expect(offenders).toEqual([]);
    expect(readFileSync(join(SRC, "ListViewIslands.tsx"), "utf8").startsWith('"use client"')).toBe(true);
    expect(readFileSync(join(SRC, "ListView.tsx"), "utf8")).not.toMatch(/^["']use client["']/m);
  });
});

describe("T85 cross-cutting: hrefs, hostile text, ids, landmarks", () => {
  test("every href passes isAllowedInternalHref (owner + shared, ordinary slugs)", () => {
    for (const el of [<ListView key="o" {...owner()} />, <ListView key="s" {...shared()} />]) {
      for (const h of hrefs(doc(el))) expect(isAllowedInternalHref(h)).toBe(true);
    }
  });

  test("DEFECT D-T85-1: no href failing isAllowedInternalHref is rendered for an unsafe slug", () => {
    const d = doc(
      <ListView {...shared({ shared: { name: "S", itemCount: 1, items: [item(1, { product: product(1, { slug: ".." }) })] } })} />,
    );
    for (const h of hrefs(d)) expect(isAllowedInternalHref(h)).toBe(true);
  });

  test("hostile list name / product name / note render as text", () => {
    const items = [item(1, { note: HOSTILE, product: product(1, { name: HOSTILE }) })];
    for (const el of [
      <ListView key="o" {...owner({ list: list(items, { name: HOSTILE }) })} />,
      <ListView key="s" {...shared({ shared: { name: HOSTILE, itemCount: 1, items } })} />,
    ]) {
      const d = doc(el);
      expect(d.querySelector("img[src=x]")).toBeNull();
      for (const s of d.querySelectorAll("script")) expect(s.textContent).not.toContain("alert(2)");
      expect(d.querySelector("h1")?.textContent).toBe(HOSTILE);
      expect(d.body.textContent).toContain(`Note: ${HOSTILE}`);
    }
  });

  test("unique ids; aria-labelledby/for targets exist; one h1; region names unique", () => {
    for (const el of [<ListView key="o" {...owner({ list: list([item(1, { note: "n" }), item(2)], { isPublic: true, shareToken: TOKEN }) })} />, <ListView key="s" {...shared()} />]) {
      const d = doc(el);
      const ids = [...d.querySelectorAll("[id]")].map((e) => e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const e of d.querySelectorAll("[aria-labelledby]")) expect(d.getElementById(e.getAttribute("aria-labelledby") ?? "")).not.toBeNull();
      for (const e of d.querySelectorAll("label[for]")) expect(d.getElementById(e.getAttribute("for") ?? "")).not.toBeNull();
      expect(d.querySelectorAll("h1")).toHaveLength(1);
      const names = [...d.querySelectorAll("section[aria-labelledby], nav[aria-label], form[aria-label]")].map(
        (e) => `${e.tagName}:${e.getAttribute("aria-label") ?? d.getElementById(e.getAttribute("aria-labelledby") ?? "")?.textContent}`,
      );
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("320px: no fixed widths / inline style props in ListView sources", () => {
    for (const f of ["ListView.tsx", "ListViewIslands.tsx"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(src).not.toMatch(/\bstyle=\{/);
      expect(src).not.toMatch(/(?<![a-z]:)\b(?:w|min-w)-(?:\d{2,}|\[)/);
    }
  });
});

// ---------------------------------------------------------------------------
// Resume rulings: real POST forms without JS ($$FORM_ACTION fixture), 44px targets, heading levels, no tokens leaked.
let refSeq = 0;
/** Mimics a Next server reference as React SSR sees it (`$$FORM_ACTION`, kept across `.bind`). */
function serverLike<T>(): T {
  const id = ++refSeq;
  const fields = () => ({ name: `$ACTION_REF_${id}`, action: "", encType: "multipart/form-data", method: "POST", data: null });
  const make = (): unknown => Object.assign(async () => null, { $$FORM_ACTION: fields, bind: () => make() });
  return make() as T;
}
const TOUCH = /\b(?:min-h-touch|size-touch|min-h-12)\b/;
function serverOwner(over: Partial<OwnerListViewProps> = {}) {
  return (
    <ListView
      {...owner({
        list: list([item(1, { note: "n" }), item(2)], { isPublic: true, shareToken: TOKEN }),
        actions: {
          renameList: serverLike<ListActionFn>(),
          deleteList: serverLike<ListActionFn>(),
          setListSharing: serverLike<ListActionFn>(),
          addAllToCart: serverLike<ListActionFn>(),
          updateListItem: serverLike<ListActionFn>(),
          removeFromList: serverLike<ListActionFn>(),
          moveListItem: serverLike<ListActionFn>(),
          addToCart: serverLike<(fd: FormData) => Promise<void>>(),
        },
        ...over,
      })}
    />
  );
}

describe("Resume: owner mutations are real POST forms without JS", () => {
  test("rename, delete, sharing, add-all, item edit/move/delete/add-to-cart: POST + multipart; the sort form is the only GET", () => {
    const d = doc(serverOwner());
    const forms = [...d.querySelectorAll("form")];
    const gets = forms.filter((f) => f.getAttribute("method") === "get");
    expect(gets.map((f) => f.getAttribute("aria-label"))).toEqual(["Sort list"]);
    const posts = forms.filter((f) => f.getAttribute("method") !== "get");
    expect(posts.length).toBeGreaterThanOrEqual(12);
    for (const f of posts) {
      expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
      expect(f.getAttribute("enctype")).toBe("multipart/form-data");
      expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
    }
  });

  test("add-to-cart passed as addToCart.bind(null, null) (R-T110-1 style) keeps the POST shape", () => {
    const bound = serverLike<(p: null, fd: FormData) => Promise<void>>().bind(null, null) as unknown as (fd: FormData) => Promise<void>;
    const d = doc(serverOwner({ actions: { ...actions(), addToCart: bound } }));
    const f = [...d.querySelectorAll("form")].find((x) => /Add\s*QA Product 1\s*to cart/.test(x.textContent ?? "")) as HTMLFormElement;
    expect(f.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(f.getAttribute("action") ?? "").not.toContain("javascript:");
  });
});

describe("Resume: a11y + data rules", () => {
  test("every interactive element meets 44px (owner and shared)", () => {
    for (const el0 of [serverOwner(), <ListView key="s" {...shared()} />]) {
      const d = doc(el0);
      for (const el of d.querySelectorAll("a, button, summary, input:not([type=hidden]), select, textarea")) {
        const cls = `${el.getAttribute("class") ?? ""} ${el.closest("label")?.getAttribute("class") ?? ""}`;
        expect([el.tagName, el.textContent?.slice(0, 25), TOUCH.test(cls)]).toEqual([el.tagName, el.textContent?.slice(0, 25), true]);
      }
    }
  });

  test("submit button accessible names are unique (product / list name in each)", () => {
    const d = doc(serverOwner());
    const names = [...d.querySelectorAll('button[type="submit"]')].map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim());
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test("heading levels never skip: h1 -> h2 -> h3 (owner, shared) and h2 -> h3 -> h4 with headingLevel 2", () => {
    const levels = (el: ReactElement) => [...doc(el).querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1]));
    for (const [el, top] of [
      [serverOwner(), 1],
      [<ListView key="s" {...shared()} />, 1],
      [serverOwner({ headingLevel: 2 }), 2],
      [<ListView key="s2" {...shared({ headingLevel: 2 })} />, 2],
    ] as const) {
      const l = levels(el);
      expect(l[0]).toBe(top);
      for (let i = 1; i < l.length; i++) expect((l[i] ?? 0) - (l[i - 1] ?? 0)).toBeLessThanOrEqual(1);
    }
  });

  test("shared mode never shows the list id, owner data or a share token beyond the current page path", () => {
    const html = renderToStaticMarkup(<ListView {...shared()} />);
    expect(html).not.toContain(LIST_ID);
    expect(html).not.toMatch(/sessionId|ownerKey|owner_key|sf_session|sf_auth|shareToken/i);
    // The token appears only inside the sort links of the page the visitor already holds.
    const d = doc(<ListView {...shared()} />);
    const withToken = [...d.querySelectorAll("*")].filter((e) =>
      [...e.attributes].some((a) => a.value.includes(TOKEN) && !(e.tagName === "A" && a.name === "href")),
    );
    expect(withToken).toHaveLength(0);
  });

  test("owner markup carries no session id / owner key (list id is not a session id)", () => {
    const html = renderToStaticMarkup(serverOwner());
    expect(html).not.toMatch(/sessionId|ownerKey|owner_key|sf_session|sf_auth/i);
  });
});
