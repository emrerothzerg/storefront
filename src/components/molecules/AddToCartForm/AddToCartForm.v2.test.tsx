import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { fail, ok } from "@/lib/result";
import type {
  CartActionFn,
  CartActionFnV2,
  CartActionState,
  CartActionStateV2,
} from "../_contracts/cart-actions";
import { AddToCartForm, availableFromState, type AddToCartSuccessState } from "./AddToCartForm";

type Call = { productId: FormDataEntryValue | null; quantity: FormDataEntryValue | null };

function recording<S extends CartActionState | CartActionStateV2>(result: S) {
  const calls: Call[] = [];
  const action = async (_prev: S | null, formData: FormData): Promise<S> => {
    calls.push({ productId: formData.get("productId"), quantity: formData.get("quantity") });
    return result;
  };
  return { action, calls };
}

function controlled<S>() {
  const calls: Call[] = [];
  let resolveFn: (s: S) => void = () => {};
  const action = (_prev: S | null, formData: FormData): Promise<S> => {
    calls.push({ productId: formData.get("productId"), quantity: formData.get("quantity") });
    return new Promise<S>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s: S) => resolveFn(s) };
}

const success = ok({ itemCount: 2, subtotalCents: 4000, message: "Added to cart" });

function addRec(result: CartActionState = success) {
  const r = recording<CartActionState>(result);
  return { action: r.action as CartActionFn, calls: r.calls };
}
function buyRec(result: CartActionStateV2 = success) {
  const r = recording<CartActionStateV2>(result);
  return { action: r.action as CartActionFnV2, calls: r.calls };
}

describe("AddToCartForm v2: Buy Now", () => {
  test("static markup: one form, two submit buttons, Buy Now carries formaction, hidden productId, quantity", () => {
    const html = renderToStaticMarkup(
      <AddToCartForm productId="p1" stock={5} addToCart={addRec().action} buyNowAction={buyRec().action} />,
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelectorAll("form")).toHaveLength(1);
    const submits = doc.querySelectorAll('form button[type="submit"]');
    expect(submits).toHaveLength(2);
    expect(submits[0]?.textContent).toContain("Add to cart");
    expect(submits[1]?.textContent).toContain("Buy Now");
    expect(submits[1]?.hasAttribute("formaction")).toBe(true);
    expect(submits[0]?.hasAttribute("formaction")).toBe(false);
    expect(doc.querySelector('input[type="hidden"][name="productId"]')?.getAttribute("value")).toBe("p1");
    expect(doc.querySelector('input[name="quantity"]')).not.toBeNull();
  });

  test("without buyNowAction there is no Buy Now button (MVP shape)", () => {
    render(<AddToCartForm productId="p1" stock={5} addToCart={addRec().action} />);
    expect(screen.queryByRole("button", { name: /buy now/i })).toBeNull();
  });

  test("Buy Now posts productId + quantity to buyNow only", async () => {
    const add = addRec();
    const buy = buyRec();
    render(<AddToCartForm productId="p1" stock={5} addToCart={add.action} buyNowAction={buy.action} />);
    fireEvent.click(screen.getByRole("button", { name: "Increase quantity" }));
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    await waitFor(() => expect(buy.calls).toHaveLength(1));
    expect(buy.calls[0]).toEqual({ productId: "p1", quantity: "2" });
    expect(add.calls).toHaveLength(0);
  });

  test("Add to cart click still posts to addToCart only", async () => {
    const add = addRec();
    const buy = buyRec();
    render(<AddToCartForm productId="p1" stock={5} addToCart={add.action} buyNowAction={buy.action} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(add.calls).toHaveLength(1));
    expect(buy.calls).toHaveLength(0);
  });

  test("pending Add disables both buttons; Buy Now click while pending fires nothing", async () => {
    const add = controlled<CartActionState>();
    const buy = buyRec();
    render(
      <AddToCartForm productId="p1" stock={5} addToCart={add.action as CartActionFn} buyNowAction={buy.action} />,
    );
    const addBtn = screen.getByRole("button", { name: /add to cart/i });
    const buyBtn = screen.getByRole("button", { name: /buy now/i });
    fireEvent.click(addBtn);
    await waitFor(() => expect(addBtn).toHaveAttribute("aria-busy", "true"));
    expect(buyBtn).toHaveAttribute("aria-busy", "true");
    expect(buyBtn).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(buyBtn);
    fireEvent.click(addBtn);
    await new Promise((r) => setTimeout(r, 20));
    expect(buy.calls).toHaveLength(0);
    expect(add.calls).toHaveLength(1);
    await act(async () => add.resolve(success));
    await waitFor(() => expect(buyBtn).not.toHaveAttribute("aria-busy"));
  });

  test("pending Buy Now disables both buttons", async () => {
    const add = addRec();
    const buy = controlled<CartActionStateV2>();
    render(
      <AddToCartForm productId="p1" stock={5} addToCart={add.action} buyNowAction={buy.action as CartActionFnV2} />,
    );
    const addBtn = screen.getByRole("button", { name: /add to cart/i });
    const buyBtn = screen.getByRole("button", { name: /buy now/i });
    fireEvent.click(buyBtn);
    await waitFor(() => expect(buyBtn).toHaveAttribute("aria-busy", "true"));
    expect(addBtn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(addBtn);
    await new Promise((r) => setTimeout(r, 20));
    expect(add.calls).toHaveLength(0);
    expect(buy.calls).toHaveLength(1);
    await act(async () => buy.resolve(fail("OUT_OF_STOCK", "This item is out of stock.")));
    expect(await screen.findByRole("alert")).toHaveTextContent("This item is out of stock.");
  });

  test("Buy Now error replaces an earlier Add success message", async () => {
    const add = addRec();
    const buy = buyRec(fail("INTERNAL_ERROR", "Something went wrong."));
    const { container } = render(
      <AddToCartForm productId="p1" stock={5} addToCart={add.action} buyNowAction={buy.action} />,
    );
    const region = container.querySelector('[aria-live="polite"][aria-atomic="true"]:not(.sr-only)');
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(region).toHaveTextContent("Added to cart"));
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    expect(region).toBeEmptyDOMElement();
  });
});

