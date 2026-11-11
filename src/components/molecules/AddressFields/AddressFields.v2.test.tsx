import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { ADDRESS_MAX_LENGTH } from "../_contracts/address-actions";
import { AddressFieldsMvp } from "./__fixtures__/AddressFieldsMvp";
import { AddressFields, type AddressFieldsProps } from "./AddressFields";

const MVP_PROP_SETS: ReadonlyArray<{ name: string; props: AddressFieldsProps }> = [
  { name: "no props", props: {} },
  {
    name: "errors + values + prefix + class",
    props: {
      errors: { email: { code: "REQUIRED", message: "Enter your email." }, country: { code: "INVALID_COUNTRY", message: "Pick one." } },
      defaultValues: { fullName: "Ada", email: "ada@example.com", line1: "1 Main St", line2: "Flat 2", country: "gb" },
      idPrefix: "ship",
      className: "mt-4",
    },
  },
  { name: "custom countries", props: { countries: [{ value: "US", label: "United States" }] } },
];

describe("AddressFields R1 (additive omit / legend / maxLengths)", () => {
  test.each(MVP_PROP_SETS)("default markup is byte-identical to the MVP ($name)", ({ props }) => {
    expect(renderToStaticMarkup(<AddressFields {...props} />)).toBe(renderToStaticMarkup(<AddressFieldsMvp {...props} />));
  });

  test("explicit defaults (omit [], default legend, empty maxLengths) are also identical", () => {
    expect(renderToStaticMarkup(<AddressFields omit={[]} legend="Shipping address" maxLengths={{}} />)).toBe(
      renderToStaticMarkup(<AddressFieldsMvp />),
    );
  });

  test("omit removes the field entirely (no input, no label, no grid cell)", () => {
    const { container } = render(<AddressFields omit={["email"]} />);
    expect(container.querySelector('[name="email"]')).toBeNull();
    expect(screen.queryByLabelText(/^Email/)).toBeNull();
    expect(container.querySelectorAll("input, select")).toHaveLength(7);
    expect(container.querySelector(".grid")?.children).toHaveLength(7);
  });

  test("omit several fields keeps the rest in MVP order", () => {
    const { container } = render(<AddressFields omit={["email", "line2"]} />);
    const names = Array.from(container.querySelectorAll("input, select")).map((el) => el.getAttribute("name"));
    expect(names).toEqual(["fullName", "line1", "city", "region", "postalCode", "country"]);
  });

  test("legend overrides the group name", () => {
    render(<AddressFields legend="Address" />);
    expect(screen.getByRole("group", { name: "Address" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Shipping address" })).toBeNull();
  });

  test("maxLengths set maxlength on text inputs only (country is a select)", () => {
    const { container } = render(<AddressFields maxLengths={{ ...ADDRESS_MAX_LENGTH, email: 254 }} />);
    for (const name of ["fullName", "line1", "line2", "city", "region", "postalCode"] as const) {
      expect(container.querySelector(`[name="${name}"]`)?.getAttribute("maxlength")).toBe(String(ADDRESS_MAX_LENGTH[name]));
    }
    expect(container.querySelector('[name="email"]')?.getAttribute("maxlength")).toBe("254");
    expect(container.querySelector('[name="country"]')?.hasAttribute("maxlength")).toBe(false);
  });

  test("partial maxLengths leave the other inputs without maxlength", () => {
    const { container } = render(<AddressFields maxLengths={{ city: 50 }} />);
    expect(container.querySelector('[name="city"]')?.getAttribute("maxlength")).toBe("50");
    expect(container.querySelector('[name="line1"]')?.hasAttribute("maxlength")).toBe(false);
  });

  test("errors for omitted fields are not rendered", () => {
    render(<AddressFields omit={["email"]} errors={{ email: { code: "REQUIRED", message: "Enter your email." } }} />);
    expect(screen.queryByText("Enter your email.")).toBeNull();
  });

  test("hideLegend keeps the legend in the DOM as the fieldset name but visually hidden (U06)", () => {
    const { container } = render(<AddressFields legend="Shipping address" hideLegend />);
    const legend = container.querySelector("fieldset > legend");
    expect(legend?.textContent).toBe("Shipping address");
    expect(legend?.className).toBe("sr-only");
    expect(screen.getByRole("group", { name: "Shipping address" })).toBeTruthy();
    const visible = render(<AddressFields legend="Other" />).container.querySelector("legend");
    expect(visible?.className).not.toContain("sr-only");
    expect(visible?.className).toContain("text-h4");
  });
});
