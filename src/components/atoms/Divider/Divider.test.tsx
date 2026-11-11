import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { Divider } from "./Divider";

describe("Divider", () => {
  test("default: an <hr> (implicit separator) with the decorative border token", () => {
    const { container } = render(<Divider />);
    const hr = container.querySelector("hr");
    expect(hr).not.toBeNull();
    expect(screen.getByRole("separator")).toBe(hr as HTMLHRElement);
    expect(hr).toHaveClass("border-t", "border-border-default");
  });

  test("vertical: role=separator + aria-orientation=vertical", () => {
    render(<Divider orientation="vertical" />);
    const sep = screen.getByRole("separator");
    expect(sep.tagName).toBe("DIV");
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveClass("self-stretch", "bg-border-default");
  });

  test("label: centred text, separator named by it", () => {
    render(<Divider label="or" />);
    const sep = screen.getByRole("separator", { name: "or" });
    expect(sep).toHaveAttribute("aria-orientation", "horizontal");
    expect(sep).toHaveTextContent("or");
    expect(screen.getByText("or")).toHaveClass("text-small", "text-text-secondary");
  });

  test("blank label falls back to a plain <hr>; vertical ignores label", () => {
    const { container, rerender } = render(<Divider label="  " />);
    expect(container.querySelector("hr")).not.toBeNull();
    rerender(<Divider orientation="vertical" label="or" />);
    expect(screen.getByRole("separator")).not.toHaveTextContent("or");
  });

  test("className merged last and ref forwarded", () => {
    const ref = createRef<HTMLElement>();
    const { container } = render(<Divider className="my-4" ref={ref} />);
    const hr = container.querySelector("hr");
    expect(hr?.className.split(" ").at(-1)).toBe("my-4");
    expect(ref.current).toBe(hr);
  });
});
