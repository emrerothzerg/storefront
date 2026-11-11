import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Text, type TextTone, type TextVariant } from "./Text";

describe("Text", () => {
  test("defaults to a body, primary <p>", () => {
    render(<Text>Hello</Text>);
    const el = screen.getByText("Hello");
    expect(el.tagName).toBe("P");
    expect(el).toHaveClass("text-body", "text-text-primary");
  });

  test.each(["p", "span", "div"] as const)("renders as <%s>", (as) => {
    render(<Text as={as}>Tagged</Text>);
    expect(screen.getByText("Tagged").tagName).toBe(as.toUpperCase());
  });

  test.each<[TextVariant, string]>([
    ["body", "text-body"],
    ["small", "text-small"],
    ["caption", "text-caption"],
  ])("variant %s uses %s", (variant, cls) => {
    render(<Text variant={variant}>V</Text>);
    expect(screen.getByText("V")).toHaveClass(cls);
  });

  test.each<[TextTone, string]>([
    ["primary", "text-text-primary"],
    ["secondary", "text-text-secondary"],
    ["inverse", "text-text-inverse"],
    ["danger", "text-danger"],
    ["success", "text-success"],
  ])("tone %s uses %s", (tone, cls) => {
    render(<Text tone={tone}>T</Text>);
    expect(screen.getByText("T")).toHaveClass(cls);
  });

  test("merges className last and forwards rest props", () => {
    render(
      <Text className="mt-2" id="help" aria-live="polite">
        Note
      </Text>,
    );
    const el = screen.getByText("Note");
    expect(el).toHaveAttribute("id", "help");
    expect(el).toHaveAttribute("aria-live", "polite");
    expect(el.className.endsWith("mt-2")).toBe(true);
  });

  test("invalid props are compile-time errors", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error "h1" is not an allowed element */}
        <Text as="h1">x</Text>
        {/* @ts-expect-error "warning" is not an allowed tone */}
        <Text tone="warning">x</Text>
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});
