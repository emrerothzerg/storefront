import { describe, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Card } from "../Card";
import { CategoryTile } from "./CategoryTile";

const list = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

describe("CategoryTile focus ring defers to the base layer (D-T131-4)", () => {
  test.each(["circle", "rounded", "card"] as const)("%s: width/offset on the link, no colour utility", (shape) => {
    render(<CategoryTile href="/category/x" label="Toys" imageSrc={null} shape={shape} />);
    const link = screen.getByRole("link", { name: "Toys" });
    expect(list(link)).toEqual(expect.arrayContaining(["focus-visible:outline-2", "focus-visible:outline-offset-2"]));
    expect(list(link).filter((c) => /outline-(focus-ring|text|accent|none|0)/.test(c))).toEqual([]);
  });

  test("inside a dark Card the link is a descendant of .bg-surface-inverse and pins no colour (white ring applies)", () => {
    render(
      <Card tone="inverse">
        <CategoryTile href="/category/toys" label="Toys" imageSrc={null} />
      </Card>,
    );
    const link = screen.getByRole("link", { name: "Toys" });
    expect(link.closest(".bg-surface-inverse")).not.toBeNull();
    link.focus();
    expect(document.activeElement).toBe(link);
    expect(list(link).some((c) => c.startsWith("focus-visible:outline-") && !/outline-(2|offset-2)$/.test(c))).toBe(false);
  });
});
