// QA (T15): AddToCartForm, CartLineItem and the cart action contract.
import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AddToCartForm } from "@/components/molecules/AddToCartForm";
import { CartLineItem, type CartLineItemData } from "@/components/molecules/CartLineItem";
import {
  CART_FIELD,
  type CartActionFn,
  type CartActionState,
} from "@/components/molecules/_contracts/cart-actions";
import { fail, ok } from "@/lib/result";
import { formatMoney } from "@/lib/money";
import { ERROR_CODES } from "@/lib/types";
import { expectNull } from "@/test/dom-assertions";

type Posted = { keys: string[]; entries: Record<string, FormDataEntryValue> };

function snapshot(fd: FormData): Posted {
  const keys = [...fd.keys()];
  const entries: Record<string, FormDataEntryValue> = {};
  for (const [k, v] of fd.entries()) entries[k] = v;
  return { keys, entries };
}

/** Resolves immediately with `result`, records every call. */
function recording(result: CartActionState) {
  const calls: Posted[] = [];
  const action: CartActionFn = async (_prev, fd) => {
    calls.push(snapshot(fd));
    return result;
  };
  return { action, calls };
}

/** Never resolves until `release` is called (always call it in `finally`). */
function gated() {
  const calls: Posted[] = [];
  const resolvers: Array<(s: CartActionState) => void> = [];
  const action: CartActionFn = (_prev, fd) => {
    calls.push(snapshot(fd));
    return new Promise<CartActionState>((res) => resolvers.push(res));
  };
  const release = async (s: CartActionState = null) => {
    // Resolve everything, including actions React queued behind the first one
    // (a stuck pending action stalls every later test's actions).
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

const success = ok({ itemCount: 3, subtotalCents: 3750, message: "Added Blue Mug to cart" });

function submitButton() {
  return screen.getByRole("button", { name: /Add to cart/ });
}
function addForm(): HTMLFormElement {
  return submitButton().closest("form")!;
}

describe("T15 AddToCartForm", () => {
  test("T15.1 loading + disabled while pending; double click fires exactly one request", async () => {
    const { action, calls, release } = gated();
    try {
      render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
      const btn = submitButton();
      fireEvent.click(btn);
      await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
      expect(btn).toHaveAttribute("aria-disabled", "true");
      // Spinner (loading indicator) present inside the button.
      expect(btn.querySelector("svg, [role=status], [aria-hidden=true]")).not.toBeNull();
      fireEvent.click(btn);
      fireEvent.click(btn);
      await act(async () => {
        await Promise.resolve();
      });
      expect(calls).toHaveLength(1);
    } finally {
      await release(success);
    }
    await waitFor(() => expect(submitButton()).not.toHaveAttribute("aria-busy"));
    expect(calls).toHaveLength(1);
  });

  test("documents behaviour: a programmatic form submit during pending is queued (not blocked)", async () => {
    // Only the button click is guarded. The stepper swallows Enter, so a shopper cannot
    // trigger implicit submission from the quantity box; this is informational.
    const { action, calls, release } = gated();
    try {
      render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
      fireEvent.submit(addForm());
      await waitFor(() => expect(submitButton()).toHaveAttribute("aria-busy", "true"));
      fireEvent.submit(addForm());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(calls).toHaveLength(1);
      await release(success);
      // React runs the queued action once the first settles: a second request is sent.
      await waitFor(() => expect(calls).toHaveLength(2));
    } finally {
      await release(success);
    }
    await waitFor(() => expect(submitButton()).not.toHaveAttribute("aria-busy"));
  });

  test("Enter in the quantity box does not submit the form (prevented)", () => {
    const { action } = recording(success);
    render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    const notCancelled = fireEvent.keyDown(qty, { key: "Enter" });
    expect(notCancelled).toBe(false);
  });

  for (const [label, stock] of [
    ["0", 0],
    ["-3", -3],
  ] as const) {
    test(`T15.2 stock ${label}: disabled "Out of stock" button, no stepper, no form`, () => {
      const { action } = recording(success);
      const { container } = render(<AddToCartForm productId="p1" stock={stock} addToCart={action} />);
      const btn = screen.getByRole("button", { name: "Out of stock" });
      expect(btn).toBeDisabled();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.queryByRole("button", { name: /quantity/i })).toBeNull();
      expect(screen.queryByRole("button", { name: /Add to cart/ })).toBeNull();
      expect(container.querySelector("form")).toBeNull();
    });
  }

  test("D1 (fixed): stock NaN renders a disabled Out of stock button (as StockBadge does), not a NaN stepper", () => {
    const { action } = recording(success);
    render(<AddToCartForm productId="p1" stock={Number.NaN} addToCart={action} />);
    expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  for (const [label, stock] of [
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["2.5", 2.5],
    ["-0", -0],
  ] as const) {
    test(`hostile stock ${label}: disabled Out of stock, no stepper, no form`, () => {
      const { action } = recording(success);
      const { container } = render(<AddToCartForm productId="p1" stock={stock} addToCart={action} />);
      expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(container.querySelector("form")).toBeNull();
    });
  }

  test("hostile maxQuantity (NaN / 0) falls back to the default cap, stepper still bounded by stock", () => {
    const { action } = recording(success);
    const { unmount } = render(<AddToCartForm productId="p1" stock={4} maxQuantity={Number.NaN} addToCart={action} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quantity" }), { key: "End" });
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveValue("4");
    unmount();
    render(<AddToCartForm productId="p1" stock={4} maxQuantity={0} addToCart={action} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Quantity" }), { key: "End" });
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveValue("4");
  });

  for (const code of ERROR_CODES) {
    test(`T15.3 server error ${code}: message in role=alert, polite region empty`, async () => {
      const message = `Error for ${code}`;
      const { action } = recording(fail(code, message));
      const { container } = render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
      fireEvent.click(submitButton());
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(addForm().contains(alert)).toBe(true);
      const polite = [...container.querySelectorAll('[aria-live="polite"]')].filter((el) =>
        el.textContent?.includes("Added"),
      );
      expect(polite).toHaveLength(0);
    });
  }

  test("T15.3 success: message announced in a polite live region present before the result; no alert", async () => {
    const { action } = recording(success);
    const { container } = render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    // The polite region must exist (empty) before content arrives, or it may not announce.
    const regions = [...container.querySelectorAll('[aria-live="polite"]')];
    const outer = regions.find((el) => el.textContent === "");
    expect(outer).toBeDefined();
    fireEvent.click(submitButton());
    await waitFor(() => expect(outer!).toHaveTextContent("Added Blue Mug to cart"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("T15.3 error then success: the alert is cleared", async () => {
    let n = 0;
    const action: CartActionFn = async () => (n++ === 0 ? fail("INSUFFICIENT_STOCK", "Only 2 left") : success);
    render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    fireEvent.click(submitButton());
    await screen.findByRole("alert");
    await waitFor(() => expect(submitButton()).not.toHaveAttribute("aria-busy"));
    expect(n).toBe(1);
    fireEvent.click(submitButton());
    await waitFor(() => expect(n).toBe(2));
    await waitFor(() => expectNull(screen.queryByRole("alert")));
    expect(screen.getByText("Added Blue Mug to cart")).toBeInTheDocument();
  });

  test("T15.4 stepper max equals stock (End -> stock, Increase disabled at max)", async () => {
    const { action, calls } = recording(success);
    render(<AddToCartForm productId="p1" stock={7} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("7");
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    fireEvent.keyDown(qty, { key: "ArrowUp" });
    expect(qty).toHaveValue("7");
    fireEvent.submit(addForm());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.entries.quantity).toBe("7");
  });

  test("T15.4 maxQuantity below stock caps the stepper", () => {
    const { action } = recording(success);
    render(<AddToCartForm productId="p1" stock={50} maxQuantity={3} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("3");
  });

  test("T15.4 stock drops 5 -> 2 while value is 4: shown and posted quantity <= 2", async () => {
    const { action, calls } = recording(success);
    const { rerender } = render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(qty).toHaveValue("4");
    rerender(<AddToCartForm productId="p1" stock={2} addToCart={action} />);
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    fireEvent.submit(addForm());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(Number(calls[0]!.entries.quantity)).toBeLessThanOrEqual(2);
    expect(calls[0]!.entries.quantity).toBe("2");
  });

  test("T15.4 stock drops to 0 while a quantity is selected: switches to Out of stock", () => {
    const { action } = recording(success);
    const { rerender } = render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    rerender(<AddToCartForm productId="p1" stock={0} addToCart={action} />);
    expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  test("contract: FormData carries exactly productId and quantity (strings), nothing else", async () => {
    const { action, calls } = recording(success);
    render(<AddToCartForm productId="prod-42" stock={5} addToCart={action} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    fireEvent.click(submitButton());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.keys.sort()).toEqual([CART_FIELD.productId, CART_FIELD.quantity].sort());
    expect(calls[0]!.entries).toEqual({ productId: "prod-42", quantity: "2" });
  });

  test("T15.6 keyboard: all controls are native, focusable, in a sensible order", () => {
    const { action } = recording(success);
    const { container } = render(<AddToCartForm productId="p1" stock={5} addToCart={action} />);
    const focusables = [...container.querySelectorAll("button, input:not([type=hidden])")];
    expect(focusables.map((el) => el.tagName)).toEqual(["BUTTON", "INPUT", "BUTTON", "BUTTON"]);
    expect(focusables.every((el) => !el.hasAttribute("tabindex") || el.getAttribute("tabindex") === "0")).toBe(true);
    expect(focusables[3]).toHaveAttribute("type", "submit");
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "ArrowUp" });
    fireEvent.keyDown(qty, { key: "ArrowUp" });
    fireEvent.keyDown(qty, { key: "ArrowDown" });
    expect(qty).toHaveValue("2");
    fireEvent.keyDown(qty, { key: "Home" });
    expect(qty).toHaveValue("1");
  });
});

// ---------------------------------------------------------------------------

function line(overrides: Partial<CartLineItemData> = {}): CartLineItemData {
  return {
    productId: "p-1",
    name: "Blue Mug",
    slug: "blue-mug",
    imageUrl: "/images/blue-mug.jpg",
    quantity: 3,
    unitPriceCents: 1250,
    lineTotalCents: 3750,
    availableStock: 10,
    status: "ok",
    ...overrides,
  };
}

const noop: CartActionFn = async () => null;

describe("T15 CartLineItem", () => {
  test("T15.5 Remove button accessible name includes the product name", () => {
    render(<CartLineItem item={line()} currency="USD" updateQuantity={noop} removeItem={noop} />);
    const btn = screen.getByRole("button", { name: /Remove/ });
    expect(btn).toHaveAccessibleName("Remove Blue Mug");
    expect(btn).toHaveTextContent("Remove"); // label-in-name
  });

  test("Update button names are product-specific and unique across lines", () => {
    render(
      <>
        <CartLineItem item={line()} currency="USD" updateQuantity={noop} removeItem={noop} />
        <CartLineItem item={line({ productId: "p-2", name: "Red Mug" })} currency="USD" updateQuantity={noop} removeItem={noop} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Update quantity for Blue Mug" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update quantity for Red Mug" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update" })).toBeNull();
  });

  test("T15.5 Remove names stay unique across lines with different products", () => {
    render(
      <>
        <CartLineItem item={line()} currency="USD" updateQuantity={noop} removeItem={noop} />
        <CartLineItem item={line({ productId: "p-2", name: "Red Mug" })} currency="USD" updateQuantity={noop} removeItem={noop} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Remove Blue Mug" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Red Mug" })).toBeInTheDocument();
  });

  for (const [unit, qty, currency] of [
    [1250, 3, "USD"],
    [1999, 1, "USD"],
    [1, 99, "USD"],
    [1500, 4, "JPY"],
  ] as const) {
    test(`T15.5 line total = unit x quantity (${unit} x ${qty} ${currency})`, () => {
      const total = unit * qty;
      render(
        <CartLineItem
          item={line({ unitPriceCents: unit, quantity: qty, lineTotalCents: total, availableStock: 99 })}
          currency={currency}
          updateQuantity={noop}
          removeItem={noop}
        />,
      );
      expect(screen.getByTestId("line-total").textContent).toBe(formatMoney(total, currency));
      expect(screen.getByRole("textbox", { name: "Quantity for Blue Mug" })).toHaveValue(String(qty));
    });
  }

  test('documents behaviour: lineTotalCents is rendered as-is (an inconsistent prop is not recomputed)', () => {
    render(
      <CartLineItem item={line({ lineTotalCents: 1 })} currency="USD" updateQuantity={noop} removeItem={noop} />,
    );
    expect(screen.getByTestId("line-total").textContent).toBe(formatMoney(1, "USD"));
  });

  test('status "unavailable": stepper disabled, notice shown, Remove still enabled', () => {
    render(
      <CartLineItem
        item={line({ status: "unavailable", availableStock: 0 })}
        currency="USD"
        updateQuantity={noop}
        removeItem={noop}
      />,
    );
    expect(screen.getByRole("textbox", { name: "Quantity for Blue Mug" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decrease quantity" })).toBeDisabled();
    expect(screen.getByText("No longer available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Blue Mug" })).toBeEnabled();
  });

  test('status "reduced": shows the available count', () => {
    render(
      <CartLineItem
        item={line({ status: "reduced", quantity: 2, availableStock: 2, lineTotalCents: 2500 })}
        currency="USD"
        updateQuantity={noop}
        removeItem={noop}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/Only 2 left/);
  });

  test("T15.4 stepper max equals availableStock; End posts availableStock", async () => {
    const upd = recording(ok({ itemCount: 6, subtotalCents: 7500, message: "Updated" }));
    render(
      <CartLineItem item={line({ availableStock: 6 })} currency="USD" updateQuantity={upd.action} removeItem={noop} />,
    );
    const qty = screen.getByRole("textbox", { name: "Quantity for Blue Mug" });
    fireEvent.keyDown(qty, { key: "End" });
    await waitFor(() => expect(upd.calls).toHaveLength(1));
    expect(upd.calls[0]!.entries).toEqual({ productId: "p-1", quantity: "6" });
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
  });

  test("T15.4 availableStock lowered below quantity: displayed value clamps", () => {
    const { rerender } = render(
      <CartLineItem item={line({ quantity: 5 })} currency="USD" updateQuantity={noop} removeItem={noop} />,
    );
    rerender(
      <CartLineItem item={line({ quantity: 5, availableStock: 2 })} currency="USD" updateQuantity={noop} removeItem={noop} />,
    );
    expect(screen.getByRole("textbox", { name: "Quantity for Blue Mug" })).toHaveValue("2");
  });

  test("contract: update form posts productId + quantity; remove form posts productId only", async () => {
    const upd = recording(ok({ itemCount: 4, subtotalCents: 5000, message: "Updated" }));
    const rem = recording(ok({ itemCount: 0, subtotalCents: 0, message: "Removed" }));
    render(<CartLineItem item={line()} currency="USD" updateQuantity={upd.action} removeItem={rem.action} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    await waitFor(() => expect(upd.calls).toHaveLength(1));
    expect(upd.calls[0]!.keys.sort()).toEqual(["productId", "quantity"]);
    expect(upd.calls[0]!.entries).toEqual({ productId: "p-1", quantity: "4" });
    fireEvent.click(screen.getByRole("button", { name: "Remove Blue Mug" }));
    await waitFor(() => expect(rem.calls).toHaveLength(1));
    expect(rem.calls[0]!.keys).toEqual(["productId"]);
    expect(rem.calls[0]!.entries).toEqual({ productId: "p-1" });
  });

  test("T15.1 Remove: double click while pending fires one request; button shows loading", async () => {
    const rem = gated();
    try {
      render(<CartLineItem item={line()} currency="USD" updateQuantity={noop} removeItem={rem.action} />);
      const btn = screen.getByRole("button", { name: "Remove Blue Mug" });
      fireEvent.click(btn);
      await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
      fireEvent.click(btn);
      await act(async () => {
        await Promise.resolve();
      });
      expect(rem.calls).toHaveLength(1);
    } finally {
      await rem.release(null);
    }
  });

  test("T15.3 update error: message in role=alert", async () => {
    const upd = recording(fail("INSUFFICIENT_STOCK", "Only 3 left in stock."));
    render(<CartLineItem item={line()} currency="USD" updateQuantity={upd.action} removeItem={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Only 3 left in stock.");
  });

  test("T15.3 remove error: message in role=alert", async () => {
    const rem = recording(fail("PRODUCT_NOT_FOUND", "That item is gone."));
    render(<CartLineItem item={line()} currency="USD" updateQuantity={noop} removeItem={rem.action} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Blue Mug" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That item is gone.");
  });

  test("D2 (fixed): update success message is announced in a polite live region", async () => {
    const upd = recording(ok({ itemCount: 4, subtotalCents: 5000, message: "Quantity updated to 4" }));
    const { container } = render(
      <CartLineItem item={line()} currency="USD" updateQuantity={upd.action} removeItem={noop} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    await waitFor(() => expect(upd.calls).toHaveLength(1));
    await waitFor(() => {
      const polite = [...container.querySelectorAll('[aria-live="polite"], [role="status"]')];
      expect(polite.some((el) => el.textContent?.includes("Quantity updated to 4"))).toBe(true);
    });
  });

  test("line-status region is always rendered (empty, polite, atomic) before any result; not an alert", async () => {
    const upd = recording(ok({ itemCount: 4, subtotalCents: 5000, message: "Quantity updated to 4" }));
    render(<CartLineItem item={line()} currency="USD" updateQuantity={upd.action} removeItem={noop} />);
    const region = screen.getByTestId("line-status");
    expect(region).toHaveAttribute("aria-live", "polite");
    expect(region).toHaveAttribute("aria-atomic", "true");
    expect(region).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    await waitFor(() => expect(region).toHaveTextContent("Quantity updated to 4"));
    expect(screen.getByTestId("line-status")).toBe(region); // same node, not remounted
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("update error after a success: alert shown, success text cleared from the polite region", async () => {
    let n = 0;
    const upd: CartActionFn = async () =>
      n++ === 0 ? ok({ itemCount: 4, subtotalCents: 5000, message: "Quantity updated to 4" }) : fail("INSUFFICIENT_STOCK", "Not enough stock.");
    render(<CartLineItem item={line()} currency="USD" updateQuantity={upd} removeItem={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    await waitFor(() => expect(screen.getByTestId("line-status")).toHaveTextContent("Quantity updated to 4"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Update quantity/ })).not.toHaveAttribute("aria-busy"));
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Not enough stock.");
    expect(screen.getByTestId("line-status")).toBeEmptyDOMElement();
  });

  test("hostile availableStock (NaN / Infinity / 2.5 / -4): stepper max collapses to 1, reduced text shows 0 not NaN", () => {
    for (const availableStock of [Number.NaN, Number.POSITIVE_INFINITY, 2.5, -4]) {
      const { unmount } = render(
        <CartLineItem item={line({ quantity: 3, availableStock, status: "reduced" })} currency="USD" updateQuantity={noop} removeItem={noop} />,
      );
      expect(screen.getByRole("textbox", { name: "Quantity for Blue Mug" })).toHaveValue("1");
      expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent("Only 0 left");
      expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
      unmount();
    }
  });

  test("after a rejected update the stepper re-syncs to the server quantity (3), and the next step posts from 3", async () => {
    let n = 0;
    const posted: string[] = [];
    const upd: CartActionFn = async (_p, fd) => {
      posted.push(String(fd.get("quantity")));
      return n++ === 0 ? fail("INSUFFICIENT_STOCK", "Not enough stock.") : ok({ itemCount: 2, subtotalCents: 2500, message: "Updated" });
    };
    render(<CartLineItem item={line()} currency="USD" updateQuantity={upd} removeItem={noop} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    await screen.findByRole("alert");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Quantity for Blue Mug" })).toHaveValue("3"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Update quantity/ })).not.toHaveAttribute("aria-busy"));
    fireEvent.click(screen.getByRole("button", { name: "Decrease quantity" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted).toEqual(["4", "2"]);
  });

  test("T15.6 keyboard: stepper keys submit the update; hidden Update button is focusable and becomes visible on focus", async () => {
    const upd = recording(ok({ itemCount: 2, subtotalCents: 2500, message: "Updated" }));
    render(<CartLineItem item={line()} currency="USD" updateQuantity={upd.action} removeItem={noop} />);
    const qty = screen.getByRole("textbox", { name: "Quantity for Blue Mug" });
    fireEvent.keyDown(qty, { key: "ArrowDown" });
    await waitFor(() => expect(upd.calls).toHaveLength(1));
    expect(upd.calls[0]!.entries.quantity).toBe("2");
    const update = screen.getByRole("button", { name: "Update quantity for Blue Mug" });
    expect(update).toHaveTextContent("Update"); // label-in-name
    expect(update).toHaveAttribute("type", "submit");
    expect(update).toHaveClass("sr-only", "focus:not-sr-only");
    const group = screen.getByRole("group", { name: "Quantity for Blue Mug" });
    expect(within(group).getAllByRole("button")).toHaveLength(2);
  });
});
