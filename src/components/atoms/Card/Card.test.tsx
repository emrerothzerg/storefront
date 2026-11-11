import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen } from "@testing-library/react";
import { Card, type CardTone } from "./Card";

const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

describe("Card", () => {
  test("defaults: div, white raised surface, soft border, soft shadow, 12px corners, md padding", () => {
    const html = renderToStaticMarkup(<Card>Body</Card>);
    expect(html).toBe(
      '<div class="relative min-w-0 rounded-lg bg-surface-raised text-text-primary border border-border-default shadow-sm p-4 sm:p-5">Body</div>',
    );
  });

  test.each<[CardTone, string, string]>([
    ["sunken", "bg-surface-sunken", "text-text-primary"],
    ["accent-subtle", "bg-accent-subtle", "text-text-primary"],
    ["promo-subtle", "bg-promo-subtle", "text-text-primary"],
    ["deal-subtle", "bg-deal-subtle", "text-text-primary"],
    ["promo", "bg-promo", "text-text-primary"],
    ["inverse", "bg-surface-inverse", "text-text-inverse"],
  ])("tone %s -> %s %s, no border or shadow by default", (tone, bg, fg) => {
    render(<Card tone={tone} data-testid="c">x</Card>);
    const el = screen.getByTestId("c");
    expect(list(el)).toContain(bg);
    expect(list(el)).toContain(fg);
    expect(list(el)).not.toContain("border");
    expect(list(el)).not.toContain("shadow-sm");
  });

  test("as, padding, elevation, bordered, radius, interactive", () => {
    render(
      <ul>
        <Card as="li" padding="lg" elevation="md" bordered={false} radius="xl" interactive data-testid="c">
          x
        </Card>
      </ul>,
    );
    const el = screen.getByTestId("c");
    expect(el.tagName).toBe("LI");
    for (const c of ["p-6", "md:p-8", "shadow-md", "rounded-xl", "transition-shadow", "hover:shadow-md"]) {
      expect(list(el)).toContain(c);
    }
    expect(list(el)).not.toContain("border");
  });

  test("article with an accessible name keeps semantics; card itself is not focusable", () => {
    render(
      <Card as="article" aria-labelledby="t">
        <h3 id="t">Desk lamp</h3>
      </Card>,
    );
    const article = screen.getByRole("article", { name: "Desk lamp" });
    expect(article.hasAttribute("tabindex")).toBe(false);
  });

  test("padding none adds no padding class; className merges last; ref forwarded", () => {
    const ref = createRef<HTMLElement>();
    render(<Card padding="none" className="mt-4" ref={ref} data-testid="c">x</Card>);
    const el = screen.getByTestId("c");
    expect(list(el).some((c) => /^p-/.test(c))).toBe(false);
    expect(list(el).at(-1)).toBe("mt-4");
    expect(ref.current === el).toBe(true);
  });
});
