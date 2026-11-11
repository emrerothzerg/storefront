import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button";
import { buttonClassName } from "./button-classes";
import { IconButton } from "../IconButton";
import { expectFocused } from "@/test/dom-assertions";

const classList = (el: Element): string[] => (el.getAttribute("class") ?? "").split(" ");

describe("Button phase 3: shape", () => {
  test("defaults to a pill (rounded-full), never rounded-md", () => {
    render(<Button>Shop now</Button>);
    const list = classList(screen.getByRole("button"));
    expect(list).toContain("rounded-full");
    expect(list).not.toContain("rounded-md");
  });

  test('shape="rounded" gives 8px corners', () => {
    render(<Button shape="rounded">Go</Button>);
    expect(classList(screen.getByRole("button"))).toContain("rounded-md");
  });

  test('padding="none" defaults to rounded corners (thumbnails), pill on request', () => {
    render(
      <>
        <Button padding="none" aria-label="thumb">x</Button>
        <Button padding="none" shape="pill" aria-label="round">x</Button>
      </>,
    );
    expect(classList(screen.getByRole("button", { name: "thumb" }))).toContain("rounded-md");
    expect(classList(screen.getByRole("button", { name: "round" }))).toContain("rounded-full");
  });

  test("IconButton inherits the pill shape (circle) and keeps its square box", () => {
    render(<IconButton icon="heart" label="Save" />);
    const list = classList(screen.getByRole("button", { name: "Save" }));
    expect(list).toContain("rounded-full");
    expect(list).toContain("size-touch");
  });
});

describe("Button phase 3: new variants", () => {
  test.each([
    ["outline", ["border", "border-accent", "bg-surface-raised", "text-accent", "hover:bg-accent-subtle"]],
    ["inverse", ["bg-surface-raised", "text-text-primary", "hover:bg-surface-sunken"]],
    ["danger", ["bg-danger", "text-text-on-accent", "hover:bg-danger-hover"]],
  ] as const)("%s uses verified token pairs", (variant, expected) => {
    render(<Button variant={variant}>Label</Button>);
    const list = classList(screen.getByRole("button", { name: "Label" }));
    for (const c of expected) expect(list).toContain(c);
    for (const c of ["min-h-touch", "min-w-touch", "rounded-full"]) expect(list).toContain(c);
  });

  test("existing variants keep their colour classes", () => {
    for (const [variant, cls] of [
      ["primary", "bg-accent"],
      ["secondary", "border-border-strong"],
      ["ghost", "text-accent"],
    ] as const) {
      const html = renderToStaticMarkup(<Button variant={variant}>x</Button>);
      expect(html).toContain(cls);
    }
  });
});

describe("Button phase 3: quick-add", () => {
  test("server markup: transparent 44px hit area, inner accent pill with a plus icon and 'Add'", () => {
    const html = renderToStaticMarkup(<Button variant="quick-add" aria-label="Add Desk lamp to cart" />);
    expect(html).toContain('aria-label="Add Desk lamp to cart"');
    expect(html).toContain('data-slot="quick-add-pill"');
    expect(html).toContain(">Add</span>");
    expect(html).toContain("<svg");
    const outer = html.slice(0, html.indexOf(">"));
    for (const c of ["min-h-touch", "min-w-touch", "bg-transparent", "p-0", "rounded-full", "group"]) {
      expect(outer).toContain(c);
    }
    expect(outer).not.toContain("bg-accent");
  });

  test("inner pill carries the accent fill and group hover/active states", () => {
    render(<Button variant="quick-add">Add</Button>);
    const pill = screen.getByText("Add");
    expect(pill.getAttribute("data-slot")).toBe("quick-add-pill");
    for (const c of ["bg-accent", "text-text-on-accent", "rounded-full", "group-hover:bg-accent-hover", "group-active:bg-accent-active"]) {
      expect(classList(pill)).toContain(c);
    }
  });

  test("custom children replace the default label; sizes change the pill only", () => {
    render(
      <>
        <Button variant="quick-add" size="sm">Add to cart</Button>
        <Button variant="quick-add" size="lg">Quick add</Button>
      </>,
    );
    expect(classList(screen.getByText("Add to cart"))).toContain("text-caption");
    expect(classList(screen.getByText("Quick add"))).toContain("text-body");
    for (const b of screen.getAllByRole("button")) expect(classList(b)).toContain("p-0");
  });

  test("keyboard: focusable, Enter/Space activate; accessible name from aria-label", () => {
    const onClick = mock();
    render(<Button variant="quick-add" aria-label="Add Mug to cart" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Add Mug to cart" });
    button.focus();
    expectFocused(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("loading: spinner replaces the plus icon inside the pill; clicks swallowed", () => {
    const onClick = mock();
    render(<Button variant="quick-add" loading onClick={onClick}>Add</Button>);
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("buttonClassName (shared with Link)", () => {
  test("withStates=false drops the disabled/busy utilities", () => {
    const a = buttonClassName({ withStates: false });
    expect(a).not.toContain("disabled:");
    expect(a).not.toContain("aria-busy:");
    expect(buttonClassName()).toContain("disabled:opacity-50");
  });

  test("Button renders exactly buttonClassName's output (single source of truth)", () => {
    const html = renderToStaticMarkup(<Button variant="outline" size="lg" fullWidth className="mt-2">x</Button>);
    expect(html).toBe(
      `<button type="button" class="${buttonClassName({ variant: "outline", size: "lg", fullWidth: true, className: "mt-2" })}">x</button>`,
    );
  });
});
