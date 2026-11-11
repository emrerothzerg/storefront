import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { FormField } from "./FormField";
import { Input } from "../Input";
import { Select } from "../Select";

describe("FormField", () => {
  test("links label to control by id", () => {
    render(<FormField id="email" label="Email">{(p) => <Input {...p} type="email" />}</FormField>);
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("id", "email");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("hint is linked via aria-describedby", () => {
    render(
      <FormField id="email" label="Email" hint="We never share it">
        {(p) => <Input {...p} />}
      </FormField>,
    );
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("aria-describedby", "email-hint");
    expect(input).toHaveAccessibleDescription("We never share it");
  });

  test("error sets aria-invalid, is linked and announced", () => {
    render(
      <FormField id="email" label="Email" hint="Work address" error="Enter a valid email">
        {(p) => <Input {...p} />}
      </FormField>,
    );
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass("border-danger");
    expect(input).toHaveAttribute("aria-describedby", "email-hint email-error");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("id", "email-error");
    expect(alert).toHaveTextContent("Enter a valid email");
    expect(alert).toHaveClass("text-danger", "text-small");
    expect(input).toHaveAccessibleDescription("Work address Enter a valid email");
  });

  test("error without hint describes by error id only", () => {
    render(
      <FormField id="size" label="Size" error="Pick a size">
        {(p) => <Select {...p} options={[{ value: "s", label: "S" }]} />}
      </FormField>,
    );
    const select = screen.getByRole("combobox", { name: "Size" });
    expect(select).toHaveAttribute("aria-describedby", "size-error");
    expect(select).toHaveAttribute("aria-invalid", "true");
  });

  test("required shows a text indicator and sets aria-required + required", () => {
    render(
      <FormField id="name" label="Full name" required>
        {(p) => <Input {...p} />}
      </FormField>,
    );
    const indicator = screen.getByText("(required)");
    expect(indicator).toHaveClass("text-text-secondary");
    expect(indicator.closest("label")).toHaveAttribute("for", "name");
    const input = screen.getByRole("textbox", { name: "Full name" });
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toBeRequired();
  });

  test("optional fields have no indicator or aria-required", () => {
    render(<FormField id="co" label="Company">{(p) => <Input {...p} />}</FormField>);
    expect(screen.queryByText("(required)")).toBeNull();
    expect(screen.getByRole("textbox")).not.toHaveAttribute("aria-required");
    expect(screen.getByRole("textbox")).not.toBeRequired();
  });
});
