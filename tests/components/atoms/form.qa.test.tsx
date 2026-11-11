// QA (T04.1, T04.2, T04.5): Input, Select, FormField adversarial checks.
import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { FormField } from "@/components/atoms/FormField";
import { Input, type InputType } from "@/components/atoms/Input";
import { Select } from "@/components/atoms/Select";

const OPTS = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large", disabled: true },
];

describe("Input", () => {
  const types: InputType[] = ["text", "email", "tel", "number", "password", "search"];
  test.each(types.map((t) => [t]))("type=%s renders that type with a 44px min height", (type) => {
    const { container } = render(<Input id="i" type={type} />);
    const input = container.querySelector("input");
    expect(input).toHaveAttribute("type", type);
    expect(input).toHaveClass("min-h-touch", "border-border-strong");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  test("defaults to type=text", () => {
    const { container } = render(<Input id="i" />);
    expect(container.querySelector("input")).toHaveAttribute("type", "text");
  });

  test.each([
    ["invalid", { invalid: true }],
    ["aria-invalid='true'", { "aria-invalid": "true" as const }],
    ["aria-invalid={true}", { "aria-invalid": true }],
  ])("%s => aria-invalid=true + danger border", (_l, props) => {
    const { container } = render(<Input id="i" {...props} />);
    const input = container.querySelector("input");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass("border-danger");
    expect(input).not.toHaveClass("border-border-strong");
  });

  test("aria-invalid=false passes through, normal border", () => {
    const { container } = render(<Input id="i" aria-invalid={false} />);
    const input = container.querySelector("input");
    expect(input).toHaveAttribute("aria-invalid", "false");
    expect(input).toHaveClass("border-border-strong");
  });

  test("ref forwards and className appends last", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input id="i" ref={ref} className="mt-2" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    expect(ref.current?.className.endsWith("mt-2")).toBe(true);
  });

  test("type contract: id required, unsupported types rejected (compile-only)", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error id is required */}
        <Input />
        {/* @ts-expect-error date is not an InputType */}
        <Input id="x" type="date" />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});

describe("Select placeholder behaviour", () => {
  test("placeholder without value: placeholder selected, disabled, value ''", () => {
    const { container } = render(<Select id="s" options={OPTS} placeholder="Choose a size" />);
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.value).toBe("");
    const first = select.options[0];
    expect(first?.textContent).toBe("Choose a size");
    expect(first?.disabled).toBe(true);
    expect(first?.selected).toBe(true);
  });

  test("placeholder with controlled value selects that value", () => {
    const { container } = render(
      <Select id="s" options={OPTS} placeholder="Choose" value="m" onChange={() => {}} />,
    );
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("m");
  });

  test("placeholder with defaultValue selects that value", () => {
    const { container } = render(<Select id="s" options={OPTS} placeholder="Choose" defaultValue="s" />);
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("s");
  });

  test("controlled value='' shows the placeholder", () => {
    const { container } = render(
      <Select id="s" options={OPTS} placeholder="Choose" value="" onChange={() => {}} />,
    );
    expect((container.querySelector("select") as HTMLSelectElement).value).toBe("");
  });

  test("no placeholder: browser default (first option) is selected", () => {
    const { container } = render(<Select id="s" options={OPTS} />);
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select.options).toHaveLength(3);
    expect(select.value).toBe("s");
  });

  test("disabled option is rendered disabled", () => {
    const { container } = render(<Select id="s" options={OPTS} />);
    expect((container.querySelector("select") as HTMLSelectElement).options[2]?.disabled).toBe(true);
  });

  test("onChange fires with the chosen value", () => {
    const onChange = mock((e: { target: { value: string } }) => e.target.value);
    const { container } = render(<Select id="s" options={OPTS} placeholder="Choose" onChange={onChange} />);
    fireEvent.change(container.querySelector("select") as HTMLSelectElement, { target: { value: "m" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.results[0]?.value).toBe("m");
  });

  test("invalid => aria-invalid + danger border; 44px min height", () => {
    const { container } = render(<Select id="s" options={OPTS} invalid />);
    const select = container.querySelector("select");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveClass("border-danger", "min-h-touch");
  });
});

describe("FormField wiring (exact aria-describedby)", () => {
  function field(props: { hint?: string; error?: string; required?: boolean }) {
    return render(
      <FormField id="email" label="Email" {...props}>
        {(p) => <Input {...p} type="email" />}
      </FormField>,
    );
  }

  test("neither hint nor error: no aria-describedby, no aria-invalid", () => {
    field({});
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("id", "email");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("hint only: aria-describedby='email-hint'", () => {
    field({ hint: "We never share it" });
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input.getAttribute("aria-describedby")).toBe("email-hint");
    expect(input).toHaveAccessibleDescription("We never share it");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  test("error only: aria-describedby='email-error', aria-invalid, role=alert", () => {
    field({ error: "Enter a valid email" });
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input.getAttribute("aria-describedby")).toBe("email-error");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass("border-danger");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("id", "email-error");
    expect(alert).toHaveTextContent("Enter a valid email");
  });

  test("hint + error: aria-describedby='email-hint email-error' in that order", () => {
    field({ hint: "Hint", error: "Bad" });
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input.getAttribute("aria-describedby")).toBe("email-hint email-error");
    expect(input).toHaveAccessibleDescription("Hint Bad");
  });

  test("error='' is treated as no error", () => {
    field({ error: "" });
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("required: visible '(required)' text, aria-required + native required on control", () => {
    const { container } = field({ required: true });
    const input = screen.getByRole("textbox", { name: "Email" });
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toBeRequired();
    const label = container.querySelector("label");
    expect(label).toHaveTextContent("Email (required)");
    expect(screen.getByText("(required)")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("(required)")).not.toHaveClass("sr-only");
  });

  test("not required: no indicator, no aria-required", () => {
    const { container } = field({});
    expect(container.querySelector("label")).toHaveTextContent(/^Email$/);
    expect(screen.getByRole("textbox", { name: "Email" })).not.toHaveAttribute("aria-required");
  });

  test("works with Select: label linked, error wiring applied", () => {
    render(
      <FormField id="size" label="Size" required error="Pick a size">
        {(p) => <Select {...p} options={OPTS} placeholder="Choose" />}
      </FormField>,
    );
    const select = screen.getByRole("combobox", { name: "Size" });
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveAttribute("aria-required", "true");
    expect(select.getAttribute("aria-describedby")).toBe("size-error");
  });

  test("clearing the error removes aria-invalid and the alert", () => {
    const { rerender } = render(
      <FormField id="e" label="E" error="Bad">
        {(p) => <Input {...p} />}
      </FormField>,
    );
    rerender(
      <FormField id="e" label="E">
        {(p) => <Input {...p} />}
      </FormField>,
    );
    const input = screen.getByRole("textbox", { name: "E" });
    expect(input).not.toHaveAttribute("aria-invalid");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
