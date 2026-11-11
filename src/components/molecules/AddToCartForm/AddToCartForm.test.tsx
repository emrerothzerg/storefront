import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fail, ok } from "@/lib/result";
import type { CartActionFn, CartActionState } from "../_contracts/cart-actions";
import { AddToCartForm } from "./AddToCartForm";

type Call = { productId: FormDataEntryValue | null; quantity: FormDataEntryValue | null };

function recordingAction(result: CartActionState): { action: CartActionFn; calls: Call[] } {
  const calls: Call[] = [];
  const action: CartActionFn = async (_prev, formData) => {
    calls.push({ productId: formData.get("productId"), quantity: formData.get("quantity") });
    return result;
  };
  return { action, calls };
}

function controlledAction(): {
  action: CartActionFn;
  calls: Call[];
  resolve: (state: CartActionState) => void;
} {
  const calls: Call[] = [];
  let resolveFn: (state: CartActionState) => void = () => {};
  const action: CartActionFn = (_prev, formData) => {
    calls.push({ productId: formData.get("productId"), quantity: formData.get("quantity") });
    return new Promise<CartActionState>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s) => resolveFn(s) };
}

const success = ok({ itemCount: 2, subtotalCents: 4000, message: "Added to cart" });

function getForm(): HTMLFormElement {
  const button = screen.getByRole("button", { name: /add to cart/i });
  const form = button.closest("form");
  if (!form) throw new Error("form not found");
  return form;
}

describe("AddToCartForm", () => {
  test("renders a progressive-enhancement form: hidden productId, named quantity, native submit button", () => {
    const { action } = recordingAction(success);
    const { container } = render(<AddToCartForm productId="p1" stock={5} addToCart={action} id="qty" />);
    const hidden = container.querySelector('input[type="hidden"][name="productId"]');
    expect(hidden).toHaveAttribute("value", "p1");
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    expect(qty).toHaveAttribute("name", "quantity");
    expect(qty).toHaveAttribute("id", "qty");
    const submit = screen.getByRole("button", { name: "Add to cart" });
    expect(submit.tagName).toBe("BUTTON");
    expect(submit).toHaveAttribute("type", "submit");
  });

  test("submits productId and the chosen quantity as FormData strings", async () => {
    const { action, calls } = recordingAction(success);
    render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    fireEvent.submit(getForm());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ productId: "p1", quantity: "3" });
  });

  test("keyboard: ArrowUp on the stepper changes the posted quantity", async () => {
    const { action, calls } = recordingAction(success);
    render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "ArrowUp" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("5");
    fireEvent.submit(getForm());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.quantity).toBe("5");
  });

  test("shows loading + aria-disabled while pending and ignores a second click", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    const submit = screen.getByRole("button", { name: /add to cart/i });
    fireEvent.click(submit);
    await waitFor(() => expect(submit).toHaveAttribute("aria-busy", "true"));
    expect(submit).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Loading");

    fireEvent.click(submit);
    fireEvent.click(submit);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(1);

    await act(async () => resolve(success));
    await waitFor(() => expect(submit).not.toHaveAttribute("aria-busy"));
    expect(calls).toHaveLength(1);
  });

  test("never-resolving action is called exactly once despite repeated clicks", async () => {
    // Never resolves during the test. It is settled in `finally` only because React
    // entangles pending async actions globally, which would stall later tests.
    let count = 0;
    let release: () => void = () => {};
    const neverResolves: CartActionFn = () => {
      count += 1;
      return new Promise<CartActionState>((res) => {
        release = () => res(null);
      });
    };
    try {
      render(<AddToCartForm productId="p1" stock={5} addToCart={neverResolves} />);
      const submit = screen.getByRole("button", { name: /add to cart/i });
      fireEvent.click(submit);
      await waitFor(() => expect(submit).toHaveAttribute("aria-busy", "true"));
      for (let i = 0; i < 5; i += 1) fireEvent.click(submit);
      fireEvent.keyDown(submit, { key: "Enter" });
      await new Promise((r) => setTimeout(r, 50));
      expect(count).toBe(1);
      expect(submit).toHaveAttribute("aria-busy", "true");
    } finally {
      await act(async () => release());
    }
  });

  test("out of stock: disabled 'Out of stock' button and no stepper", () => {
    const { action } = recordingAction(success);
    render(<AddToCartForm productId="p1" stock={0} addToCart={action} />);
    const button = screen.getByRole("button", { name: "Out of stock" });
    expect(button).toBeDisabled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("button", { name: /add to cart/i })).toBeNull();
  });

  test("negative stock is also out of stock", () => {
    const { action } = recordingAction(success);
    render(<AddToCartForm productId="p1" stock={-3} addToCart={action} />);
    expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
  });

  test("server error is shown inline with role=alert", async () => {
    const { action } = recordingAction(fail("INSUFFICIENT_STOCK", "Only 2 left in stock."));
    render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    fireEvent.submit(getForm());
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Only 2 left in stock.");
    expect(alert.tagName).toBe("P");
    expect(alert).toHaveClass("text-danger", "text-small");
  });

  test("success message is announced in a polite live region", async () => {
    const { action } = recordingAction(success);
    const { container } = render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    const region = container.querySelector('[aria-live="polite"][aria-atomic="true"]:not(.sr-only)');
    expect(region).not.toBeNull();
    expect(region).toBeEmptyDOMElement();
    fireEvent.submit(getForm());
    await waitFor(() => expect(region).toHaveTextContent("Added to cart"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("stepper max equals min(stock, maxQuantity)", () => {
    const { action } = recordingAction(success);
    const { unmount } = render(<AddToCartForm productId="p1" stock={3} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("3");
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    unmount();

    render(<AddToCartForm productId="p1" stock={50} maxQuantity={4} addToCart={action} />);
    const qty2 = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty2, { key: "End" });
    expect(qty2).toHaveValue("4");
  });

  test("quantity clamps when stock lowers, and posts the clamped value", async () => {
    const { action, calls } = recordingAction(success);
    const { rerender } = render(<AddToCartForm productId="p1" stock={10} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("10");

    rerender(<AddToCartForm productId="p1" stock={4} addToCart={action} />);
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveValue("4");
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    fireEvent.submit(getForm());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.quantity).toBe("4");

    rerender(<AddToCartForm productId="p1" stock={0} addToCart={action} />);
    expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3, 2.5])(
    "invalid stock %p renders the disabled Out of stock button and no stepper",
    (stock) => {
      const { action } = recordingAction(success);
      render(<AddToCartForm productId="p1" stock={stock} addToCart={action} />);
      expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByText("NaN")).toBeNull();
      expect(screen.queryByRole("button", { name: /add to cart/i })).toBeNull();
    },
  );

  test("invalid maxQuantity falls back to the default cap", () => {
    const { action } = recordingAction(success);
    render(<AddToCartForm productId="p1" stock={5} maxQuantity={Number.NaN} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("5");
  });
});
