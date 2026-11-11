import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { Link } from "./Link";
import { buttonClassName } from "../Button/button-classes";

const cls = (el: Element): string => el.getAttribute("class") ?? "";

describe("Link phase 3: button looks", () => {
  test('variant="button" defaults to the primary md pill (same table as Button, no button-only states)', () => {
    render(<Link href="/deals" variant="button">Shop deals</Link>);
    const a = screen.getByRole("link", { name: "Shop deals" });
    expect(cls(a)).toBe(
      buttonClassName({ variant: "primary", size: "md", withStates: false, className: "no-underline hover:no-underline" }),
    );
    expect(cls(a)).toContain("rounded-full");
    expect(cls(a)).not.toContain("disabled:");
  });

  test.each([
    ["secondary", "border-border-strong"],
    ["outline", "border-accent"],
    ["inverse", "bg-surface-raised"],
  ] as const)("buttonVariant=%s applies %s", (buttonVariant, expected) => {
    const html = renderToStaticMarkup(
      <Link href="/x" variant="button" buttonVariant={buttonVariant}>Go</Link>,
    );
    expect(html).toContain(expected);
    expect(html).toContain("min-h-touch");
    expect(html).toContain('href="/x"');
  });

  test("buttonSize=lg uses the large padding; props never leak into the DOM", () => {
    render(<Link href="/x" variant="button" buttonSize="lg">Big</Link>);
    const a = screen.getByRole("link", { name: "Big" });
    expect(cls(a)).toContain("px-6");
    expect(a.hasAttribute("buttonvariant")).toBe(false);
    expect(a.hasAttribute("buttonsize")).toBe(false);
  });

  test("text variants are unchanged", () => {
    render(<Link href="/a">Inline</Link>);
    expect(cls(screen.getByRole("link"))).toBe("text-accent underline underline-offset-2 hover:decoration-2");
  });
});
