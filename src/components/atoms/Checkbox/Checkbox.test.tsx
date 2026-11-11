import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Checkbox } from "./Checkbox";

describe("Checkbox", () => {
  test("native checkbox labelled by its visible label with token box", () => {
    render(<Checkbox label="In stock only" />);
    const box = screen.getByRole("checkbox", { name: "In stock only" });
    expect(box).toHaveAttribute("type", "checkbox");
    expect(box).toHaveClass("appearance-none", "border-border-strong", "bg-surface-raised", "checked:bg-accent", "size-5");
    expect(box.className).not.toMatch(/outline-none/);
  });

  test("clicking the label toggles; onChange fires", () => {
    const onChange = mock();
    render(<Checkbox label="Prime" onChange={onChange} />);
    fireEvent.click(screen.getByText("Prime"));
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  test("row keeps a 44px hit area; check icon is decorative and shown via peer-checked", () => {
    const { container } = render(<Checkbox label="A" />);
    expect(container.querySelector("label")).toHaveClass("min-h-touch");
    const check = container.querySelector('[data-icon="check"]');
    expect(check).toHaveAttribute("aria-hidden", "true");
    expect(check).toHaveClass("invisible", "peer-checked:visible", "text-text-on-accent");
  });

  test("description is linked via aria-describedby (merged with external ids)", () => {
    render(<Checkbox label="Gift wrap" description="Adds $3.99" aria-describedby="other" />);
    const box = screen.getByRole("checkbox");
    const ids = box.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(ids[0]).toBe("other");
    expect(document.getElementById(ids[1] ?? "")).toHaveTextContent("Adds $3.99");
  });

  test("indeterminate sets the DOM property and aria-checked=mixed", () => {
    const { rerender } = render(<Checkbox label="Select all" indeterminate />);
    const box = screen.getByRole("checkbox") as HTMLInputElement;
    expect(box.indeterminate).toBe(true);
    expect(box).toHaveAttribute("aria-checked", "mixed");
    rerender(<Checkbox label="Select all" />);
    expect(box.indeterminate).toBe(false);
    expect(box).not.toHaveAttribute("aria-checked");
  });

  test("invalid: aria-invalid + danger border (also from aria-invalid prop)", () => {
    const { rerender } = render(<Checkbox label="Accept terms" invalid />);
    let box = screen.getByRole("checkbox");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(box).toHaveClass("border-danger");
    rerender(<Checkbox label="Accept terms" aria-invalid="true" />);
    box = screen.getByRole("checkbox");
    expect(box).toHaveClass("border-danger");
  });

  test("disabled is native and not toggled by label clicks", () => {
    render(<Checkbox label="Off" disabled />);
    fireEvent.click(screen.getByText("Off"));
    expect(screen.getByRole("checkbox")).toBeDisabled();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  test("sizes", () => {
    for (const [size, cls] of [["sm", "size-4"], ["md", "size-5"], ["lg", "size-6"]] as const) {
      const { unmount } = render(<Checkbox label="S" size={size} />);
      expect(screen.getByRole("checkbox")).toHaveClass(cls);
      unmount();
    }
  });

  test("posts as a normal form field without JS", () => {
    render(
      <form data-testid="f">
        <Checkbox label="Newsletter" name="newsletter" defaultChecked />
        <Checkbox label="Brand A" name="brand" value="a" />
        <Checkbox label="Brand B" name="brand" value="b" defaultChecked />
      </form>,
    );
    const form = screen.getByTestId("f") as HTMLFormElement;
    let data = new FormData(form);
    expect(data.get("newsletter")).toBe("on");
    expect(data.getAll("brand")).toEqual(["b"]);
    fireEvent.click(screen.getByText("Brand A"));
    data = new FormData(form);
    expect(data.getAll("brand")).toEqual(["a", "b"]);
  });

  test("keyboard: focusable native input (Space toggling is native)", () => {
    render(<Checkbox label="K" />);
    const box = screen.getByRole("checkbox");
    box.focus();
    expect(box).toHaveFocus();
  });

  test("custom id, className on wrapper, ref forwarded (and still drives indeterminate)", () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<Checkbox id="c1" label="R" className="mt-2" ref={ref} indeterminate />);
    expect(ref.current).toBe(screen.getByRole("checkbox") as HTMLInputElement);
    expect(ref.current?.id).toBe("c1");
    expect(ref.current?.indeterminate).toBe(true);
    expect((container.firstElementChild as HTMLElement).className.split(" ").at(-1)).toBe("mt-2");
  });
});
