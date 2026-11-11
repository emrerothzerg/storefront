import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Breadcrumb } from "./Breadcrumb";
import { expectFocused } from "@/test/dom-assertions";

const items = [
  { label: "Home", href: "/" },
  { label: "Electronics", href: "/c/electronics" },
  { label: "Audio", href: "/c/audio" },
  { label: "Headphones", href: "/c/headphones" },
  { label: "Noise Cancelling X1" },
];

describe("Breadcrumb", () => {
  test("renders a labelled nav with an ordered list", () => {
    render(<Breadcrumb items={items} />);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    const list = within(nav).getByRole("list");
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  });

  test("ancestors are links (Link atom); last item is aria-current=page", () => {
    render(<Breadcrumb items={items} />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Audio" })).toHaveClass("min-h-touch");
    const current = screen.getByText("Noise Cancelling X1");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(current.tagName).toBe("SPAN");
    expect(screen.getAllByRole("link")).toHaveLength(4);
  });

  test("a last item with href is a current-page link", () => {
    render(<Breadcrumb items={[{ label: "Home", href: "/" }, { label: "Deals", href: "/deals" }]} />);
    expect(screen.getByRole("link", { name: "Deals" })).toHaveAttribute("aria-current", "page");
  });

  test("separators are aria-hidden and one fewer than items", () => {
    const { container } = render(<Breadcrumb items={items} />);
    const seps = container.querySelectorAll("[data-breadcrumb-separator]");
    expect(seps).toHaveLength(4);
    for (const sep of seps) expect(sep).toHaveAttribute("aria-hidden", "true");
  });

  test("no-JS: server HTML includes every item even with maxItems", () => {
    const html = renderToStaticMarkup(<Breadcrumb items={items} maxItems={3} />);
    for (const item of items) expect(html).toContain(item.label);
    expect(html).not.toContain("<button");
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('aria-current="page"');
  });

  test("after hydration, collapses middle items behind an ellipsis button", () => {
    render(<Breadcrumb items={items} maxItems={3} />);
    expect(screen.getByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Electronics" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Audio" })).toBeNull();
    expect(screen.getByRole("link", { name: "Headphones" })).toBeInTheDocument();
    const more = screen.getByRole("button", { name: "Show 2 more breadcrumb levels" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveClass("min-h-touch", "min-w-touch");
  });

  test("ellipsis expands on click and moves focus to the first revealed link", () => {
    render(<Breadcrumb items={items} maxItems={3} />);
    fireEvent.click(screen.getByRole("button", { name: /more breadcrumb/ }));
    expect(screen.queryByRole("button")).toBeNull();
    const electronics = screen.getByRole("link", { name: "Electronics" });
    expectFocused(electronics);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  test("ellipsis button is keyboard operable (native button)", () => {
    render(<Breadcrumb items={items} maxItems={4} />);
    const more = screen.getByRole("button", { name: "Show 1 more breadcrumb level" });
    more.focus();
    expectFocused(more);
    expect(more.tagName).toBe("BUTTON");
    expect(more).toHaveAttribute("type", "button");
  });

  test("does not collapse when items fit", () => {
    render(<Breadcrumb items={items} maxItems={5} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("custom label, ref and className", () => {
    const ref = createRef<HTMLElement>();
    render(<Breadcrumb items={items} label="You are here" ref={ref} className="x-bc" />);
    const nav = screen.getByRole("navigation", { name: "You are here" });
    expect(ref.current).toBe(nav);
    expect(nav.className.endsWith("x-bc")).toBe(true);
  });

  test("expanding focuses the first revealed item even without an href", () => {
    render(
      <Breadcrumb
        maxItems={3}
        items={[
          { label: "Home", href: "/" },
          { label: "Department" },
          { label: "Aisle", href: "/a" },
          { label: "Shelf", href: "/s" },
          { label: "Product" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /more breadcrumb/ }));
    const dept = screen.getByText("Department");
    expectFocused(dept);
    expect(dept).toHaveAttribute("tabindex", "-1");
  });
});
