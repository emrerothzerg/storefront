import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { Input } from "./Input";

const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

describe('Input variant="pill"', () => {
  test("rounded-full, sunken fill, 48px, keeps the 3:1 border-strong edge", () => {
    render(<Input id="q" aria-label="Search" variant="pill" />);
    const el = screen.getByRole("textbox", { name: "Search" });
    for (const c of ["rounded-full", "bg-surface-sunken", "min-h-12", "border", "border-border-strong", "px-5"]) {
      expect(list(el)).toContain(c);
    }
    expect(list(el)).not.toContain("rounded-md");
  });

  test("invalid pill swaps to the danger border", () => {
    render(<Input id="q" aria-label="Search" variant="pill" invalid />);
    const el = screen.getByRole("textbox", { name: "Search" });
    expect(list(el)).toContain("border-danger");
    expect(el.getAttribute("aria-invalid")).toBe("true");
  });

  test("default variant markup unchanged", () => {
    expect(renderToStaticMarkup(<Input id="a" />)).toBe(
      '<input id="a" type="text" class="block w-full min-h-touch px-3 py-2 bg-surface-raised border rounded-md text-body text-text-primary placeholder:text-text-secondary disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-secondary border-border-strong"/>',
    );
  });
});
