import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { fail, ok } from "@/lib/result";
import type { CartActionFn, CartActionState } from "../_contracts/cart-actions";
import { CartLineItem, type CartLineItemData } from "./CartLineItem";

type Call = { productId: FormDataEntryValue | null; quantity: FormDataEntryValue | null };

function recordingAction(result: CartActionState): { action: CartActionFn; calls: Call[] } {
  const calls: Call[] = [];
  const action: CartActionFn = async (_prev, formData) => {
    calls.push({ productId: formData.get("productId"), quantity: formData.get("quantity") });
    return result;
  };
  return { action, calls };
}

const success = ok({ itemCount: 1, subtotalCents: 2500, message: "Cart updated" });

const baseItem: CartLineItemData = {
  productId: "p1",
  name: "Canvas Tote",
  slug: "canvas-tote",
  imageUrl: "/images/tote.jpg",
  quantity: 2,
  unitPriceCents: 1250,
  lineTotalCents: 2500,
  availableStock: 5,
  status: "ok",
};

function renderItem(
  item: Partial<CartLineItemData> = {},
  actions: { update?: CartActionFn; remove?: CartActionFn } = {},
) {
  const update = recordingAction(success);
  const remove = recordingAction(success);
  const utils = render(
    <CartLineItem
      item={{ ...baseItem, ...item }}
      currency="USD"
      updateQuantity={actions.update ?? update.action}
      removeItem={actions.remove ?? remove.action}
    />,
  );
  return { ...utils, updateCalls: update.calls, removeCalls: remove.calls };
}

function formOf(el: HTMLElement): HTMLFormElement {
  const form = el.closest("form");
  if (!form) throw new Error("form not found");
  return form;
}

