import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { appError } from "@/lib/result";
import type { CartActionFn, CartActionState } from "../_contracts/cart-actions";
import { QuickAddForm } from "./QuickAddForm";

type Posted = Record<string, string>;

function recording(result: CartActionState | (() => Promise<CartActionState>)) {
  const calls: Posted[] = [];
  const action: CartActionFn = async (_prev, formData) => {
    const posted: Posted = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") posted[key] = value;
    });
    calls.push(posted);
    return typeof result === "function" ? result() : result;
  };
  return { action, calls };
}

const ok: CartActionState = { ok: true, value: { itemCount: 1, subtotalCents: 1250, message: "Added Blue Mug to your cart." } };

describe("QuickAddForm", () => {
  test("static markup: a form with hidden productId and quantity=1 and a '+ Add' submit", () => {
    const { action } = recording(ok);
    const html = renderToStaticMarkup(
      <QuickAddForm productId="p1" productName="Blue Mug" stock={4} action={action} />,
    );
    expect(html).toContain("<form");
    expect(html).toMatch(/<input type="hidden" name="productId" value="p1"\/>/);
    expect(html).toMatch(/<input type="hidden" name="quantity" value="1"\/>/);
    expect(html).toMatch(/type="submit"/);
    expect(html).toMatch(/>Add<span class="sr-only"> to cart: Blue Mug<\/span>/);
    // T137: the visible pill is "+ Add" (plus icon + "Add"); " to cart: <name>" is sr-only.
    expect(html).toContain('data-slot="quick-add-pill"');
    // SR9: nothing price-like is posted.
    expect(html).not.toMatch(/name="(price|priceCents|total|subtotal|amount)/i);
  });

  test("posts productId and quantity 1, then announces success politely", async () => {
    const { action, calls } = recording(ok);
    const { container } = render(<QuickAddForm productId="p1" productName="Blue Mug" stock={4} action={action} />);
    const button = screen.getByRole("button", { name: /Add to cart/ });
    expect(button).toHaveAccessibleName(/^Add to cart\s*: Blue Mug$/);
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(screen.getByText("Added Blue Mug to your cart.")).toBeInTheDocument());
    expect(calls).toEqual([{ productId: "p1", quantity: "1" }]);
    expect(screen.getByText("Added Blue Mug to your cart.")).toHaveAttribute("aria-live", "polite");
  });

  test("server error renders in role=alert as text", async () => {
    const { action } = recording({ ok: false, error: appError("OUT_OF_STOCK", "<b>Sold out</b>") });
    const { container } = render(<QuickAddForm productId="p1" productName="Blue Mug" stock={4} action={action} />);
    fireEvent.submit(container.querySelector("form")!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("<b>Sold out</b>");
    expect(alert.querySelector("b")).toBeNull();
  });

  test("pending state marks the button busy", async () => {
    let release: (v: CartActionState) => void = () => {};
    const { action } = recording(() => new Promise<CartActionState>((r) => { release = r; }));
    const { container } = render(<QuickAddForm productId="p1" productName="Blue Mug" stock={4} action={action} />);
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true"));
    release(ok);
    await waitFor(() => expect(screen.getByRole("button")).not.toHaveAttribute("aria-busy", "true"));
  });

  test.each([0, -1, Number.NaN, 1.5])("stock %p: disabled 'Out of stock' button, no form", (stock) => {
    const { action, calls } = recording(ok);
    const { container } = render(<QuickAddForm productId="p1" productName="Blue Mug" stock={stock} action={action} />);
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Out of stock");
    expect(container.querySelector("form")).toBeNull();
    fireEvent.click(button);
    expect(calls).toHaveLength(0);
  });
});
