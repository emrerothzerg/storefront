import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Chip } from "./Chip";

describe("Chip", () => {
  test("default: button pill with 44px hit area, no aria-pressed without onToggle", () => {
    render(<Chip label="Under $25" />);
    const chip = screen.getByRole("button", { name: "Under $25" });
    expect(chip).toHaveAttribute("type", "button");
    expect(chip).not.toHaveAttribute("aria-pressed");
    expect(chip).toHaveClass("min-h-touch", "rounded-full", "border-border-strong", "bg-surface-raised", "text-text-primary");
  });

  test("toggle: aria-pressed reflects selected; onToggle gets the next state", () => {
    const onToggle = mock();
    const { rerender } = render(<Chip label="Prime" onToggle={onToggle} />);
    const chip = screen.getByRole("button", { name: "Prime", pressed: false });
    fireEvent.click(chip);
    expect(onToggle.mock.calls[0]?.[0]).toBe(true);
    rerender(<Chip label="Prime" selected onToggle={onToggle} />);
    const pressed = screen.getByRole("button", { name: "Prime", pressed: true });
    expect(pressed).toHaveClass("bg-accent-subtle", "text-accent", "border-accent");
    fireEvent.click(pressed);
    expect(onToggle.mock.calls[1]?.[0]).toBe(false);
  });

  test("selected shows a check icon (not colour alone)", () => {
    const { container } = render(<Chip label="4 stars & up" selected onToggle={() => {}} />);
    expect(container.querySelector('[data-icon="check"]')).toHaveAttribute("aria-hidden", "true");
  });

  test("onRemove: separate 'Remove <label>' icon button, no nested interactives", () => {
    const onRemove = mock();
    const onToggle = mock();
    render(<Chip label="Brand: Acme" onRemove={onRemove} onToggle={onToggle} />);
    const remove = screen.getByRole("button", { name: "Remove Brand: Acme" });
    const main = screen.getByRole("button", { name: "Brand: Acme" });
    expect(main.contains(remove)).toBe(false);
    expect(remove.parentElement).toBe(main.parentElement);
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });

  test("as=span: static pill with remove button", () => {
    render(<Chip as="span" label="Size: M" onRemove={() => {}} />);
    expect(screen.queryByRole("button", { name: "Size: M" })).toBeNull();
    expect(screen.getByText("Size: M")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Size: M" })).toBeInTheDocument();
  });

  test("as=a: link with href; selected -> aria-current=true", () => {
    const { rerender } = render(<Chip as="a" href="/search?brand=acme" label="Acme" />);
    const link = screen.getByRole("link", { name: "Acme" });
    expect(link).toHaveAttribute("href", "/search?brand=acme");
    expect(link).not.toHaveAttribute("aria-current");
    rerender(<Chip as="a" href="/search" label="Acme" selected />);
    expect(screen.getByRole("link", { name: "Acme" })).toHaveAttribute("aria-current", "true");
  });

  test("as=a: explicit aria-current overrides the selected default; styling still follows selected", () => {
    const { rerender } = render(
      <Chip as="a" href="/p/1/reviews?stars=5" label="5 stars" selected aria-current="page" />,
    );
    let link = screen.getByRole("link", { name: "5 stars" });
    expect(link).toHaveAttribute("aria-current", "page");
    expect(link).toHaveClass("bg-accent-subtle", "text-accent");
    rerender(<Chip as="a" href="/x" label="5 stars" selected aria-current="false" />);
    expect(screen.getByRole("link", { name: "5 stars" })).toHaveAttribute("aria-current", "false");
    rerender(<Chip as="a" href="/x" label="5 stars" aria-current="location" />);
    link = screen.getByRole("link", { name: "5 stars" });
    expect(link).toHaveAttribute("aria-current", "location");
    expect(link).not.toHaveClass("bg-accent-subtle");
    rerender(<Chip as="a" href="/x" label="5 stars" selected aria-current="page" onRemove={() => {}} />);
    expect(screen.getByRole("link", { name: "5 stars" })).toHaveAttribute("aria-current", "page");
  });

  test("aria-current is only accepted on link chips (compile-time)", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error aria-current is only for as="a" */}
        <Chip label="x" aria-current="page" />
        {/* @ts-expect-error aria-current is only for as="a" */}
        <Chip as="span" label="x" aria-current="page" />
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });

  test("removeLabel overrides the remove button name on every variant; visible text unchanged", () => {
    const onRemove = mock(() => {});
    render(
      <>
        <Chip as="span" label="Acme" onRemove={onRemove} removeLabel="Remove filter: Brand Acme" />
        <Chip label="Prime" onRemove={() => {}} removeLabel="Remove filter: Prime" />
        <Chip as="a" href="/x" label="Blue" onRemove={() => {}} removeLabel="Remove filter: Colour Blue" />
      </>,
    );
    const remove = screen.getByRole("button", { name: "Remove filter: Brand Acme" });
    fireEvent.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Prime" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove filter: Colour Blue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove Acme" })).toBeNull();
  });

  test("removeLabel omitted: default 'Remove <label>' (unchanged)", () => {
    render(<Chip as="span" label="Acme" onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: "Remove Acme" })).toBeInTheDocument();
  });

  test("aria-label overrides the chip's own name (button and link), removable or not", () => {
    render(
      <>
        <Chip label="Acme" aria-label="Brand: Acme" onToggle={() => {}} />
        <Chip as="a" href="/x" label="Blue" aria-label="Colour: Blue" selected />
        <Chip as="a" href="/y" label="Red" aria-label="Colour: Red" onRemove={() => {}} />
      </>,
    );
    expect(screen.getByRole("button", { name: "Brand: Acme" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("link", { name: "Colour: Blue" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Colour: Red" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove Red" })).toBeInTheDocument();
  });

  test("aria-label omitted: no aria-label attribute (name from content)", () => {
    render(<Chip label="Acme" />);
    expect(screen.getByRole("button", { name: "Acme" })).not.toHaveAttribute("aria-label");
  });

  test("aria-label is not accepted on static span chips (compile-time)", () => {
    const compileOnly = () => (
      // @ts-expect-error a role-less span cannot carry a name; use removeLabel
      <Chip as="span" label="x" aria-label="y" />
    );
    expect(typeof compileOnly).toBe("function");
  });

  test("sizes", () => {
    const { rerender } = render(<Chip label="S" size="sm" />);
    expect(screen.getByRole("button")).toHaveClass("px-3", "text-small", "min-h-touch");
    rerender(<Chip label="S" />);
    expect(screen.getByRole("button")).toHaveClass("px-4", "text-body");
  });

  test("keyboard: native button focusable; disabled", () => {
    const { rerender } = render(<Chip label="K" onToggle={() => {}} />);
    const chip = screen.getByRole("button");
    chip.focus();
    expect(chip).toHaveFocus();
    expect(chip.className).not.toMatch(/outline-none/);
    rerender(<Chip label="K" onToggle={() => {}} disabled />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  test("className last on the outer pill; ref", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Chip label="R" className="ml-1" ref={ref} />);
    const chip = screen.getByRole("button");
    expect(chip.className.split(" ").at(-1)).toBe("ml-1");
    expect(ref.current).toBe(chip as HTMLButtonElement);
    const { container } = render(<Chip as="span" label="Q" onRemove={() => {}} className="ml-2" />);
    expect((container.firstElementChild as HTMLElement).className.split(" ").at(-1)).toBe("ml-2");
  });
});