describe("CartLineItem", () => {
  test("renders name as plain text, unit price, and line total from lineTotalCents", () => {
    renderItem();
    const name = screen.getByText("Canvas Tote");
    expect(name.closest("a")).toBeNull();
    expect(screen.getByText("$12.50")).toBeInTheDocument();
    expect(screen.getByTestId("line-total")).toHaveTextContent("$25.00");
  });

  test("line total equals unit price x quantity for a multi-unit line", () => {
    renderItem({ quantity: 3, unitPriceCents: 1999, lineTotalCents: 5997 });
    expect(screen.getByTestId("line-total")).toHaveTextContent("$59.97");
    expect(1999 * 3).toBe(5997);
  });

  test("remove button: native button whose accessible name includes the product name", () => {
    renderItem();
    const remove = screen.getByRole("button", { name: "Remove Canvas Tote" });
    expect(remove.tagName).toBe("BUTTON");
    expect(remove).toHaveAttribute("type", "submit");
    const form = formOf(remove);
    expect(form.querySelector('input[type="hidden"][name="productId"]')).toHaveAttribute("value", "p1");
  });

  test("D-T161-1: remove button uses the danger role and keeps its visible text label", () => {
    renderItem();
    const remove = screen.getByRole("button", { name: "Remove Canvas Tote" });
    expect(remove).toHaveTextContent("Remove");
    expect(remove).toHaveClass("bg-danger");
    expect(remove).not.toHaveClass("bg-transparent");
    expect(remove).not.toHaveClass("text-accent");
  });

  test("remove form submits productId", async () => {
    const { removeCalls } = renderItem();
    fireEvent.submit(formOf(screen.getByRole("button", { name: "Remove Canvas Tote" })));
    await waitFor(() => expect(removeCalls).toHaveLength(1));
    expect(removeCalls[0]?.productId).toBe("p1");
  });

  test("quantity stepper is labelled per product, named for no-JS posts, with a native Update submit", () => {
    renderItem();
    const qty = screen.getByRole("textbox", { name: "Quantity for Canvas Tote" });
    expect(qty).toHaveAttribute("name", "quantity");
    expect(qty).toHaveValue("2");
    const updateBtn = screen.getByRole("button", { name: "Update quantity for Canvas Tote" });
    expect(updateBtn.tagName).toBe("BUTTON");
    expect(updateBtn).toHaveAttribute("type", "submit");
    expect(updateBtn).toHaveClass("sr-only");
    const form = formOf(qty);
    expect(form).toBe(formOf(updateBtn));
    expect(form.querySelector('input[type="hidden"][name="productId"]')).toHaveAttribute("value", "p1");
  });

  test("changing the stepper auto-submits the new quantity", async () => {
    const { updateCalls } = renderItem();
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({ productId: "p1", quantity: "3" });
  });

  test("keyboard: ArrowDown on the stepper auto-submits", async () => {
    const { updateCalls } = renderItem();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quantity for Canvas Tote" }), { key: "ArrowDown" });
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]?.quantity).toBe("1");
  });

  test("no-JS path: submitting the update form posts the current quantity", async () => {
    const { updateCalls } = renderItem();
    fireEvent.submit(formOf(screen.getByRole("button", { name: "Update quantity for Canvas Tote" })));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({ productId: "p1", quantity: "2" });
  });

  test("stepper max equals available stock", () => {
    renderItem({ quantity: 3, availableStock: 3, lineTotalCents: 3750 });
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
  });

  test("local quantity re-syncs when the server sends a new quantity", () => {
    const update = recordingAction(success);
    const remove = recordingAction(success);
    const { rerender } = render(
      <CartLineItem item={baseItem} currency="USD" updateQuantity={update.action} removeItem={remove.action} />,
    );
    rerender(
      <CartLineItem
        item={{ ...baseItem, quantity: 1, availableStock: 1, lineTotalCents: 1250, status: "reduced" }}
        currency="USD"
        updateQuantity={update.action}
        removeItem={remove.action}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Quantity for Canvas Tote" })).toHaveValue("1");
    expect(screen.getByTestId("line-total")).toHaveTextContent("$12.50");
  });

  test("unavailable: status message and disabled stepper; remove still works", () => {
    renderItem({ status: "unavailable", availableStock: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("No longer available");
    expect(screen.getByRole("textbox", { name: "Quantity for Canvas Tote" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Canvas Tote" })).toBeEnabled();
  });

  test("reduced: explains the adjustment", () => {
    renderItem({ status: "reduced", quantity: 2, availableStock: 2 });
    expect(screen.getByText("Only 2 left. Lower the quantity to continue.")).toBeInTheDocument();
  });

  test("update error is shown with role=alert", async () => {
    const update = recordingAction(fail("INSUFFICIENT_STOCK", "Only 5 left in stock."));
    renderItem({}, { update: update.action });
    fireEvent.submit(formOf(screen.getByRole("button", { name: "Update quantity for Canvas Tote" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 5 left in stock.");
  });

  test("remove error is shown with role=alert", async () => {
    const remove = recordingAction(fail("PRODUCT_NOT_FOUND", "Could not remove item."));
    renderItem({}, { remove: remove.action });
    fireEvent.submit(formOf(screen.getByRole("button", { name: "Remove Canvas Tote" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not remove item.");
  });

  test("remove button shows loading while pending and ignores repeat clicks", async () => {
    let count = 0;
    let resolve: (s: CartActionState) => void = () => {};
    const pending: CartActionFn = () => {
      count += 1;
      return new Promise<CartActionState>((r) => {
        resolve = r;
      });
    };
    renderItem({}, { remove: pending });
    const remove = screen.getByRole("button", { name: "Remove Canvas Tote" });
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toHaveAttribute("aria-busy", "true"));
    expect(remove).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(remove);
    await new Promise((r) => setTimeout(r, 20));
    expect(count).toBe(1);
    expect(within(remove).getByRole("status")).toHaveTextContent("Loading");
    await act(async () => resolve(success));
    await waitFor(() => expect(remove).not.toHaveAttribute("aria-busy"));
  });

  test("update success is announced in an always-rendered polite sr-only region", async () => {
    renderItem();
    const region = screen.getByTestId("line-status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveClass("sr-only");
    expect(region).toBeEmptyDOMElement();
    fireEvent.submit(formOf(screen.getByRole("button", { name: "Update quantity for Canvas Tote" })));
    await waitFor(() => expect(region).toHaveTextContent("Cart updated"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("after a rejected update the stepper reverts to the server quantity", async () => {
    const update = recordingAction(fail("INSUFFICIENT_STOCK", "Only 2 left in stock."));
    renderItem({}, { update: update.action });
    const qty = screen.getByRole("textbox", { name: "Quantity for Canvas Tote" });
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    await screen.findByRole("alert");
    expect(update.calls[0]?.quantity).toBe("3");
    expect(qty).toHaveValue("2");
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -3, 2.5])(
    "availableStock %p is normalised to 0 (no NaN in the stepper)",
    (availableStock) => {
      renderItem({ quantity: 1, lineTotalCents: 1250, availableStock, status: "reduced" });
      const qty = screen.getByRole("textbox", { name: "Quantity for Canvas Tote" });
      expect(qty).toHaveValue("1");
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
      expect(screen.getByText("Only 0 left. Lower the quantity to continue.")).toBeInTheDocument();
    },
  );
});
