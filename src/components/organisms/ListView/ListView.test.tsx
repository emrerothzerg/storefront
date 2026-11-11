import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ListActionFn, ListActionState } from "@/components/molecules/_contracts/list-actions";
import { isAllowedInternalHref } from "@/content/routes";
import { appError } from "@/lib/result";
import type { Product } from "@/lib/types";
import type { ListItemView, ListView as ListViewData, SharedListView } from "@/server/lists/list-service";
import { ListView, type ListViewActions, type OwnerListViewProps } from "./ListView";
import { DELETE_CONFIRM_LABEL, ListSwitcher } from "./ListViewIslands";
import { LIST_EMPTY_MESSAGE } from "./list-view-model";

type Posted = Record<string, string>;

function recording(result: ListActionState) {
  const calls: Posted[] = [];
  const action: ListActionFn = async (_prev, formData) => {
    const posted: Posted = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") posted[key] = value;
    });
    calls.push(posted);
    return result;
  };
  return { action, calls };
}

const LIST_ID = "3f2b8c1e-7d4a-4e5b-9c6d-1a2b3c4d5e6f";
const OTHER_ID = "8a7b6c5d-4e3f-4a1b-8c9d-0e1f2a3b4c5d";
const SFL_ID = "0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HOSTILE = `<script>alert("x")</script><img src=x onerror=alert(1)>`;

function makeProduct(id: string, name: string, priceCents: number, stock = 5): Product {
  return {
    id,
    slug: `${id}-slug`,
    name,
    description: "",
    priceCents,
    currency: "USD",
    imageUrl: `/images/products/${id}.svg`,
    stock,
  };
}

function makeItem(productId: string, name: string, overrides: Partial<ListItemView> = {}): ListItemView {
  return {
    listId: LIST_ID,
    productId,
    quantityDesired: 1,
    priority: 1,
    priceAtAddCents: 1000,
    note: null,
    addedAt: "2026-11-01T10:00:00.000Z",
    product: makeProduct(productId, name, 1000),
    priceDroppedByCents: null,
    purchasedSinceAdded: false,
    available: true,
    ...overrides,
  };
}

const ITEMS: readonly ListItemView[] = [
  makeItem("p-lamp", "Desk Lamp"),
  makeItem("p-mug", "Blue Mug"),
  makeItem("p-chair", "Oak Chair", { available: false, product: makeProduct("p-chair", "Oak Chair", 5000, 0) }),
];

function makeList(overrides: Partial<ListViewData> = {}): ListViewData {
  return {
    id: LIST_ID,
    name: "Birthday ideas",
    kind: "wishlist",
    isDefault: true,
    isPublic: false,
    shareToken: null,
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
    items: ITEMS,
    itemCount: 3,
    totalCents: 7000,
    ...overrides,
  };
}

const okState = (kind: "renamed" | "deleted" | "sharing", message: string): ListActionState => ({
  ok: true,
  kind,
  message,
  listId: LIST_ID,
});

function makeActions(overrides: Partial<ListViewActions> = {}): ListViewActions {
  const noop: ListActionFn = async () => null;
  return {
    renameList: noop,
    deleteList: noop,
    setListSharing: noop,
    addAllToCart: noop,
    updateListItem: noop,
    removeFromList: noop,
    moveListItem: noop,
    ...overrides,
  };
}

function ownerProps(overrides: Partial<OwnerListViewProps> = {}): OwnerListViewProps {
  return {
    mode: "owner",
    list: makeList(),
    otherLists: [
      { id: LIST_ID, name: "Birthday ideas", itemCount: 3, kind: "wishlist" },
      { id: OTHER_ID, name: "Holiday", itemCount: 1, kind: "wishlist" },
      { id: SFL_ID, name: "Saved for later", itemCount: 0, kind: "save_for_later" },
    ],
    sort: "added_desc",
    basePath: `/lists/${LIST_ID}`,
    actions: makeActions(),
    siteUrl: "https://shop.example",
    ...overrides,
  };
}

function parse(html: string): Document {
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
}

