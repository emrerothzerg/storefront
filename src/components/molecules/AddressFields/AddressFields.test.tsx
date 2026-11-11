import { describe, expect, test } from "bun:test";
import { render, screen, within } from "@testing-library/react";
import { validateAddress } from "@/lib/validation";
import { AddressFields } from "./AddressFields";

const FIELDS = [
  { label: "Full name", name: "fullName", autocomplete: "name", required: true },
  { label: "Email", name: "email", autocomplete: "email", inputmode: "email", required: true },
  { label: "Address line 1", name: "line1", autocomplete: "address-line1", required: true },
  { label: "Address line 2", name: "line2", autocomplete: "address-line2", required: false },
  { label: "City", name: "city", autocomplete: "address-level2", required: true },
  { label: "State / province / region", name: "region", autocomplete: "address-level1", required: true },
  { label: "Postal code", name: "postalCode", autocomplete: "postal-code", inputmode: "text", required: true },
  { label: "Country", name: "country", autocomplete: "country", required: true },
] as const;

describe("AddressFields", () => {
  test("fieldset with legend wraps every field", () => {
    render(<AddressFields />);
    const group = screen.getByRole("group", { name: "Shipping address" });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelectorAll("input, select")).toHaveLength(FIELDS.length);
  });

  test.each(FIELDS)("$name: labelled, autocomplete, inputmode, required", (f) => {
    render(<AddressFields />);
    const el = screen.getByLabelText(new RegExp(`^${f.label.replace(/[/]/g, "\\/")}`));
    expect(el).toHaveAttribute("name", f.name);
    expect(el).toHaveAttribute("id", `address-${f.name}`);
    expect(el).toHaveAttribute("autocomplete", f.autocomplete);
    if ("inputmode" in f) expect(el).toHaveAttribute("inputmode", f.inputmode);
    if (f.required) expect(el).toBeRequired();
    else expect(el).not.toBeRequired();
  });

  test("email uses type=email; country is a select with the default ISO-2 list", () => {
    render(<AddressFields />);
    expect(screen.getByRole("textbox", { name: /^Email/ })).toHaveAttribute("type", "email");
    const country = screen.getByRole("combobox", { name: /^Country/ }) as HTMLSelectElement;
    expect(country.value).toBe("");
    const values = within(country)
      .getAllByRole("option")
      .map((o) => (o as HTMLOptionElement).value)
      .filter(Boolean);
    expect(values).toEqual(["US", "CA", "GB", "DE", "FR", "TR", "AU"]);
  });

  test("required indicator on all but line2", () => {
    render(<AddressFields />);
    expect(screen.getAllByText("(required)")).toHaveLength(7);
    const line2Label = document.querySelector('label[for="address-line2"]');
    expect(line2Label).not.toHaveTextContent("(required)");
  });

  test("idPrefix, countries and defaultValues", () => {
    render(
      <AddressFields
        idPrefix="ship"
        countries={[{ value: "NL", label: "Netherlands" }]}
        defaultValues={{ fullName: "Ada Lovelace", city: "London", country: "nl" }}
      />,
    );
    expect(screen.getByRole("textbox", { name: /^Full name/ })).toHaveValue("Ada Lovelace");
    expect(screen.getByRole("textbox", { name: /^City/ })).toHaveAttribute("id", "ship-city");
    expect((screen.getByRole("combobox", { name: /^Country/ }) as HTMLSelectElement).value).toBe("NL");
  });

  test("errors from validateAddress are shown next to the field and linked via aria-describedby", () => {
    const result = validateAddress({
      fullName: "Ada",
      email: "not-an-email",
      line1: "1 Main St",
      city: "",
      region: "CA",
      postalCode: "94000",
      country: "US",
    });
    if (result.ok) throw new Error("expected validation failure");
    const errors = result.error.details.fields;

    render(<AddressFields errors={errors} />);

    const email = screen.getByRole("textbox", { name: /^Email/ });
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAttribute("aria-describedby", "address-email-error");
    expect(email).toHaveAccessibleDescription("Enter a valid email address.");
    const emailError = document.getElementById("address-email-error");
    expect(emailError).toHaveTextContent("Enter a valid email address.");
    // Rendered in the same field wrapper as the input.
    expect(emailError?.parentElement).toBe(email.parentElement);

    expect(screen.getByRole("textbox", { name: /^City/ })).toHaveAccessibleDescription("City is required.");
    expect(screen.getByRole("textbox", { name: /^Full name/ })).not.toHaveAttribute("aria-invalid");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
  });
});
