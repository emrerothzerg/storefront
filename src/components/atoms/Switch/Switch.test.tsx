import { describe, expect, mock, test } from "bun:test";
import { createRef, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Switch } from "./Switch";

describe("Switch", () => {
  test("role=switch button named by its visible label, off by default", () => {
    render(<Switch label="Email me deals" />);
    const sw = screen.getByRole("switch", { name: "Email me deals" });
    expect(sw.tagName).toBe("BUTTON");
    expect(sw).toHaveAttribute("type", "button");
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveClass("min-h-touch", "min-w-touch");
    expect(sw.className).not.toMatch(/outline-none/);
  });

  test("uncontrolled: click toggles and calls onCheckedChange", () => {
    const onCheckedChange = mock();
    render(<Switch label="Dark" onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole("switch");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(onCheckedChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  test("controlled", () => {
    function C() {
      const [on, setOn] = useState(true);
      return <Switch label="C" checked={on} onCheckedChange={setOn} />;
    }
    render(<C />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  test("controlled without handler stays put", () => {
    render(<Switch label="Fixed" checked />);
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  });

  test("keyboard: native button, focusable; Enter/Space activate via click", () => {
    render(<Switch label="K" />);
    const sw = screen.getByRole("switch");
    sw.focus();
    expect(sw).toHaveFocus();
    // Browsers turn Enter/Space on a <button> into click; happy-dom does not.
    fireEvent.keyDown(sw, { key: "Enter" });
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.keyUp(sw, { key: " " });
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  test("hideLabel -> aria-label, no visible text", () => {
    render(<Switch label="Notifications" hideLabel />);
    const sw = screen.getByRole("switch", { name: "Notifications" });
    expect(sw).toHaveAttribute("aria-label", "Notifications");
    expect(sw).not.toHaveTextContent("Notifications");
  });

  test("description linked", () => {
    render(<Switch label="Save card" description="Stored on this device" />);
    expect(screen.getByRole("switch")).toHaveAccessibleDescription("Stored on this device");
  });

  test("disabled: native, not toggled", () => {
    const onCheckedChange = mock();
    render(<Switch label="D" disabled onCheckedChange={onCheckedChange} />);
    const sw = screen.getByRole("switch");
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  test("track/thumb tokens and sizes", () => {
    const { container, rerender } = render(<Switch label="S" />);
    const track = container.querySelector('button > span[aria-hidden="true"]');
    expect(track).toHaveClass("bg-border-strong", "group-aria-checked/switch:bg-accent", "w-11");
    expect(track?.firstElementChild).toHaveClass("bg-surface-raised", "group-aria-checked/switch:translate-x-5.5");
    rerender(<Switch label="S" size="lg" />);
    expect(container.querySelector('button > span[aria-hidden="true"]')).toHaveClass("w-13");
  });

  test("posts in a form via a hidden input only while on", () => {
    render(
      <form data-testid="f">
        <Switch label="Gift" name="gift" defaultChecked />
        <Switch label="Fast" name="fast" value="yes" />
      </form>,
    );
    const form = screen.getByTestId("f") as HTMLFormElement;
    let data = new FormData(form);
    expect(data.get("gift")).toBe("on");
    expect(data.get("fast")).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Fast" }));
    fireEvent.click(screen.getByRole("switch", { name: "Gift" }));
    data = new FormData(form);
    expect(data.get("fast")).toBe("yes");
    expect(data.get("gift")).toBeNull();
  });

  test("ref, className on wrapper, onClick preventDefault cancels toggle", () => {
    const ref = createRef<HTMLButtonElement>();
    const { container } = render(
      <Switch label="R" ref={ref} className="mt-2" onClick={(e) => e.preventDefault()} />,
    );
    expect(ref.current).toBe(screen.getByRole("switch") as HTMLButtonElement);
    expect((container.firstElementChild as HTMLElement).className.split(" ").at(-1)).toBe("mt-2");
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });
});
