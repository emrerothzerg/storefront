import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { appError } from "@/lib/result";
import type { Product } from "@/lib/types";
import type { ListItemView } from "@/server/lists/list-service";
import type { ListActionFn, ListActionState } from "../_contracts/list-actions";
import { ListItemRow, type ListItemRowProps } from "./ListItemRow";
import {
  NOTE_ERROR,
  PRIORITY_ERROR,
  QUANTITY_ERROR,
  QUANTITY_PATTERN,
  priorityLabel,
  validateNote,
  validatePriority,
  validateQuantity,
} from "./list-item-validation";
import { expectFocused } from "@/test/dom-assertions";

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

function makeItem(overrides: Partial<ListItemView> = {}): ListItemView {
  return {
    listId: "L1",
    productId: "p1",
    quantityDesired: 2,
    priority: 1,
    priceAtAddCents: 20400,
    note: null,
    addedAt: "2026-11-01T10:00:00.000Z",
    product,
    priceDroppedByCents: null,
    purchasedSinceAdded: false,
    available: true,
    ...overrides,
  };
}

const ok = (kind: "updated" | "removed" | "moved", message: string): ListActionState => ({ ok: true, kind, message, listId: "L1" });

function setup(
  props: Partial<ListItemRowProps> = {},
  results: { update?: ListActionState; remove?: ListActionState; move?: ListActionState } = {},
) {
  const update = recording(results.update ?? ok("updated", "List item updated."));
  const remove = recording(results.remove ?? ok("removed", "Removed from your list."));
  const move = recording(results.move ?? ok("moved", "Item moved."));
  const cartCalls: Posted[] = [];
  const addToCart = async (formData: FormData) => {
    cartCalls.push({ productId: String(formData.get("productId")) });
  };
  const utils = render(
    <ul>
      <ListItemRow
        item={makeItem()}
        listId="L1"
        otherLists={[{ id: "L2", name: "Birthday" }]}
        actions={{ update: update.action, remove: remove.action, move: move.action, addToCart }}
        {...props}
      />
    </ul>,
  );
  return { ...utils, updateCalls: update.calls, removeCalls: remove.calls, moveCalls: move.calls, cartCalls };
}

const noop: ListActionFn = async () => null;
const noopActions = { update: noop, remove: noop, move: noop };

function formOf(el: HTMLElement): HTMLFormElement {
  const form = el.closest("form");
  if (!form) throw new Error("no form");
  return form;
}

