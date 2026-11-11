import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Price } from "@/components/atoms/Price";
import { SummaryList, SummaryRow } from "./SummaryRow";

describe("SummaryRow", () => {
  test("renders a dt/dd pair inside SummaryList's dl", () => {
    const { container } = render(
      <SummaryList aria-label="Order summary">
        <SummaryRow label="Subtotal" value="$10.00" />
        <SummaryRow label="Total" value={<Price amountCents={1999} />} emphasis />
      </SummaryList>,
    );
    const dl = container.querySelector("dl");
    expect(dl).toHaveAttribute("aria-label", "Order summary");
    expect(Array.from(container.querySelectorAll("dt")).map((n) => n.textContent)).toEqual(["Subtotal", "Total"]);
    const dds = container.querySelectorAll("dd");
    expect(dds[0]).toHaveTextContent("$10.00");
    expect(dds[1]).toHaveTextContent("$19.99");
    // Rows are direct children of the dl.
    for (const row of Array.from(dl?.children ?? [])) {
      expect(row.tagName).toBe("DIV");
      expect(row).toHaveAttribute("role", "presentation");
      expect(row).toHaveClass("flex", "justify-between", "gap-4");
    }
  });

  test("emphasis uses text-h4; default uses text-body; className merges", () => {
    render(
      <SummaryList>
        <SummaryRow label="Shipping" value="Free" className="mt-2" />
        <SummaryRow label="Total" value="$5.00" emphasis />
      </SummaryList>,
    );
    const shipping = screen.getByText("Shipping").parentElement;
    expect(shipping).toHaveClass("text-body", "mt-2");
    expect(shipping).not.toHaveClass("text-h4");
    expect(screen.getByText("Total").parentElement).toHaveClass("text-h4");
  });
});
