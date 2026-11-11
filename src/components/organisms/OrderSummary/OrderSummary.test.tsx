import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { OrderSummary, type OrderSummaryProps } from "./OrderSummary";

const items: OrderSummaryProps["items"] = [
  { productId: "p1", name: "Canvas Tote", quantity: 2, unitPriceCents: 1250 },
  { productId: "p2", name: "Mug", quantity: 3, unitPriceCents: 999 },
];

function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`missing element ${index}`);
  return value;
}

function parseUsd(text: string | null): number {
  return Math.round(Number((text ?? "").replace(/[^0-9.]/g, "")) * 100);
}

/** Text a screen reader announces: `textContent` without `aria-hidden` subtrees (the superscript visual). */
function spokenText(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  for (const hidden of Array.from(clone.querySelectorAll('[aria-hidden="true"]'))) hidden.remove();
  return clone.textContent ?? "";
}

function ddValue(section: HTMLElement, label: string): HTMLElement {
  const dt = within(section).getByText(label, { selector: "dt" });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`no dd for ${label}`);
  return dd;
}

function renderSummary(props: Partial<OrderSummaryProps> = {}) {
  render(
    <OrderSummary
      items={items}
      subtotalCents={5497}
      shippingCents={0}
      totalCents={5497}
      currency="USD"
      {...props}
    />,
  );
  return screen.getByRole("region", { name: props.heading ?? "Order summary" });
}

describe("OrderSummary", () => {
  test("section is labelled by its heading (default text and level 2)", () => {
    const section = renderSummary();
    expect(section.tagName).toBe("SECTION");
    const heading = within(section).getByRole("heading", { level: 2, name: "Order summary" });
    expect(section).toHaveAttribute("aria-labelledby", heading.id);
  });

  test("custom heading and headingLevel", () => {
    const section = renderSummary({ heading: "Your order", headingLevel: 3 });
    expect(within(section).getByRole("heading", { level: 3, name: "Your order" })).toBeInTheDocument();
  });

  test("renders a list of 'name × quantity' lines with unit × quantity line totals", () => {
    const section = renderSummary();
    const list = within(section).getByRole("list");
    const lines = within(list).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("Canvas Tote × 2");
    expect(within(nth(lines, 0)).getByTestId("order-line-total")).toHaveTextContent("$25.00");
    expect(lines[1]).toHaveTextContent("Mug × 3");
    expect(within(nth(lines, 1)).getByTestId("order-line-total")).toHaveTextContent("$29.97");
  });

  test("displayed total equals sum of displayed line totals + shipping; 0 shipping shows 'Free'", () => {
    const section = renderSummary();
    const lineSum = within(section)
      .getAllByTestId("order-line-total")
      .reduce((sum, el) => sum + parseUsd(el.textContent), 0);
    expect(ddValue(section, "Shipping")).toHaveTextContent("Free");
    expect(ddValue(section, "Subtotal")).toHaveTextContent("$54.97");
    // T161: the Total uses the superscript Price; its spoken text is the full amount.
    expect(parseUsd(spokenText(ddValue(section, "Total")))).toBe(lineSum + 0);
  });

  test("non-zero shipping is shown as a price and included in the displayed total", () => {
    const section = renderSummary({ shippingCents: 500, totalCents: 5997 });
    expect(ddValue(section, "Shipping")).toHaveTextContent("$5.00");
    expect(ddValue(section, "Shipping")).not.toHaveTextContent("Free");
    const lineSum = within(section)
      .getAllByTestId("order-line-total")
      .reduce((sum, el) => sum + parseUsd(el.textContent), 0);
    expect(parseUsd(spokenText(ddValue(section, "Total")))).toBe(lineSum + 500);
  });

  test("Total is emphasised and listed last", () => {
    const section = renderSummary();
    const terms = Array.from(section.querySelectorAll("dt")).map((n) => n.textContent);
    expect(terms).toEqual(["Subtotal", "Shipping", "Total"]);
    expect(within(section).getByText("Total", { selector: "dt" }).parentElement).toHaveClass("text-h4");
  });

  test("does NOT enforce totalCents === subtotalCents + shippingCents (displays what it is given)", () => {
    const section = renderSummary({ subtotalCents: 1000, shippingCents: 0, totalCents: 4242 });
    expect(ddValue(section, "Subtotal")).toHaveTextContent("$10.00");
    expect(ddValue(section, "Total")).toHaveTextContent("$42.42");
  });

  test("when the line total cannot be computed, shows unit price and quantity only", () => {
    const section = renderSummary({
      items: [{ productId: "big", name: "Huge", quantity: 3, unitPriceCents: Number.MAX_SAFE_INTEGER }],
    });
    const line = within(section).getByRole("listitem");
    expect(within(line).queryByTestId("order-line-total")).toBeNull();
    expect(line).toHaveTextContent("Huge × 3");
    expect(line).toHaveTextContent("each, quantity 3");
  });

  test("responsive at 320px: min-w-0 and wrapping line rows", () => {
    const section = renderSummary();
    expect(section).toHaveClass("min-w-0");
    for (const li of within(section).getAllByRole("listitem")) {
      expect(li).toHaveClass("min-w-0", "flex-wrap");
    }
  });
});
