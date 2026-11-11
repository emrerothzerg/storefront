import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { IconButton } from "./IconButton";

describe("IconButton", () => {
  test("label becomes the accessible name; icon is decorative", () => {
    const { container } = render(<IconButton icon="heart" label="Add to wishlist" />);
    const button = screen.getByRole("button", { name: "Add to wishlist" });
    expect(button).toHaveAttribute("aria-label", "Add to wishlist");
    expect(button).toHaveAttribute("type", "button");
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("data-icon", "heart");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  test("defaults: ghost variant, md icon, 44px square hit area", () => {
    const { container } = render(<IconButton icon="close" label="Close" />);
    const button = screen.getByRole("button");
    expect(button).toHaveClass("bg-transparent", "text-accent", "min-h-touch", "min-w-touch", "size-touch");
    expect(container.querySelector("svg")).toHaveClass("size-5");
  });

  test("variants reuse Button's role tokens", () => {
    const { rerender } = render(<IconButton icon="cart" label="Cart" variant="outline" />);
    expect(screen.getByRole("button")).toHaveClass("border-border-strong", "bg-surface-raised");
    rerender(<IconButton icon="cart" label="Cart" variant="solid" />);
    expect(screen.getByRole("button")).toHaveClass("bg-accent", "text-text-on-accent");
  });

  test("sizes: sm/md 44px box, lg 48px box; icon 16/20/24px", () => {
    const cases = [
      ["sm", "size-touch", "size-4"],
      ["md", "size-touch", "size-5"],
      ["lg", "size-12", "size-6"],
    ] as const;
    for (const [size, box, icon] of cases) {
      const { container, unmount } = render(<IconButton icon="plus" label="Add" size={size} />);
      expect(screen.getByRole("button")).toHaveClass(box, "min-h-touch", "min-w-touch");
      expect(container.querySelector("svg")).toHaveClass(icon);
      unmount();
    }
  });

  test("pressed renders aria-pressed; undefined omits it", () => {
    const { rerender } = render(<IconButton icon="heart" label="Favourite" />);
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-pressed");
    rerender(<IconButton icon="heart-filled" label="Favourite" pressed />);
    expect(screen.getByRole("button", { pressed: true })).toHaveClass("aria-pressed:bg-accent-subtle");
    rerender(<IconButton icon="heart" label="Favourite" pressed={false} />);
    expect(screen.getByRole("button", { pressed: false })).toBeInTheDocument();
  });

  test("click calls onClick; keyboard: native focusable button", () => {
    const onClick = mock();
    render(<IconButton icon="trash" label="Remove item" onClick={onClick} />);
    const button = screen.getByRole("button", { name: "Remove item" });
    button.focus();
    expect(button).toHaveFocus();
    expect(button.tagName).toBe("BUTTON");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("loading: spinner replaces icon, aria-busy, clicks swallowed, name kept", () => {
    const onClick = mock();
    const { container } = render(
      <IconButton icon="heart" label="Add to wishlist" loading onClick={onClick} />,
    );
    const button = screen.getByRole("button", { name: "Add to wishlist" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector('[data-icon="heart"]')).toBeNull();
    expect(screen.getByTestId("spinner-icon")).toBeInTheDocument();
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("padding passes through to Button: default keeps px-3, none removes it and keeps the box", () => {
    render(
      <>
        <IconButton icon="plus" label="Padded" />
        <IconButton icon="plus" label="Unpadded" padding="none" />
      </>,
    );
    expect(screen.getByRole("button", { name: "Padded" })).toHaveClass("px-3", "py-1");
    const unpadded = screen.getByRole("button", { name: "Unpadded" });
    expect(unpadded).toHaveClass("p-0", "size-touch");
    expect(unpadded).not.toHaveClass("px-3");
  });

  test("disabled is native", () => {
    render(<IconButton icon="plus" label="Add" disabled />);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  test("no outline overrides; className merged last; ref forwarded", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<IconButton icon="plus" label="Add" className="ml-2" ref={ref} />);
    const button = screen.getByRole("button");
    expect(button.className).not.toMatch(/outline-none/);
    expect(button.className.split(" ").at(-1)).toBe("ml-2");
    expect(ref.current).toBe(button as HTMLButtonElement);
  });
});