function formWithHidden(doc: Document, name: string, value: string): HTMLFormElement[] {
  return [...doc.querySelectorAll("form")].filter((form) =>
    [...form.querySelectorAll<HTMLInputElement>('input[type="hidden"]')].some(
      (input) => input.name === name && input.value === value,
    ),
  );
}

function allHrefs(doc: Document): string[] {
  return [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") ?? "");
}

const sharedView: SharedListView = {
  name: "Birthday ideas",
  itemCount: 2,
  items: [
    makeItem("p-lamp", "Desk Lamp", { listId: "" }),
    makeItem("p-gone", "Gone", { listId: "", product: null, available: false }),
  ],
};

describe("ListView owner: static markup (no JS)", () => {
  const doc = parse(renderToStaticMarkup(<ListView {...ownerProps()} />));

  test("one h1 with the list name, kind badge and total", () => {
    const h1s = doc.querySelectorAll("h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe("Birthday ideas");
    expect(doc.body.textContent).toContain("Default");
    expect(doc.querySelector('[data-testid="list-total"]')?.textContent).toBe("3 items · $70.00");
  });

  test("sort is a GET form to basePath with the four options", () => {
    const form = doc.querySelector('form[aria-label="Sort list"]');
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.getAttribute("action")).toBe(`/lists/${LIST_ID}`);
    const select = form?.querySelector<HTMLSelectElement>('select[name="sort"]');
    expect([...(select?.options ?? [])].map((o) => o.value)).toEqual([
      "added_desc",
      "price_asc",
      "price_desc",
      "priority",
    ]);
    expect(form?.textContent).toContain("Apply");
  });

  test("rename form: hidden listId + name input maxLength 60", () => {
    const forms = formWithHidden(doc, "listId", LIST_ID).filter((f) => f.querySelector('input[name="name"]'));
    expect(forms).toHaveLength(1);
    const input = forms[0]?.querySelector<HTMLInputElement>('input[name="name"]');
    expect(input?.getAttribute("maxlength")).toBe("60");
    expect(input?.value).toBe("Birthday ideas");
  });

  test("delete form without JS: required confirm checkbox value=yes", () => {
    const forms = formWithHidden(doc, "listId", LIST_ID).filter((f) => f.querySelector('input[name="confirm"]'));
    expect(forms).toHaveLength(1);
    const confirm = forms[0]?.querySelector<HTMLInputElement>('input[name="confirm"]');
    expect(confirm?.type).toBe("checkbox");
    expect(confirm?.value).toBe("yes");
    expect(confirm?.required).toBe(true);
    expect(forms[0]?.textContent).toContain(DELETE_CONFIRM_LABEL);
  });

  test("share panel form posts mode=enable", () => {
    expect(formWithHidden(doc, "mode", "enable")).toHaveLength(1);
  });

  test("add all form shows the in-stock count and posts listId", () => {
    const button = [...doc.querySelectorAll("button")].find((b) => b.textContent?.includes("Add all to cart"));
    expect(button?.textContent).toContain("Add all to cart (2)");
    const form = button?.closest("form");
    expect(form?.querySelector<HTMLInputElement>('input[name="listId"]')?.value).toBe(LIST_ID);
  });

  test("other-lists fallback is a list of links (current list excluded)", () => {
    const nav = doc.querySelector('nav[aria-label="Your other lists"]');
    const hrefs = [...(nav?.querySelectorAll("a") ?? [])].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual([`/lists/${OTHER_ID}`, `/lists/${SFL_ID}`]);
    expect(nav?.textContent).toContain("Holiday (1 item)");
  });

  test("items render as ListItemRows in a list with move targets", () => {
    const items = doc.querySelectorAll('ul[role="list"] > li');
    expect(items).toHaveLength(3);
    const moveSelect = doc.querySelector<HTMLSelectElement>('select[name="toListId"]');
    expect([...(moveSelect?.options ?? [])].map((o) => o.value)).toEqual([OTHER_ID, SFL_ID]);
  });

  test("every href passes isAllowedInternalHref", () => {
    for (const href of allHrefs(doc)) expect(isAllowedInternalHref(href)).toBe(true);
  });
});

describe("ListView owner: variants", () => {
  test("save_for_later: no rename/delete forms, badge shown", () => {
    const doc = parse(
      renderToStaticMarkup(
        <ListView {...ownerProps({ list: makeList({ kind: "save_for_later", isDefault: false, name: "Saved for later" }) })} />,
      ),
    );
    expect(doc.querySelector('input[name="name"]')).toBeNull();
    expect(doc.querySelector('input[name="confirm"]')).toBeNull();
    expect(doc.body.textContent).toContain("Saved for later");
    expect([...doc.querySelectorAll("span")].some((el) => el.textContent === "Default")).toBe(false);
  });

  test("empty list: message, browse + best sellers links, no sort / add-all", () => {
    const doc = parse(
      renderToStaticMarkup(<ListView {...ownerProps({ list: makeList({ items: [], itemCount: 0, totalCents: 0 }) })} />),
    );
    expect(doc.body.textContent).toContain(LIST_EMPTY_MESSAGE);
    const hrefs = allHrefs(doc);
    expect(hrefs).toContain("/products");
    expect(hrefs).toContain("/best-sellers");
    expect(doc.querySelector('form[aria-label="Sort list"]')).toBeNull();
    expect(doc.body.textContent).not.toContain("Add all to cart");
    expect(doc.querySelector('[data-testid="list-total"]')?.textContent).toBe("0 items · $0.00");
  });

  test("hostile list name and note render as text", () => {
    const html = renderToStaticMarkup(
      <ListView
        {...ownerProps({
          list: makeList({ name: HOSTILE, items: [makeItem("p-lamp", "Desk Lamp", { note: HOSTILE })] }),
        })}
      />,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    const doc = parse(html);
    expect(doc.querySelector("h1")?.textContent).toBe(HOSTILE);
    expect(doc.querySelector('[data-testid="list-item-note"]')?.textContent).toContain(HOSTILE);
  });

  test("unsafe basePath falls back to /lists/<id>", () => {
    const doc = parse(renderToStaticMarkup(<ListView {...ownerProps({ basePath: "https://evil.example/x" })} />));
    expect(doc.querySelector('form[aria-label="Sort list"]')?.getAttribute("action")).toBe(`/lists/${LIST_ID}`);
  });

  test("current sort is preselected", () => {
    const doc = parse(renderToStaticMarkup(<ListView {...ownerProps({ sort: "price_desc" })} />));
    expect(doc.querySelector('select[name="sort"] option[selected]')?.getAttribute("value")).toBe("price_desc");
  });

  test("addAllResult renders per-item results as text", () => {
    const html = renderToStaticMarkup(
      <ListView
        {...ownerProps({
          addAllResult: {
            ok: true,
            kind: "add_all",
            message: "Added 2 items to your cart.",
            listId: LIST_ID,
            perItem: [
              { productId: "p-lamp", result: "added" },
              { productId: "p-mug", result: "added" },
              { productId: "p-chair", result: "out_of_stock" },
            ],
          },
        })}
      />,
    );
    const text = parse(html).querySelector('[data-testid="add-all-results"]')?.textContent ?? "";
    expect(text).toContain("Added 2 items to your cart.");
    expect(text).toContain("Added: Desk Lamp, Blue Mug. Out of stock: Oak Chair.");
  });

  test("no in-stock items: add-all button disabled with an explanation", () => {
    const doc = parse(
      renderToStaticMarkup(<ListView {...ownerProps({ list: makeList({ items: [ITEMS[2] as ListItemView] }) })} />),
    );
    const button = [...doc.querySelectorAll("button")].find((b) => b.textContent?.includes("Add all to cart"));
    expect(button?.textContent).toContain("(0)");
    expect(button?.hasAttribute("disabled")).toBe(true);
  });

  test("headingLevel 2: list name is h2, no h1", () => {
    const doc = parse(renderToStaticMarkup(<ListView {...ownerProps({ headingLevel: 2 })} />));
    expect(doc.querySelector("h1")).toBeNull();
    expect(doc.querySelector("h2")?.textContent).toBe("Birthday ideas");
  });
});

describe("ListView shared (read-only)", () => {
  const html = renderToStaticMarkup(
    <ListView mode="shared" shared={sharedView} sort="added_desc" basePath="/lists/shared/tok_ABC123" />,
  );
  const doc = parse(html);

  test("no forms, no hidden inputs, no owner data", () => {
    expect(html).not.toContain("<form");
    expect(doc.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
    expect(html).not.toMatch(UUID_RE);
    expect(html).not.toContain("Default");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("@");
    expect(html).not.toContain("Share this list");
  });

  test("name, count, and View product link to the PDP", () => {
    expect(doc.querySelector("h1")?.textContent).toBe("Birthday ideas");
    expect(doc.querySelector('[data-testid="list-total"]')?.textContent).toBe("2 items");
    const view = [...doc.querySelectorAll("a")].find((a) => a.textContent?.startsWith("View product"));
    expect(view?.getAttribute("href")).toBe("/products/p-lamp-slug");
    expect(doc.body.textContent).toContain("This item is no longer available");
  });

  test("sort is plain GET links on the shared path", () => {
    const nav = doc.querySelector('nav[aria-label="Sort list"]');
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "/lists/shared/tok_ABC123",
      "/lists/shared/tok_ABC123?sort=price_asc",
      "/lists/shared/tok_ABC123?sort=price_desc",
      "/lists/shared/tok_ABC123?sort=priority",
    ]);
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
  });

  test("hrefs allowed; hostile shared name as text", () => {
    for (const href of allHrefs(doc)) expect(isAllowedInternalHref(href)).toBe(true);
    const hostile = renderToStaticMarkup(
      <ListView mode="shared" shared={{ ...sharedView, name: HOSTILE }} sort="added_desc" basePath="/lists/shared/t" />,
    );
    expect(hostile).not.toContain("<script");
    expect(parse(hostile).querySelector("h1")?.textContent).toBe(HOSTILE);
  });

  test("unsafe basePath hides sort links; empty shared list shows browse links", () => {
    const unsafe = parse(
      renderToStaticMarkup(<ListView mode="shared" shared={sharedView} sort="added_desc" basePath="//evil" />),
    );
    expect(unsafe.querySelector('nav[aria-label="Sort list"]')).toBeNull();
    const empty = renderToStaticMarkup(
      <ListView mode="shared" shared={{ name: "Empty", items: [], itemCount: 0 }} sort="added_desc" basePath="/lists/shared/t" />,
    );
    expect(empty).not.toContain("<form");
    expect(empty).toContain(LIST_EMPTY_MESSAGE);
    expect(allHrefs(parse(empty))).toEqual(expect.arrayContaining(["/products", "/best-sellers"]));
  });
});

describe("ListView owner: interactive (JS)", () => {
  test("delete with JS: confirm dialog posts listId + confirm=yes", async () => {
    const del = recording(okState("deleted", "List deleted."));
    render(<ListView {...ownerProps({ actions: makeActions({ deleteList: del.action }) })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Delete list/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this list?" });
    expect(del.calls).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete list" }));
    await waitFor(() => expect(del.calls).toHaveLength(1));
    expect(del.calls[0]).toEqual({ listId: LIST_ID, confirm: "yes" });
    await screen.findByText("List deleted.", { exact: false });
    expect(screen.getByRole("link", { name: "Back to your lists" })).toHaveAttribute("href", "/lists");
  });

  test("delete cancel does not post", async () => {
    const del = recording(okState("deleted", "List deleted."));
    render(<ListView {...ownerProps({ actions: makeActions({ deleteList: del.action }) })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Delete list/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this list?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
    expect(del.calls).toHaveLength(0);
  });

  test("delete FORBIDDEN (only wish list) shows the error", async () => {
    const message = "This list can't be deleted. You need at least one other wish list first.";
    const del = recording({ ok: false, error: appError("FORBIDDEN", message), message });
    render(<ListView {...ownerProps({ actions: makeActions({ deleteList: del.action }) })} />);
    fireEvent.click(await screen.findByRole("button", { name: /^Delete list/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Delete this list?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete list" }));
    expect(await screen.findByText(message)).toHaveAttribute("role", "alert");
  });

  test("rename posts listId + name; field error shown", async () => {
    const message = "List name must be 60 characters or fewer.";
    const rename = recording({
      ok: false,
      error: appError("TOO_LONG", message),
      message,
      fieldErrors: { name: message },
      values: { name: "x".repeat(60) },
    });
    render(<ListView {...ownerProps({ actions: makeActions({ renameList: rename.action }) })} />);
    const input = screen.getByLabelText(/New list name/);
    fireEvent.change(input, { target: { value: "Gifts" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(rename.calls).toHaveLength(1));
    expect(rename.calls[0]).toEqual({ listId: LIST_ID, name: "Gifts" });
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByLabelText(/New list name/)).toHaveAttribute("aria-invalid", "true");
  });

  test("add all posts listId and shows per-item results", async () => {
    const addAll = recording({
      ok: true,
      kind: "add_all",
      message: "Added 1 item to your cart.",
      listId: LIST_ID,
      perItem: [
        { productId: "p-lamp", result: "added" },
        { productId: "p-mug", result: "capped" },
        { productId: "p-chair", result: "out_of_stock" },
      ],
    });
    render(<ListView {...ownerProps({ actions: makeActions({ addAllToCart: addAll.action }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Add all to cart (2)" }));
    await waitFor(() => expect(addAll.calls).toHaveLength(1));
    expect(addAll.calls[0]).toEqual({ listId: LIST_ID });
    const results = await screen.findByTestId("add-all-results");
    await waitFor(() =>
      expect(results.textContent).toContain(
        "Added: Desk Lamp. Limited by stock or the cart limit: Blue Mug. Out of stock: Oak Chair.",
      ),
    );
  });

  test("add all RATE_LIMITED shows an alert", async () => {
    const addAll = recording({
      ok: false,
      error: appError("RATE_LIMITED", "Too many"),
      message: "Too many",
      retryAfterSeconds: 90,
    });
    render(<ListView {...ownerProps({ actions: makeActions({ addAllToCart: addAll.action }) })} />);
    fireEvent.click(screen.getByRole("button", { name: "Add all to cart (2)" }));
    expect(await screen.findByText("Too many requests. Please try again in 2 minutes.")).toHaveAttribute(
      "role",
      "alert",
    );
  });

  test("other-lists switcher becomes a select after hydration and navigates", async () => {
    const visited: string[] = [];
    render(
      <ListSwitcher
        lists={[
          { href: `/lists/${OTHER_ID}`, label: "Holiday (1 item)" },
          { href: `/lists/${SFL_ID}`, label: "Saved for later (0 items)" },
        ]}
        navigate={(href) => visited.push(href)}
      />,
    );
    const select = await screen.findByLabelText("Your other lists");
    fireEvent.change(select, { target: { value: `/lists/${SFL_ID}` } });
    fireEvent.click(screen.getByRole("button", { name: /^Go/ }));
    expect(visited).toEqual([`/lists/${SFL_ID}`]);
  });

  test("switcher renders nothing without other lists", () => {
    const { container } = render(<ListSwitcher lists={[]} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("ListView Phase 3 restyle (T156): tokens and pills, behaviour unchanged", () => {
  const classesOf = (el: Element | null | undefined) => (el?.getAttribute("class") ?? "").split(/\s+/);

  test("owner badges are pills", () => {
    const doc = parse(renderToStaticMarkup(<ListView {...ownerProps({ list: makeList({ isPublic: true }) })} />));
    const badges = [...doc.querySelectorAll("header span")].filter((el) => ["Default", "Shared"].includes(el.textContent ?? ""));
    expect(badges.map((b) => b.textContent)).toEqual(["Default", "Shared"]);
    for (const b of badges) expect(classesOf(b)).toContain("rounded-full");
  });

  test("toolbar sits in a token Card (sort form, switcher, add-all inside); forms unchanged", () => {
    const doc = parse(renderToStaticMarkup(<ListView {...ownerProps()} />));
    const toolbar = doc.querySelector('[data-slot="list-toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(classesOf(toolbar)).toEqual(expect.arrayContaining(["bg-surface-raised", "rounded-lg"]));
    expect(toolbar?.querySelector('form[aria-label="Sort list"][method="get"]')).not.toBeNull();
    expect(toolbar?.querySelector('nav[aria-label="Your other lists"]')).not.toBeNull();
    expect(formWithHidden(doc, "listId", LIST_ID).some((f) => toolbar?.contains(f))).toBe(true);
  });

  test("no-JS other-lists links are pill chips with 44px targets", () => {
    const doc = parse(renderToStaticMarkup(<ListView {...ownerProps()} />));
    const links = [...doc.querySelectorAll('nav[aria-label="Your other lists"] a')];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) expect(classesOf(a)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
  });

  test("empty state: sunken Card with pill button links to browse / best sellers", () => {
    const doc = parse(renderToStaticMarkup(<ListView {...ownerProps({ list: makeList({ items: [], itemCount: 0, totalCents: 0 }) })} />));
    const browse = [...doc.querySelectorAll("a")].find((a) => a.textContent === "Browse products");
    const best = [...doc.querySelectorAll("a")].find((a) => a.textContent === "Best sellers");
    expect(browse?.getAttribute("href")).toBe("/products");
    expect(best?.getAttribute("href")).toBe("/best-sellers");
    for (const a of [browse, best]) expect(classesOf(a)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
    expect(classesOf(browse?.closest("div.bg-surface-sunken"))).toContain("bg-surface-sunken");
  });

  test("shared sort links are pill chips; only the current one is aria-current=page", () => {
    const doc = parse(
      renderToStaticMarkup(<ListView mode="shared" shared={sharedView} sort="price_desc" basePath="/lists/shared/tok_ABC123" />),
    );
    const links = [...doc.querySelectorAll('nav[aria-label="Sort list"] a')];
    expect(links).toHaveLength(4);
    for (const a of links) expect(classesOf(a)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
    const current = links.filter((a) => a.hasAttribute("aria-current"));
    expect(current).toHaveLength(1);
    expect(current[0]?.getAttribute("aria-current")).toBe("page");
    expect(current[0]?.getAttribute("href")).toBe("/lists/shared/tok_ABC123?sort=price_desc");
    expect(doc.querySelector("form")).toBeNull();
  });

  test("shared 'View product' is an outline pill button link", () => {
    const doc = parse(
      renderToStaticMarkup(<ListView mode="shared" shared={sharedView} sort="added_desc" basePath="/lists/shared/tok_ABC123" />),
    );
    const view = [...doc.querySelectorAll("a")].find((a) => a.textContent?.startsWith("View product"));
    expect(classesOf(view)).toEqual(expect.arrayContaining(["rounded-full", "min-h-touch"]));
  });

  test("no arbitrary values, palette colours or inline styles in either mode", () => {
    for (const html of [
      renderToStaticMarkup(<ListView {...ownerProps()} />),
      renderToStaticMarkup(<ListView mode="shared" shared={sharedView} sort="added_desc" basePath="/lists/shared/tok_ABC123" />),
    ]) {
      const doc = parse(html);
      const classes = [...doc.querySelectorAll("[class]")].flatMap((el) => classesOf(el));
      expect(classes.filter((c) => /\[.*\]/.test(c))).toEqual([]);
      expect(classes.filter((c) => /(^|:)(bg|text|border)-(gray|slate|red|blue|green|white|black)(-\d+)?$/.test(c))).toEqual([]);
      expect(classes.filter((c) => c.startsWith(["da", "rk:"].join("")))).toEqual([]);
      const styled = [...doc.querySelectorAll("[style]")].filter((el) => el.tagName !== "IMG");
      expect(styled).toHaveLength(0);
    }
  });
});
