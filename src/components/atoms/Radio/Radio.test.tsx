import { describe, expect, mock, test } from "bun:test";
import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Radio, RadioGroup } from "./index";

function Shipping(props: Partial<Parameters<typeof RadioGroup>[0]>) {
  return (
    <RadioGroup label="Shipping speed" name="shipping" {...props}>
      <Radio value="standard" label="Standard" description="5-7 days" />
      <Radio value="express" label="Express" />
      <Radio value="overnight" label="Overnight" />
    </RadioGroup>
  );
}

describe("RadioGroup + Radio", () => {
  test("fieldset radiogroup named by its legend; radios share the name", () => {
    render(<Shipping />);
    const group = screen.getByRole("radiogroup", { name: "Shipping speed" });
    expect(group.tagName).toBe("FIELDSET");
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const r of radios) expect(r).toHaveAttribute("name", "shipping");
    expect(screen.getByRole("radio", { name: "Express" })).toHaveClass("appearance-none", "rounded-full", "border-border-strong");
  });

  test("description linked to its radio", () => {
    render(<Shipping />);
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAccessibleDescription("5-7 days");
  });

  test("defaultValue + posts without JS; label click selects", () => {
    render(
      <form data-testid="f">
        <Shipping defaultValue="express" />
      </form>,
    );
    const form = screen.getByTestId("f") as HTMLFormElement;
    expect(new FormData(form).get("shipping")).toBe("express");
    fireEvent.click(screen.getByText("Overnight"));
    expect(new FormData(form).get("shipping")).toBe("overnight");
    expect(screen.getByRole("radio", { name: "Express" })).not.toBeChecked();
  });

  test("controlled value + onChange(value)", () => {
    const spy = mock();
    function Controlled() {
      const [value, setValue] = useState("standard");
      return (
        <Shipping
          value={value}
          onChange={(v) => {
            spy(v);
            setValue(v);
          }}
        />
      );
    }
    render(<Controlled />);
    expect(screen.getByRole("radio", { name: "Standard" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Express" }));
    expect(spy).toHaveBeenCalledWith("express");
    expect(screen.getByRole("radio", { name: "Express" })).toBeChecked();
  });

  test("invalid + errorText: aria-invalid, described by the alert, danger borders", () => {
    render(<Shipping errorText="Choose a shipping speed" />);
    const group = screen.getByRole("radiogroup");
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(group).toHaveAccessibleDescription("Choose a shipping speed");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a shipping speed");
    for (const r of screen.getAllByRole("radio")) expect(r).toHaveClass("border-danger");
  });

  test("hint and error both describe the group", () => {
    render(<Shipping hint="Arrives by Friday" errorText="Required" />);
    expect(screen.getByRole("radiogroup")).toHaveAccessibleDescription("Arrives by Friday Required");
  });

  test("required: native required on radios + aria-required + visible (required)", () => {
    render(<Shipping required />);
    expect(screen.getByRole("radiogroup")).toHaveAttribute("aria-required", "true");
    for (const r of screen.getAllByRole("radio")) expect(r).toBeRequired();
    expect(screen.getByText("(required)")).toHaveAttribute("aria-hidden", "true");
  });

  test("orientation", () => {
    const { container, rerender } = render(<Shipping />);
    expect(container.querySelector("fieldset > div")).toHaveClass("flex-col");
    rerender(<Shipping orientation="horizontal" />);
    expect(container.querySelector("fieldset > div")).toHaveClass("flex-row", "flex-wrap");
  });

  test("disabled group disables every radio", () => {
    render(<Shipping disabled />);
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
  });

  test("keyboard: native radios are focusable (arrow keys are native)", () => {
    render(<Shipping defaultValue="standard" />);
    const r = screen.getByRole("radio", { name: "Standard" });
    r.focus();
    expect(r).toHaveFocus();
  });

  test("standalone Radio needs name; sizes; ref", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Radio name="x" value="1" label="One" size="lg" ref={ref} />);
    const r = screen.getByRole("radio", { name: "One" });
    expect(r).toHaveAttribute("name", "x");
    expect(r).toHaveClass("size-6");
    expect(ref.current).toBe(r as HTMLInputElement);
  });

  test("group ref and className", () => {
    const ref = createRef<HTMLFieldSetElement>();
    render(<Shipping ref={ref} className="mt-4" />);
    expect(ref.current).toBe(screen.getByRole("radiogroup") as HTMLFieldSetElement);
    expect(ref.current?.className.split(" ").at(-1)).toBe("mt-4");
  });
});
