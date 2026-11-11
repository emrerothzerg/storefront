import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button";
import { expectFocused } from "@/test/dom-assertions";

describe("Button", () => {
  test("defaults to type=button, primary, md", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("bg-accent", "text-text-on-accent", "px-4");
  });

  test("type=submit must be explicit and is respected", () => {
    render(<Button type="submit">Pay</Button>);
    expect(screen.getByRole("button", { name: "Pay" })).toHaveAttribute("type", "submit");
  });

  test("calls onClick when clicked", () => {
    const onClick = mock();
    render(<Button onClick={onClick}>Go</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("is keyboard operable: focusable, and Enter/Space activate it", () => {
    const onClick = mock();
    render(<Button onClick={onClick}>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    button.focus();
    expect(button).toHaveFocus();
    // Native <button>: the browser turns Enter (keydown) and Space (keyup)
    // into a click. happy-dom does not synthesise that, so we assert the
    // native element plus the resulting click semantics.
    expect(button.tagName).toBe("BUTTON");
    fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: " ", code: "Space" });
    fireEvent.keyUp(button, { key: " ", code: "Space" });
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test("keeps the base focus-visible ring (no outline overrides)", () => {
    render(<Button className="mt-2">Go</Button>);
    const cls = screen.getByRole("button").className;
    expect(cls).not.toMatch(/outline-none/);
    expect(cls).not.toMatch(/(^|\s)(focus|focus-visible):ring/);
  });

  test("every size keeps a 44px minimum touch target", () => {
    for (const size of ["sm", "md", "lg"] as const) {
      const { unmount } = render(<Button size={size}>X</Button>);
      expect(screen.getByRole("button")).toHaveClass("min-h-touch", "min-w-touch");
      unmount();
    }
  });

  test("variants map to role tokens", () => {
    const { rerender } = render(<Button variant="secondary">X</Button>);
    expect(screen.getByRole("button")).toHaveClass("border-border-strong", "bg-surface-raised");
    rerender(<Button variant="ghost">X</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-transparent", "text-accent");
    rerender(<Button variant="danger">X</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-danger", "text-text-on-accent");
    rerender(<Button variant="primary">X</Button>);
    expect(screen.getByRole("button")).toHaveClass("hover:bg-accent-hover", "active:bg-accent-active");
  });

  test("loading: aria-busy, aria-disabled, spinner before label, label visible, clicks ignored", () => {
    const onClick = mock();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: /save/i });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    const spinner = button.querySelector('[role="status"]');
    expect(spinner).not.toBeNull();
    expect(button.firstElementChild).toBe(spinner);
    expect(screen.getByText("Save")).toBeVisible();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    button.focus();
    expect(button).toHaveFocus();
  });

  test("loading submit button does not submit its form", () => {
    const onSubmit = mock((e: SubmitEvent) => e.preventDefault());
    render(
      <form
        onSubmit={(e) => {
          onSubmit(e.nativeEvent as SubmitEvent);
        }}
      >
        <Button type="submit" loading>
          Pay
        </Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: /pay/i }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("not loading: no aria-busy, no spinner", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button");
    expect(button).not.toHaveAttribute("aria-busy");
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(button.querySelector('[role="status"]')).toBeNull();
  });

  test("disabled sets the native disabled attribute and blocks clicks", () => {
    const onClick = mock();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("disabled");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("fullWidth adds w-full; className is merged last", () => {
    render(
      <Button fullWidth className="mt-4">
        X
      </Button>,
    );
    const button = screen.getByRole("button");
    expect(button).toHaveClass("w-full");
    expect(button.className.endsWith("mt-4")).toBe(true);
  });

  test("padding defaults to the size padding; padding=\"none\" removes it for every size", () => {
    render(
      <>
        <Button size="md">Default</Button>
        <Button size="md" padding="default">
          Explicit
        </Button>
        <Button variant="ghost" size="sm" padding="none" aria-label="Image 1">
          <span>img</span>
        </Button>
        <Button size="md" padding="none">
          Md
        </Button>
        <Button size="lg" padding="none">
          Lg
        </Button>
      </>,
    );
    for (const name of ["Default", "Explicit"]) {
      const b = screen.getByRole("button", { name });
      expect(b).toHaveClass("px-4", "py-2", "text-body");
      expect(b).not.toHaveClass("p-0");
    }
    const thumb = screen.getByRole("button", { name: "Image 1" });
    expect(thumb).toHaveClass("p-0", "text-small", "min-h-touch", "min-w-touch", "rounded-md");
    expect(thumb.className).not.toMatch(/\bp[xy]-\d/);
    expect(screen.getByRole("button", { name: "Md" })).toHaveClass("p-0", "text-body");
    expect(screen.getByRole("button", { name: "Md" }).className).not.toMatch(/\bp[xy]-\d/);
    const lg = screen.getByRole("button", { name: "Lg" });
    expect(lg).toHaveClass("p-0", "min-h-12");
    expect(lg.className).not.toMatch(/\bp[xy]-\d/);
  });

  test("padding=\"none\" keeps behaviour: focusable, clickable, loading still swallows clicks", () => {
    const onClick = mock(() => {});
    const { rerender } = render(
      <Button padding="none" onClick={onClick}>
        Thumb
      </Button>,
    );
    const b = screen.getByRole("button", { name: "Thumb" });
    b.focus();
    expectFocused(b);
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledTimes(1);
    rerender(
      <Button padding="none" onClick={onClick} loading>
        Thumb
      </Button>,
    );
    // The Spinner adds its own hidden status text, so query without a name.
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("forwards ref (React 19 ref as prop) and passes through attributes", () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} aria-label="Close" data-x="1">
        ×
      </Button>,
    );
    expect(ref.current).toBe(screen.getByRole<HTMLButtonElement>("button", { name: "Close" }));
    expect(ref.current).toHaveAttribute("data-x", "1");
  });
});