describe("ListItemRow display", () => {
  test("thumb alt, name link, current price; li root", () => {
    const { container } = setup();
    expect(container.querySelector("li")).not.toBeNull();
    expect(screen.getByRole("img", { name: "Oak Desk" })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Oak Desk" });
    expect(link).toHaveAttribute("href", "/products/oak-desk");
    expect(screen.getByRole("heading", { level: 3, name: "Oak Desk" })).toBeInTheDocument();
    expect(screen.getByText("$199.00")).toBeInTheDocument();
    expect(screen.queryByText(/Price dropped/)).toBeNull();
    expect(screen.queryByText("Purchased")).toBeNull();
    expect(screen.queryByText("Out of stock")).toBeNull();
  });

  test('slugs that fail isAllowedInternalHref ("..", ".") keep the name as plain text in the heading (D-T85-1)', () => {
    for (const slug of ["..", "."]) {
      const { unmount } = setup({ item: makeItem({ product: { ...product, slug } }) });
      expect(screen.queryByRole("link", { name: "Oak Desk" })).toBeNull();
      expect(screen.getByRole("heading", { level: 3, name: "Oak Desk" })).toBeInTheDocument();
      unmount();
    }
    setup({ item: makeItem({ product: { ...product, slug: "oak desk" } }), readOnly: true });
    expect(screen.getByRole("link", { name: "Oak Desk" })).toHaveAttribute("href", "/products/oak%20desk");
  });

  test("price drop, purchased and out-of-stock states are text", () => {
    setup({ item: makeItem({ priceDroppedByCents: 500, purchasedSinceAdded: true, available: false }) });
    expect(screen.getByText("Price dropped by $5.00")).toBeInTheDocument();
    expect(screen.getByText("Purchased")).toBeInTheDocument();
    expect(screen.getByText("Out of stock")).toBeInTheDocument();
  });

  test("quantity wanted and priority shown as text", () => {
    setup({ item: makeItem({ quantityDesired: 3, priority: 2 }) });
    const dl = document.querySelector("dl");
    expect(dl).toHaveTextContent("Wants:3");
    expect(dl).toHaveTextContent("Priority:High");
  });

  test("hostile note and name render as text only", () => {
    const hostile = '<script>alert("x")</script><b>bold</b>';
    const html = renderToStaticMarkup(
      <ListItemRow
        item={makeItem({ note: hostile, product: { ...product, name: '<img src=x onerror="1">' } })}
        listId="L1"
        otherLists={[]}
        actions={noopActions}
      />,
    );
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>bold");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    setup({ item: makeItem({ note: hostile }) });
    expect(screen.getByTestId("list-item-note")).toHaveTextContent(hostile);
  });

  test("readOnly: no forms or buttons, text intact", () => {
    const { container } = setup({ readOnly: true, item: makeItem({ note: "For the study" }) });
    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("For the study")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Oak Desk" })).toBeInTheDocument();
  });

  test("vanished product: message + remove form only", async () => {
    const { container, removeCalls } = setup({ item: makeItem({ product: null, available: false }) });
    expect(screen.getByText("This item is no longer available")).toBeInTheDocument();
    expect(container.querySelectorAll("form")).toHaveLength(1);
    const del = screen.getByRole("button", { name: "Delete unavailable item" });
    fireEvent.click(del);
    await waitFor(() => expect(removeCalls).toHaveLength(1));
    expect(removeCalls[0]).toEqual({ listId: "L1", productId: "p1" });
  });

  test("vanished product read-only: no form", () => {
    const { container } = setup({ readOnly: true, item: makeItem({ product: null }) });
    expect(container.querySelectorAll("form")).toHaveLength(0);
  });
});

describe("ListItemRow static markup (no JS)", () => {
  test("plain forms with hidden fields, native limits, no JS-only state", () => {
    const html = renderToStaticMarkup(
      <ListItemRow
        item={makeItem({ note: "hi" })}
        listId="L1"
        otherLists={[{ id: "L2", name: "Birthday" }]}
        actions={{ ...noopActions, addToCart: async () => {} }}
      />,
    );
    expect(html.match(/<form/g)).toHaveLength(4);
    expect(html.match(/type="hidden" name="listId" value="L1"/g)).toHaveLength(3);
    expect(html).toContain('type="hidden" name="productId" value="p1"');
    expect(html).toContain('name="quantityDesired"');
    expect(html).toMatch(/min="1"[^>]*max="99"|max="99"[^>]*min="1"/);
    expect(html).toContain('maxLength="200"');
    expect(html).toContain('name="priority"');
    expect(html).toContain('name="toListId"');
    expect(html).not.toContain("noValidate");
    expect(html).not.toContain("novalidate");
    expect(html).not.toContain('role="alert"');
  });
});

describe("ListItemRow update form", () => {
  test("priority select: Low/Medium/High mapped to 0/1/2, current value selected", () => {
    setup();
    const select = screen.getByRole("combobox", { name: "Priority" });
    const options = within(select).getAllByRole("option");
    expect(options.map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["0", "Low"],
      ["1", "Medium"],
      ["2", "High"],
    ]);
    expect(select).toHaveValue("1");
  });

  test("valid submit posts listId, productId, quantity, priority, note and announces", async () => {
    const { updateCalls } = setup();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity wanted" }), { target: { value: "5" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Priority" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Gift" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Oak Desk" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({ listId: "L1", productId: "p1", quantityDesired: "5", priority: "2", note: "Gift" });
    await waitFor(() => expect(screen.getByText("List item updated.")).toBeInTheDocument());
  });

  test.each(["0", "100"])("quantity %s: inline error, aria-invalid, submit blocked, focus moves", async (value) => {
    const { updateCalls } = setup();
    const qty = screen.getByRole("spinbutton", { name: "Quantity wanted" });
    fireEvent.change(qty, { target: { value } });
    expect(screen.getByText(QUANTITY_ERROR)).toBeInTheDocument();
    expect(qty).toHaveAttribute("aria-invalid", "true");
    qty.blur();
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Oak Desk" }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateCalls).toHaveLength(0);
    expectFocused(qty);
  });

  test("empty quantity is invalid too", () => {
    setup();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity wanted" }), { target: { value: "" } });
    expect(screen.getByText(QUANTITY_ERROR)).toBeInTheDocument();
  });

  test("hint text mirrors the server range", () => {
    setup();
    expect(screen.getByText("Whole number, 1 to 99.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveAttribute("maxLength", "200");
  });

  test("server fieldErrors show inline and the details open; other errors go to role=alert", async () => {
    const { updateCalls } = setup(
      {},
      {
        update: {
          ok: false,
          error: appError("INVALID_QUANTITY", "Please enter a whole number from 1 to 99."),
          message: "Please enter a whole number from 1 to 99.",
          fieldErrors: { quantityDesired: "Server says no" },
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Oak Desk" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(await screen.findByText("Server says no")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Quantity wanted" })).toHaveAttribute("aria-invalid", "true");
    expect(document.querySelector("details")).toHaveAttribute("open");
    // Editing the field hides the stale server error.
    fireEvent.change(screen.getByRole("spinbutton", { name: "Quantity wanted" }), { target: { value: "3" } });
    expect(screen.queryByText("Server says no")).toBeNull();
  });

  test("non-field error (NOT_FOUND) shows in role=alert", async () => {
    setup({}, { update: { ok: false, error: appError("NOT_FOUND", "Gone"), message: "Gone" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes to Oak Desk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Gone");
  });

  test("re-syncs field values when the item changes", () => {
    const { rerender } = setup();
    rerender(
      <ul>
        <ListItemRow item={makeItem({ quantityDesired: 7, priority: 0, note: "new" })} listId="L1" otherLists={[]} actions={noopActions} />
      </ul>,
    );
    expect(screen.getByRole("spinbutton", { name: "Quantity wanted" })).toHaveValue(7);
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("0");
    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("new");
  });
});

describe("ListItemRow move / remove / add to cart", () => {
  test("move posts listId, toListId, productId", async () => {
    const { moveCalls } = setup({ otherLists: [{ id: "L2", name: "Birthday" }, { id: "L3", name: "Kitchen" }] });
    const select = screen.getByRole("combobox", { name: "Move to" });
    expect(select).toHaveAttribute("name", "toListId");
    fireEvent.change(select, { target: { value: "L3" } });
    fireEvent.click(screen.getByRole("button", { name: "Move Oak Desk" }));
    await waitFor(() => expect(moveCalls).toHaveLength(1));
    expect(moveCalls[0]).toEqual({ listId: "L1", productId: "p1", toListId: "L3" });
    await waitFor(() => expect(screen.getByText("Item moved.")).toBeInTheDocument());
  });

  test("no other lists: no move form", () => {
    setup({ otherLists: [] });
    expect(screen.queryByRole("button", { name: "Move Oak Desk" })).toBeNull();
  });

  test("delete has the product name in its accessible name and posts", async () => {
    const { removeCalls } = setup();
    const del = screen.getByRole("button", { name: "Delete Oak Desk" });
    expect(del).toHaveAttribute("type", "submit");
    fireEvent.submit(formOf(del));
    await waitFor(() => expect(removeCalls).toHaveLength(1));
    expect(removeCalls[0]).toEqual({ listId: "L1", productId: "p1" });
  });

  test("remove error is announced in role=alert (rate limit in minutes)", async () => {
    setup({}, { remove: { ok: false, error: appError("RATE_LIMITED", "x"), message: "x", retryAfterSeconds: 3600 } });
    fireEvent.click(screen.getByRole("button", { name: "Delete Oak Desk" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Please try again in 60 minutes.");
  });

  test("add to cart posts productId when available", async () => {
    const { cartCalls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add Oak Desk to cart" }));
    await waitFor(() => expect(cartCalls).toHaveLength(1));
    expect(cartCalls[0]).toEqual({ productId: "p1" });
  });

  test("no add to cart when unavailable or without the action", () => {
    setup({ item: makeItem({ available: false }) });
    expect(screen.queryByRole("button", { name: /Add .* to cart/ })).toBeNull();
  });

  test("no add to cart without the action", () => {
    render(
      <ul>
        <ListItemRow item={makeItem()} listId="L1" otherLists={[]} actions={noopActions} />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: /Add .* to cart/ })).toBeNull();
  });

  test("keyboard: every control is a native focusable element", () => {
    setup();
    for (const button of screen.getAllByRole("button")) {
      expect(button.tagName).toBe("BUTTON");
    }
    const summary = document.querySelector("summary");
    expect(summary).not.toBeNull();
  });
});

describe("list-item-validation", () => {
  test("quantity mirrors 1..99 digits only", () => {
    expect(validateQuantity("1")).toBeNull();
    expect(validateQuantity("99")).toBeNull();
    expect(validateQuantity(" 5 ")).toBeNull();
    for (const bad of ["0", "100", "-1", "1.5", "abc", "", "1e2"]) expect(validateQuantity(bad)).toBe(QUANTITY_ERROR);
  });

  test("validateQuantity mirrors the server pattern /^\\d{1,2}$/ (D-T60-1)", () => {
    for (const bad of ["001", "010", "099", "0099", "\u0661", "\uFF11"]) expect(validateQuantity(bad)).toBe(QUANTITY_ERROR);
    for (const ok of ["01", "09", "10", "50"]) expect(validateQuantity(ok)).toBeNull();
    expect(QUANTITY_PATTERN.source).toBe("^\\d{1,2}$");
  });
  test("priority 0/1/2 only", () => {
    expect(validatePriority("0")).toBeNull();
    expect(validatePriority("2")).toBeNull();
    expect(validatePriority("3")).toBe(PRIORITY_ERROR);
    expect(validatePriority("")).toBe(PRIORITY_ERROR);
  });
  test("note up to 200 chars", () => {
    expect(validateNote("a".repeat(200))).toBeNull();
    expect(validateNote("a".repeat(201))).toBe(NOTE_ERROR);
  });
  test("priority labels", () => {
    expect([0, 1, 2].map(priorityLabel)).toEqual(["Low", "Medium", "High"]);
  });
});
