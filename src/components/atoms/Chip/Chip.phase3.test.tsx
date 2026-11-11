import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Chip } from "./Chip";

const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

describe("Chip phase 3", () => {
  test('variant="filled" link chip: grey pill, no visible border, search icon after the label', () => {
    const html = renderToStaticMarkup(
      <Chip as="a" href="/search?q=lamps" label="Lamps" variant="filled" trailingIcon="search" />,
    );
    expect(html).toContain('href="/search?q=lamps"');
    expect(html).toContain("border-transparent bg-surface-sunken text-text-primary");
    expect(html).toContain("hover:bg-border-default");
    expect(html).toMatch(/<span>Lamps<\/span><svg[^>]*aria-hidden="true"/);
  });

  test("trailing icon is decorative: name is the label only", () => {
    render(<Chip label="Lego" variant="filled" trailingIcon="search" onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Lego" })).toBeTruthy();
  });

  test("selected filled chip uses the accent tint + check icon (not colour alone)", () => {
    render(<Chip label="Rugs" variant="filled" selected onToggle={() => {}} />);
    const b = screen.getByRole("button", { name: "Rugs" });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(list(b)).toContain("bg-accent-subtle");
    expect(b.querySelectorAll("svg").length).toBe(1);
  });

  test("keyboard: filled toggle chip is a native button (Enter/Space via click)", () => {
    const onToggle = mock();
    render(<Chip label="Toys" variant="filled" onToggle={onToggle} />);
    const b = screen.getByRole("button", { name: "Toys" });
    b.focus();
    fireEvent.click(b);
    expect(onToggle).toHaveBeenCalledWith(true, expect.anything());
    expect(list(b)).toContain("min-h-touch");
  });

  test("outline stays the default", () => {
    render(<Chip label="Acme" onClick={() => {}} />);
    expect(list(screen.getByRole("button", { name: "Acme" }))).toContain("border-border-strong");
  });
});
