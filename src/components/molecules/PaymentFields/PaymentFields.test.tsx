import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MOCK_CARDS } from "@/server/payments/mock-payment-provider";
import { validateCard } from "@/lib/validation";
import { AddressFields } from "../AddressFields";
import { MOCK_TEST_CARDS, PaymentFields } from "./PaymentFields";

const FIELDS = [
  { label: "Name on card", name: "nameOnCard", autocomplete: "cc-name" },
  { label: "Card number", name: "number", autocomplete: "cc-number", inputmode: "numeric" },
  { label: "Expiry month", name: "expMonth", autocomplete: "cc-exp-month", inputmode: "numeric" },
  { label: "Expiry year", name: "expYear", autocomplete: "cc-exp-year", inputmode: "numeric" },
  { label: "Security code (CVC)", name: "cvc", autocomplete: "cc-csc", inputmode: "numeric" },
] as const;

const SENSITIVE = ["number", "expMonth", "expYear", "cvc"] as const;

function input(name: string): HTMLInputElement {
  const el = document.querySelector(`input[name="${name}"]`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input ${name}`);
  return el;
}

describe("PaymentFields", () => {
  test("MOCK_TEST_CARDS matches the server mock provider's MOCK_CARDS", () => {
    expect(MOCK_TEST_CARDS).toEqual(MOCK_CARDS);
  });

  test("fieldset with legend", () => {
    render(<PaymentFields />);
    expect(screen.getByRole("group", { name: "Payment" }).tagName).toBe("FIELDSET");
  });

  test.each(FIELDS)("$name: labelled, type=text, autocomplete, inputmode, required", (f) => {
    render(<PaymentFields />);
    const el = screen.getByRole("textbox", { name: new RegExp(`^${f.label.replace(/[()]/g, "\\$&")}`) });
    expect(el).toHaveAttribute("name", f.name);
    expect(el).toHaveAttribute("id", `card-${f.name}`);
    expect(el).toHaveAttribute("type", "text");
    expect(el).toHaveAttribute("autocomplete", f.autocomplete);
    if ("inputmode" in f) expect(el).toHaveAttribute("inputmode", f.inputmode);
    expect(el).toBeRequired();
  });

  test("expiry placeholders and CVC maxLength", () => {
    render(<PaymentFields />);
    expect(input("expMonth")).toHaveAttribute("placeholder", "MM");
    expect(input("expYear")).toHaveAttribute("placeholder", "YYYY");
    expect(input("cvc")).toHaveAttribute("maxlength", "4");
  });

  test("never renders card number, expiry or CVC values, even if a caller passes them", () => {
    // A non-literal object bypasses excess-property checks, simulating a careless caller.
    const sneaky = {
      nameOnCard: "Ada Lovelace",
      number: MOCK_TEST_CARDS.success,
      expMonth: "12",
      expYear: "2030",
      cvc: "123",
    };
    const { container } = render(<PaymentFields defaultValues={sneaky} />);
    expect(input("nameOnCard")).toHaveValue("Ada Lovelace");
    for (const name of SENSITIVE) {
      const el = input(name);
      expect(el.value).toBe("");
      expect(el.defaultValue).toBe("");
      expect(el.hasAttribute("value")).toBe(false);
    }
    expect(container.innerHTML).not.toContain("2030");
    expect(container.innerHTML).not.toContain('value="123"');
  });

  test("no name collisions with AddressFields", () => {
    const { container } = render(
      <form>
        <AddressFields />
        <PaymentFields />
      </form>,
    );
    const names = Array.from(container.querySelectorAll("input, select")).map((el) => el.getAttribute("name"));
    expect(names).toHaveLength(13);
    expect(new Set(names).size).toBe(names.length);
    const ids = Array.from(container.querySelectorAll("[id]")).map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("test-mode notice is visible, labelled with text, and lists the four cards", () => {
    render(<PaymentFields />);
    const note = screen.getByRole("note");
    expect(note).toHaveClass("bg-info-subtle", "text-info");
    expect(note).toHaveTextContent("Test mode");
    expect(note).toHaveTextContent("4242424242424242 succeeds");
    expect(note).toHaveTextContent("4000000000000002 declined");
    expect(note).toHaveTextContent("4000000000009995 insufficient funds");
    expect(note).toHaveTextContent("4000000000000119 processing error");
    // Notice precedes the fields.
    const position = note.compareDocumentPosition(input("nameOnCard"));
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("errors from validateCard are shown next to the field and linked via aria-describedby", () => {
    const result = validateCard(
      { number: "4242424242424241", expMonth: "13", expYear: "2030", cvc: "12", nameOnCard: "Ada" },
      new Date("2026-01-01T00:00:00Z"),
    );
    if (result.ok) throw new Error("expected validation failure");
    const errors = result.error.details.fields;

    const { container } = render(<PaymentFields errors={errors} />);

    const number = screen.getByRole("textbox", { name: /^Card number/ });
    expect(number).toHaveAttribute("aria-invalid", "true");
    expect(number).toHaveAttribute("aria-describedby", "card-number-error");
    expect(number).toHaveAccessibleDescription("Card number is not valid.");
    expect(document.getElementById("card-number-error")?.parentElement).toBe(number.parentElement);

    expect(input("expMonth")).toHaveAccessibleDescription("Expiry month must be 1 to 12.");
    expect(input("cvc")).toHaveAccessibleDescription("Security code must be 3 or 4 digits.");
    expect(input("nameOnCard")).not.toHaveAttribute("aria-invalid");
    // Error messages never echo the card number.
    expect(container.textContent).not.toContain("4242424242424241");
  });

  test("hideLegend keeps the Payment legend as the group name but visually hidden (U06)", () => {
    const { container } = render(<PaymentFields hideLegend />);
    const legend = container.querySelector("fieldset > legend");
    expect(legend?.textContent).toBe("Payment");
    expect(legend?.className).toBe("sr-only");
    expect(screen.getByRole("group", { name: "Payment" })).toBeTruthy();
  });

  test("legend is visible by default", () => {
    const { container } = render(<PaymentFields />);
    const legend = container.querySelector("fieldset > legend");
    expect(legend?.className).not.toContain("sr-only");
    expect(legend?.className).toContain("text-h4");
  });
});