describe("AddToCartForm v2: quantity cap", () => {
  test("default cap is min(stock, 10)", () => {
    render(<AddToCartForm productId="p1" stock={50} addToCart={addRec().action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("10");
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
  });

  test("stock below 10 caps at stock", () => {
    render(<AddToCartForm productId="p1" stock={7} addToCart={addRec().action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    expect(qty).toHaveValue("7");
  });
});

describe("AddToCartForm v2: onSuccess", () => {
  test("called once per successful submission with the success state", async () => {
    const seen: AddToCartSuccessState[] = [];
    const add = addRec();
    render(<AddToCartForm productId="p1" stock={5} addToCart={add.action} onSuccess={(s) => seen.push(s)} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.value.message).toBe("Added to cart");
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await waitFor(() => expect(seen).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toHaveLength(2);
  });

  test("not called on error", async () => {
    const seen: AddToCartSuccessState[] = [];
    const add = addRec(fail("OUT_OF_STOCK", "This item is out of stock."));
    render(<AddToCartForm productId="p1" stock={5} addToCart={add.action} onSuccess={(s) => seen.push(s)} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    await screen.findByRole("alert");
    expect(seen).toHaveLength(0);
  });

  test("success keeps the inline polite message (no-JS parity) alongside the callback", async () => {
    let called = 0;
    const { container } = render(
      <AddToCartForm productId="p1" stock={5} addToCart={addRec().action} onSuccess={() => (called += 1)} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    const region = container.querySelector('[aria-live="polite"]:not(.sr-only)');
    await waitFor(() => expect(region).toHaveTextContent("Added to cart"));
    expect(called).toBe(1);
  });
});

describe("AddToCartForm v2: stock changed mid-session", () => {
  test("INSUFFICIENT_STOCK shows the available count and lowers the stepper max", async () => {
    const add = addRec(
      fail("INSUFFICIENT_STOCK", "Not enough stock.", { productId: "p1", available: 2, requested: 5 }),
    );
    render(<AddToCartForm productId="p1" stock={8} addToCart={add.action} />);
    const qty = screen.getByRole("textbox", { name: "Quantity" });
    fireEvent.keyDown(qty, { key: "End" });
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Not enough stock. Available now: 2.");
    expect(screen.getByRole("textbox", { name: "Quantity" })).toHaveValue("2");
    expect(screen.getByRole("button", { name: "Increase quantity" })).toBeDisabled();
  });

  test("STOCK_CHANGED from Buy Now with available 0 shows the count and keeps the form", async () => {
    const buy = buyRec(fail("STOCK_CHANGED", "Stock changed.", { productId: "p1", available: 0 }));
    render(<AddToCartForm productId="p1" stock={3} addToCart={addRec().action} buyNowAction={buy.action} />);
    fireEvent.click(screen.getByRole("button", { name: "Buy Now" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stock changed. Available now: 0.");
    expect(screen.getByRole("button", { name: "Add to cart" })).toBeInTheDocument();
  });

  test("hostile error message renders as text", async () => {
    const add = addRec(fail("INSUFFICIENT_STOCK", "<img src=x onerror=alert(1)>", { available: 1 }));
    const { container } = render(<AddToCartForm productId="p1" stock={3} addToCart={add.action} />);
    fireEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("<img src=x onerror=alert(1)>");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("availableFromState", () => {
  test.each<[CartActionStateV2, number | null]>([
    [null, null],
    [success, null],
    [fail("INSUFFICIENT_STOCK", "x", { available: 3 }), 3],
    [fail("STOCK_CHANGED", "x", { available: 0 }), 0],
    [fail("INSUFFICIENT_STOCK", "x"), null],
    [fail("INSUFFICIENT_STOCK", "x", { available: -1 }), null],
    [fail("INSUFFICIENT_STOCK", "x", { available: 1.5 }), null],
    [fail("INSUFFICIENT_STOCK", "x", { available: "3" }), null],
    [fail("INSUFFICIENT_STOCK", "x", { available: Number.NaN }), null],
    [fail("OUT_OF_STOCK", "x", { available: 3 }), null],
  ])("%p -> %p", (state, expected) => {
    expect(availableFromState(state)).toBe(expected);
  });
});

describe("AddToCartForm v2: variant", () => {
  test("buybox uses large buttons; out of stock still renders the disabled button only", () => {
    const { unmount } = render(
      <AddToCartForm productId="p1" stock={5} addToCart={addRec().action} buyNowAction={buyRec().action} variant="buybox" />,
    );
    expect(screen.getByRole("button", { name: "Add to cart" })).toHaveClass("min-h-12");
    expect(screen.getByRole("button", { name: "Buy Now" })).toHaveClass("min-h-12");
    unmount();
    render(<AddToCartForm productId="p1" stock={0} addToCart={addRec().action} buyNowAction={buyRec().action} variant="buybox" />);
    expect(screen.getByRole("button", { name: "Out of stock" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /buy now/i })).toBeNull();
  });
});
