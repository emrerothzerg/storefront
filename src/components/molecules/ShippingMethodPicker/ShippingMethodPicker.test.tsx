import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { fail, ok } from "@/lib/result";
import type { ShippingMethod } from "@/lib/types";
import type { ShippingQuote } from "@/server/pricing/shipping-service";
import type { CartActionFnV2, CartActionStateV2 } from "../_contracts/cart-actions";
import { ShippingMethodPicker, usableShippingOptions } from ".";

function method(id: string, name: string, priceCents: number, freeOverCents: number | null = null): ShippingMethod {
  return { id, name, description: "", priceCents, freeOverCents, minDays: 3, maxDays: 5, sortOrder: 0, isActive: true };
}

const options: ShippingQuote[] = [
  { method: method("standard", "Standard", 599, 3500), priceCents: 0, isFree: true, amountToFreeCents: 0 },
  { method: method("express", "Express", 1299, 10000), priceCents: 1299, isFree: false, amountToFreeCents: 6000 },
];
const arrivals = {
  standard: { start: "2026-11-12T00:00:00Z", end: "2026-11-14T00:00:00Z" },
  express: { start: "2026-11-10T00:00:00Z", end: "2026-11-10T12:00:00Z" },
};

function recording(result: CartActionStateV2): { action: CartActionFnV2; posted: Array<string | null> } {
  const posted: Array<string | null> = [];
  const action: CartActionFnV2 = async (_prev, formData) => {
    const v = formData.get("shippingMethodId");
    posted.push(typeof v === "string" ? v : null);
    return result;
  };
  return { action, posted };
}
const noop: CartActionFnV2 = async () => null;

/** happy-dom's requestSubmit() passes the form itself as submitter (FormData then throws); replay it as a plain submit event. */
function patchRequestSubmit(): { calls: () => number } {
  const form = screen.getAllByRole("radio")[0]?.closest("form");
  if (!form) throw new Error("no form");
  let count = 0;
  form.requestSubmit = () => {
    count += 1;
    fireEvent.submit(form);
  };
  return { calls: () => count };
}
const success = ok({ itemCount: 1, subtotalCents: 4000, message: "Shipping updated", kind: "shipping_selected" as const });

describe("ShippingMethodPicker", () => {
  test("static markup: plain form, named radios, checked selection and a visible Update button", () => {
    const html = renderToStaticMarkup(
      <ShippingMethodPicker action={noop} options={options} selectedId="express" arrivals={arrivals} />,
    );
    expect(html).toContain("<form");
    expect(html.match(/name="shippingMethodId"/g)).toHaveLength(2);
    expect(html).toMatch(/value="express"[^>]*checked=""|checked=""[^>]*value="express"/);
    expect(html).toMatch(/type="submit"[^>]*>Update/);
    expect(html).not.toContain("sr-only focus:not-sr-only");
  });

  test("labelled radio group; labels carry name, price/Free and arrival range", () => {
    render(<ShippingMethodPicker action={noop} options={options} selectedId="standard" arrivals={arrivals} />);
    const group = screen.getByRole("radiogroup", { name: "Shipping method" });
    const standard = within(group).getByRole("radio", { name: /Standard — Free — Arrives Thu, Nov 12 – Sat, Nov 14/ });
    expect(standard).toBeChecked();
    const express = within(group).getByRole("radio", { name: /Express — \$12\.99 — Arrives Tue, Nov 10$/ });
    expect(express).not.toBeChecked();
    expect(screen.getByText("Free with $60.00 more in your cart")).toBeInTheDocument();
  });

  test("auto-submits on change after hydration and hides Update visually", async () => {
    const { action, posted } = recording(success);
    render(<ShippingMethodPicker action={action} options={options} selectedId="standard" arrivals={arrivals} />);
    const button = screen.getByRole("button", { name: "Update shipping method" });
    expect(button).toHaveAttribute("data-enhanced", "true");
    expect(button.className).toContain("sr-only");
    const patched = patchRequestSubmit();
    fireEvent.click(screen.getByRole("radio", { name: /Express/ }));
    expect(patched.calls()).toBe(1);
    await waitFor(() => expect(posted).toEqual(["express"]));
  });

  test("autoSubmit=false keeps the Update button visible and does not submit on change", async () => {
    const { action, posted } = recording(success);
    render(<ShippingMethodPicker action={action} options={options} selectedId="standard" autoSubmit={false} />);
    const patched = patchRequestSubmit();
    const button = screen.getByRole("button", { name: "Update shipping method" });
    expect(button.className).not.toContain("sr-only");
    fireEvent.click(screen.getByRole("radio", { name: /Express/ }));
    expect(patched.calls()).toBe(0);
    expect(posted).toEqual([]);
    const form = button.closest("form");
    if (!form) throw new Error("no form");
    fireEvent.submit(form);
    await waitFor(() => expect(posted).toEqual(["express"]));
  });

  test("error shows in role=alert and the radios reset to selectedId", async () => {
    const { action } = recording(fail("INVALID_INPUT", "That shipping method is not available."));
    render(<ShippingMethodPicker action={action} options={options} selectedId="standard" />);
    patchRequestSubmit();
    fireEvent.click(screen.getByRole("radio", { name: /Express/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That shipping method is not available.");
    expect(screen.getByRole("radio", { name: /Standard/ })).toBeChecked();
  });

  test("selection follows a new selectedId (no-JS post re-render)", () => {
    const { rerender } = render(<ShippingMethodPicker action={noop} options={options} selectedId="standard" />);
    rerender(<ShippingMethodPicker action={noop} options={options} selectedId="express" />);
    expect(screen.getByRole("radio", { name: /Express/ })).toBeChecked();
  });

  test("unknown selectedId checks nothing; no arrivals omits the range", () => {
    render(<ShippingMethodPicker action={noop} options={options} selectedId="nope" />);
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
    expect(screen.queryByText(/Arrives/)).toBeNull();
  });

  test("invalid options are dropped; none left renders nothing", () => {
    const bad: ShippingQuote[] = [
      { method: method("x", "X", 1), priceCents: -5, isFree: false, amountToFreeCents: null },
      { method: method("", "Blank", 1), priceCents: 1, isFree: false, amountToFreeCents: null },
      { method: method("y", "Y", 1), priceCents: 1.5, isFree: false, amountToFreeCents: null },
    ];
    expect(usableShippingOptions(bad)).toEqual([]);
    expect(usableShippingOptions([...options, options[0]!])).toHaveLength(2);
    const { container } = render(<ShippingMethodPicker action={noop} options={bad} selectedId={null} />);
    expect(container.innerHTML).toBe("");
  });

  test("hostile method name renders as text", () => {
    const hostile: ShippingQuote[] = [
      { method: method("h", "<img src=x onerror=alert(1)>", 100), priceCents: 100, isFree: false, amountToFreeCents: null },
    ];
    const html = renderToStaticMarkup(<ShippingMethodPicker action={noop} options={hostile} selectedId={null} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
