import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { fail, ok } from "@/lib/result";
import type { CartActionFnV2, CartActionStateV2 } from "@/components/molecules/_contracts/cart-actions";
import type { ListActionFn, ListActionState } from "@/components/molecules/_contracts/list-actions";
import type { Product } from "@/lib/types";
import type { SavedForLaterLine } from "@/server/cart/cart-service";
import {
  SavedForLaterSection,
  priceDropText,
  savedAvailability,
  savedHeading,
  savedProductHref,
  type SavedForLaterActions,
  type SavedForLaterSectionProps,
} from "./SavedForLaterSection";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "p1",
    slug: "blue-mug",
    name: "Blue Mug",
    description: "A mug.",
    priceCents: 1250,
    currency: "USD",
    imageUrl: "/images/blue-mug.jpg",
    stock: 4,
    ...overrides,
  };
}

function saved(overrides: Partial<SavedForLaterLine> = {}): SavedForLaterLine {
  return {
    productId: "p1",
    product: product(),
    quantityDesired: 1,
    available: true,
    priceCents: 1250,
    priceDroppedByCents: null,
    addedAt: "2026-11-07T10:00:00.000Z",
    ...overrides,
  };
}

type Posted = Record<string, FormDataEntryValue>;

function cartRecorder(result: CartActionStateV2) {
  const calls: Posted[] = [];
  const action: CartActionFnV2 = async (_p, fd) => {
    calls.push(Object.fromEntries(fd.entries()));
    return result;
  };
  return { action, calls };
}

function listRecorder(result: ListActionState) {
  const calls: Posted[] = [];
  const action: ListActionFn = async (_p, fd) => {
    calls.push(Object.fromEntries(fd.entries()));
    return result;
  };
  return { action, calls };
}

const movedOk = ok({ itemCount: 1, subtotalCents: 1250, message: "Moved to cart", kind: "moved" as const });
const removedOk: ListActionState = { ok: true, kind: "removed", message: "Removed" };

function ui(props: Partial<Omit<SavedForLaterSectionProps, "actions">> & { actions?: Partial<SavedForLaterActions> } = {}) {
  const { actions, ...rest } = props;
  return (
    <SavedForLaterSection
      items={[saved()]}
      saveForLaterListId="sfl-1"
      {...rest}
      actions={{
        moveToCart: actions?.moveToCart ?? cartRecorder(movedOk).action,
        removeSaved: actions?.removeSaved ?? listRecorder(removedOk).action,
        addToList: actions?.addToList,
      }}
    />
  );
}

