import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { Input } from "./Input";

describe("Input", () => {
  test("renders a labelled text input with token classes", () => {
    render(
      <>
        <label htmlFor="email">Email</label>
        <Input id="email" type="email" placeholder="you@example.com" />
      </>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("id", "email");
    for (const cls of [
      "min-h-touch",
      "bg-surface-raised",
      "border",
      "border-border-strong",
      "rounded-md",
      "text-body",
      "text-text-primary",
      "placeholder:text-text-secondary",
    ]) {
      expect(input).toHaveClass(cls);
    }
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  test("defaults type to text", () => {
    render(<Input id="x" aria-label="X" />);
    expect(screen.getByRole("textbox", { name: "X" })).toHaveAttribute("type", "text");
  });

  test("invalid sets aria-invalid and danger border", () => {
    render(<Input id="x" aria-label="X" invalid />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass("border-danger");
    expect(input).not.toHaveClass("border-border-strong");
  });

  test("aria-invalid=\"true\" from FormField also gets the danger border", () => {
    render(<Input id="x" aria-label="X" aria-invalid="true" />);
    expect(screen.getByRole("textbox")).toHaveClass("border-danger");
  });

  test("merges className last and forwards ref and native props", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input id="x" aria-label="X" className="mt-2" ref={ref} name="q" required />);
    const input = screen.getByRole("textbox");
    expect(input.className.endsWith("mt-2")).toBe(true);
    expect(ref.current).toBe(input as HTMLInputElement);
    expect(input).toHaveAttribute("name", "q");
    expect(input).toBeRequired();
  });
});
