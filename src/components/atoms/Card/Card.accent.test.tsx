import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compile } from "tailwindcss";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { Button } from "../Button";
import { Link } from "../Link";
import { Card } from "./Card";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");
const RING = "**:focus-visible:outline-focus-ring-inverse";

describe('Card tone="accent" (request by)', () => {
  test("blue fill, white text, white focus ring for descendants; no border or shadow by default", () => {
    render(<Card tone="accent" data-testid="c">x</Card>);
    const c = list(screen.getByTestId("c"));
    for (const k of ["bg-accent", "text-text-on-accent", RING]) expect(c).toContain(k);
    for (const k of ["border", "shadow-sm", "bg-surface-raised"]) expect(c).not.toContain(k);
  });

  test("never focusable itself; actions inside stay native and reachable", () => {
    render(
      <Card tone="accent" data-testid="c">
        <Link href="/deals" variant="button" buttonVariant="inverse">Shop deals</Link>
        <Button variant="inverse">Save</Button>
      </Card>,
    );
    expect(screen.getByTestId("c").hasAttribute("tabindex")).toBe(false);
    const link = screen.getByRole("link", { name: "Shop deals" });
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });

  test("other tones do not get the descendant ring override", () => {
    const html = renderToStaticMarkup(
      <>
        {(["raised", "sunken", "accent-subtle", "promo-subtle", "deal-subtle", "promo", "inverse"] as const).map((t) => (
          <Card key={t} tone={t}>x</Card>
        ))}
      </>,
    );
    expect(html).not.toContain("focus-ring-inverse");
  });

  test("Tailwind compiles the override to a descendant :focus-visible rule using --focus-ring-inverse", async () => {
    const css = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
    const compiler = await compile(css, {
      base: join(ROOT, "src/app"),
      loadStylesheet: async (id: string, base: string) => {
        const path = id === "tailwindcss" ? join(ROOT, "node_modules/tailwindcss/index.css") : join(base, id);
        return { path, base: dirname(path), content: readFileSync(path, "utf8") };
      },
    });
    const out = compiler.build([RING]);
    const rule = out.match(/:is\(\.\\\*\\\*\\:focus-visible\\:outline-focus-ring-inverse \*\):focus-visible\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain("outline-color: var(--focus-ring-inverse)");
  });
});