describe("SavedForLaterSection", () => {
  test("hidden when empty: no section, heading or forms; only an empty polite live region", () => {
    const { container } = render(ui({ items: [] }));
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(container.querySelector("form")).toBeNull();
    const live = screen.getByTestId("saved-live-region");
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toBeEmptyDOMElement();
  });

  test("labelled section with heading count, list semantics and configurable heading level", () => {
    const { unmount } = render(ui({ items: [saved(), saved({ productId: "p2", product: product({ id: "p2", name: "Red Mug", slug: "red-mug" }) })] }));
    const region = screen.getByRole("region", { name: "Saved for later (2 items)" });
    expect(within(region).getByRole("heading", { level: 2 })).toHaveTextContent("Saved for later (2 items)");
    expect(within(region).getAllByRole("listitem")).toHaveLength(2);
    unmount();
    render(ui({ headingLevel: 3 }));
    expect(screen.getByRole("heading", { level: 3, name: "Saved for later (1 item)" })).toBeInTheDocument();
  });

  test("row: thumbnail, name link, current price, availability text", () => {
    render(ui());
    expect(screen.getByRole("img", { name: "Blue Mug" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Blue Mug" })).toHaveAttribute("href", "/products/blue-mug");
    // 44px touch target (D-T82-3).
    expect(screen.getByRole("link", { name: "Blue Mug" }).className).toContain("min-h-touch");
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByTestId("saved-availability")).toHaveTextContent("In stock");
    expect(screen.queryByText(/Price dropped/)).toBeNull();
  });

  test("price drop shown as text", () => {
    render(ui({ items: [saved({ priceCents: 1000, priceDroppedByCents: 250 })] }));
    expect(screen.getByText("Price dropped by $2.50")).toBeInTheDocument();
  });

  test("out of stock: availability text and disabled Move button with explanatory description", () => {
    render(ui({ items: [saved({ available: false, product: product({ stock: 0 }) })] }));
    expect(screen.getByTestId("saved-availability")).toHaveTextContent("Out of stock");
    const btn = screen.getByRole("button", { name: "Unavailable: Blue Mug" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent("Unavailable");
    expect(btn).toHaveAccessibleDescription("Out of stock");
    // Delete still works.
    expect(screen.getByRole("button", { name: "Delete: Blue Mug" })).toBeEnabled();
  });

  test("vanished product: placeholder name, no link, no price, 'No longer available', Delete only", () => {
    render(ui({ items: [saved({ product: null, available: false, priceCents: null })], actions: { addToList: listRecorder(null).action } }));
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Unavailable product")).toBeInTheDocument();
    expect(screen.getByTestId("saved-availability")).toHaveTextContent("No longer available");
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.getByRole("button", { name: "Unavailable: Unavailable product" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Wish List/ })).toBeNull();
  });

  test("Move to cart: native form posting only productId", async () => {
    const move = cartRecorder(movedOk);
    render(ui({ actions: { moveToCart: move.action } }));
    const btn = screen.getByRole("button", { name: "Move to cart: Blue Mug" });
    expect(btn).toHaveAttribute("type", "submit");
    const hidden = btn.closest("form")!.querySelectorAll('input[type="hidden"]');
    expect(hidden).toHaveLength(1);
    fireEvent.click(btn);
    await waitFor(() => expect(move.calls).toHaveLength(1));
    expect(move.calls[0]).toEqual({ productId: "p1" });
  });

  test("Move to cart OUT_OF_STOCK: line-level role=alert inside that row only", async () => {
    const move = cartRecorder(fail("OUT_OF_STOCK", "Red Mug is out of stock."));
    render(
      ui({
        items: [saved(), saved({ productId: "p2", product: product({ id: "p2", name: "Red Mug", slug: "red-mug" }) })],
        actions: { moveToCart: move.action },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move to cart: Red Mug" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Red Mug is out of stock.");
    const rows = screen.getAllByRole("listitem");
    expect(rows[1]!.contains(alert)).toBe(true);
    expect(rows[0]!.contains(alert)).toBe(false);
  });

  test("Delete: posts listId + productId; name in accessible name", async () => {
    const remove = listRecorder(removedOk);
    render(ui({ actions: { removeSaved: remove.action } }));
    fireEvent.click(screen.getByRole("button", { name: "Delete: Blue Mug" }));
    await waitFor(() => expect(remove.calls).toHaveLength(1));
    expect(remove.calls[0]).toEqual({ listId: "sfl-1", productId: "p1" });
  });

  test("Delete errors: role=alert, RATE_LIMITED rebuilt from retryAfterSeconds", async () => {
    const remove = listRecorder({
      ok: false,
      error: { code: "RATE_LIMITED", message: "Slow down" },
      message: "Slow down",
      retryAfterSeconds: 90,
    });
    render(ui({ actions: { removeSaved: remove.action } }));
    fireEvent.click(screen.getByRole("button", { name: "Delete: Blue Mug" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. Please try again in 2 minutes.");
  });

  test("no saveForLaterListId: Delete is not rendered (nothing valid to post)", () => {
    render(ui({ saveForLaterListId: null }));
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Move to cart: Blue Mug" })).toBeInTheDocument();
  });

  test("optional Add to list: WishlistButton form with the product name", async () => {
    const add = listRecorder({ ok: true, kind: "added", message: "Added", listId: "wl-1" });
    render(ui({ actions: { addToList: add.action } }));
    const btn = screen.getByRole("button", { name: "Add Blue Mug to Wish List" });
    fireEvent.click(btn);
    await waitFor(() => expect(add.calls).toHaveLength(1));
    expect(add.calls[0]).toMatchObject({ productId: "p1", productSlug: "blue-mug" });
  });

  test("server markup: plain forms with hidden fields, no JS requirement", () => {
    const html = renderToStaticMarkup(ui());
    expect((html.match(/<form/g) ?? []).length).toBe(2);
    expect(html).toContain('type="hidden" name="productId" value="p1"');
    expect(html).toContain('type="hidden" name="listId" value="sfl-1"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Move to cart<\/button>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Delete<\/button>/);
  });

  test("hostile names render as text only", () => {
    const name = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const { container } = render(ui({ items: [saved({ product: product({ name }) })] }));
    expect(container.querySelector("script, img[src='x']")).toBeNull();
    expect(screen.getByRole("link", { name })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Delete: ${name}` })).toBeInTheDocument();
    const html = renderToStaticMarkup(ui({ items: [saved({ product: product({ name }) })] }));
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(1)");
  });

  test("live region announces count changes, including becoming empty", () => {
    const { rerender } = render(ui({ items: [saved(), saved({ productId: "p2" })] }));
    expect(screen.getByTestId("saved-live-region")).toBeEmptyDOMElement();
    rerender(ui({ items: [saved()] }));
    expect(screen.getByTestId("saved-live-region")).toHaveTextContent("Saved for later (1 item)");
    rerender(ui({ items: [] }));
    expect(screen.getByTestId("saved-live-region")).toHaveTextContent("Saved for later is empty");
    expect(screen.queryByRole("region")).toBeNull();
  });

  test("320px: rows stack and wrap", () => {
    render(ui());
    const row = screen.getByRole("listitem");
    expect(row).toHaveClass("min-w-0");
    expect(row.firstElementChild).toHaveClass("flex-col", "min-w-0");
    expect(screen.getByRole("button", { name: /Move to cart/ }).closest("form")!.parentElement).toHaveClass("flex-wrap");
  });

  test("T161: section is a raised Card; price is superscript with the full amount spoken; Delete is a danger pill with a text label", () => {
    render(ui());
    const region = screen.getByRole("region", { name: "Saved for later (1 item)" });
    expect(region.tagName).toBe("SECTION");
    expect(region).toHaveClass("bg-surface-raised", "rounded-lg", "border-border-default", "min-w-0");
    expect(screen.getByText("$12.50")).toHaveClass("sr-only");
    expect(region.querySelector('[data-slot="price-superscript"]')?.getAttribute("aria-hidden")).toBe("true");
    const del = screen.getByRole("button", { name: "Delete: Blue Mug" });
    expect(del).toHaveTextContent("Delete");
    expect(del).toHaveClass("bg-danger", "rounded-full");
    expect(screen.getByRole("button", { name: "Move to cart: Blue Mug" })).toHaveClass("rounded-full");
  });
});

describe("SavedForLaterSection helpers", () => {
  test("savedAvailability", () => {
    expect(savedAvailability({ product: product(), available: true })).toBe("in_stock");
    expect(savedAvailability({ product: product(), available: false })).toBe("out_of_stock");
    expect(savedAvailability({ product: null, available: false })).toBe("gone");
    // D-T82-4: the service marks an unpublished product "unavailable".
    expect(savedAvailability({ product: product({ slug: "" }), available: false, reason: "unavailable" })).toBe("gone");
    expect(savedAvailability({ product: product(), available: true, reason: "unavailable" })).toBe("gone");
    expect(savedAvailability({ product: product(), available: true, reason: null })).toBe("in_stock");
  });

  test("priceDropText ignores zero / negative / invalid", () => {
    expect(priceDropText(250, "USD")).toBe("Price dropped by $2.50");
    expect(priceDropText(null, "USD")).toBeNull();
    expect(priceDropText(0, "USD")).toBeNull();
    expect(priceDropText(-5, "USD")).toBeNull();
    expect(priceDropText(Number.NaN, "USD")).toBeNull();
    expect(priceDropText(100, "NOPE")).toBeNull();
  });

  test("savedProductHref / savedHeading", () => {
    expect(savedProductHref("a b")).toBe("/products/a%20b");
    expect(savedProductHref("")).toBeNull();
    expect(savedProductHref(undefined)).toBeNull();
    // D-T82-2: hrefs that fail isAllowedInternalHref are dropped.
    expect(savedProductHref("..")).toBeNull();
    expect(savedProductHref(".")).toBeNull();
    expect(savedHeading(1)).toBe("Saved for later (1 item)");
    expect(savedHeading(3)).toBe("Saved for later (3 items)");
  });
});

describe("SavedForLaterSection D-T82-4: product unpublished after saving", () => {
  const withdrawn = () =>
    saved({ product: product({ slug: "" }), available: false, priceDroppedByCents: 300, reason: "unavailable" });

  test("'No longer available', name as plain text, no link, no price, Delete only (no Move / Wish List forms)", () => {
    const move = cartRecorder(movedOk);
    render(ui({ items: [withdrawn()], actions: { moveToCart: move.action, addToList: listRecorder(null).action } }));
    expect(screen.getByTestId("saved-availability")).toHaveTextContent("No longer available");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Blue Mug")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.queryByText(/Price dropped/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Move to cart|Unavailable|Wish List/ })).toBeNull();
    const del = screen.getByRole("button", { name: "Delete: Blue Mug" });
    expect(del).toBeEnabled();
    const forms = screen.getByRole("listitem").querySelectorAll("form");
    expect(forms).toHaveLength(1);
    expect(forms[0]?.contains(del)).toBe(true);
    expect(move.calls).toEqual([]);
  });

  test("even a non-empty slug is not linked when the service says 'unavailable'", () => {
    const html = renderToStaticMarkup(
      ui({ items: [saved({ available: false, reason: "unavailable" })], actions: { addToList: listRecorder(null).action } }),
    );
    expect(html).not.toContain("/products/blue-mug");
    expect(html).toContain("No longer available");
  });

  test("Delete still posts listId + productId", async () => {
    const del = listRecorder(removedOk);
    render(ui({ items: [withdrawn()], actions: { removeSaved: del.action } }));
    fireEvent.click(screen.getByRole("button", { name: "Delete: Blue Mug" }));
    await waitFor(() => expect(del.calls).toEqual([{ listId: "sfl-1", productId: "p1" }]));
  });

  test("no list id: the row has no forms at all", () => {
    render(ui({ items: [withdrawn()], saveForLaterListId: null }));
    expect(screen.getByRole("listitem").querySelectorAll("form")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  test("a published in-stock item with reason null keeps link, price, Move and Wish List", () => {
    render(ui({ items: [saved({ reason: null })], actions: { addToList: listRecorder(null).action } }));
    expect(screen.getByRole("link", { name: "Blue Mug" })).toHaveAttribute("href", "/products/blue-mug");
    expect(screen.getByRole("button", { name: "Move to cart: Blue Mug" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Wish List/ })).toBeInTheDocument();
  });
});
