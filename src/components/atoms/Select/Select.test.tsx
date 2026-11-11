import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Select } from "./Select";

const options = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large", disabled: true },
] as const;

describe("Select", () => {
  test("renders a native labelled select with options and token classes", () => {
    render(
      <>
        <label htmlFor="size">Size</label>
        <Select id="size" options={options} />
      </>,
    );
    const select = screen.getByLabelText("Size");
    expect(select.tagName).toBe("SELECT");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Small", "Medium", "Large"]);
    expect(screen.getByRole("option", { name: "Large" })).toBeDisabled();
    for (const cls of ["min-h-touch", "bg-surface-raised", "border-border-strong", "rounded-md", "text-body"]) {
      expect(select).toHaveClass(cls);
    }
  });

  test("placeholder is a disabled empty option selected by default", () => {
    render(<Select id="size" aria-label="Size" options={options} placeholder="Choose a size" />);
    const placeholder = screen.getByRole("option", { name: "Choose a size" }) as HTMLOptionElement;
    expect(placeholder).toBeDisabled();
    expect(placeholder.value).toBe("");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("");
  });

  test("controlled value and onChange", () => {
    const calls: string[] = [];
    render(
      <Select
        id="size"
        aria-label="Size"
        options={options}
        placeholder="Choose"
        value="m"
        onChange={(e) => calls.push(e.target.value)}
      />,
    );
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("m");
    fireEvent.change(select, { target: { value: "s" } });
    expect(calls).toEqual(["s"]);
  });

  test("invalid sets aria-invalid and danger border; className merged; ref forwarded", () => {
    const ref = createRef<HTMLSelectElement>();
    render(<Select id="size" aria-label="Size" options={options} invalid className="mt-2" ref={ref} />);
    const select = screen.getByRole("combobox");
    expect(select).toHaveAttribute("aria-invalid", "true");
    expect(select).toHaveClass("border-danger");
    expect(select.className.endsWith("mt-2")).toBe(true);
    expect(ref.current).toBe(select as HTMLSelectElement);
  });
});
