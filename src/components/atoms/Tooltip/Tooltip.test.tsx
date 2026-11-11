import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { act, createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tooltip } from "./Tooltip";
import type { TooltipProps } from "./Tooltip";

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

const advance = (ms: number) =>
  act(() => {
    jest.advanceTimersByTime(ms);
  });

function Example(props: Partial<TooltipProps>) {
  return (
    <Tooltip content="Ships in 2 days" {...props}>
      <button type="button">Delivery info</button>
    </Tooltip>
  );
}

describe("Tooltip", () => {
  test("trigger is described by a hidden role=tooltip element", () => {
    render(<Example />);
    const trigger = screen.getByRole("button", { name: "Delivery info" });
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(trigger).toHaveAttribute("aria-describedby", tip.id);
    expect(tip).toHaveAttribute("hidden");
    expect(trigger).toHaveAccessibleDescription("Ships in 2 days");
  });

  test("focus shows immediately; blur hides", () => {
    render(<Example />);
    const trigger = screen.getByRole("button");
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.blur(trigger);
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveAttribute("hidden");
  });

  test("hover shows after the delay and hides after leaving", () => {
    const { container } = render(<Example delayMs={300} />);
    const wrapper = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    advance(299);
    expect(screen.queryByRole("tooltip")).toBeNull();
    advance(1);
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.mouseLeave(wrapper);
    advance(150);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("leaving before the delay never shows it", () => {
    const { container } = render(<Example />);
    const wrapper = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    advance(100);
    fireEvent.mouseLeave(wrapper);
    advance(1000);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("re-entering within the hide delay keeps it open (hoverable)", () => {
    const { container } = render(<Example delayMs={0} />);
    const wrapper = container.firstElementChild as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    advance(0);
    fireEvent.mouseLeave(wrapper);
    advance(50);
    fireEvent.mouseEnter(wrapper);
    advance(500);
    expect(screen.getByRole("tooltip")).toBeVisible();
  });

  test("Escape dismisses while focused, and focus again re-opens", () => {
    render(<Example />);
    const trigger = screen.getByRole("button");
    fireEvent.focus(trigger);
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.blur(trigger);
    fireEvent.focus(trigger);
    expect(screen.getByRole("tooltip")).toBeVisible();
  });

  test("Escape on the document dismisses a hover-opened tooltip", () => {
    const { container } = render(<Example delayMs={0} />);
    fireEvent.mouseEnter(container.firstElementChild as HTMLElement);
    advance(0);
    expect(screen.getByRole("tooltip")).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("merges an existing aria-describedby on the trigger", () => {
    render(
      <>
        <p id="hint">Hint</p>
        <Tooltip content="Tip">
          <button type="button" aria-describedby="hint">
            T
          </button>
        </Tooltip>
      </>,
    );
    const ids = screen.getByRole("button").getAttribute("aria-describedby")?.split(" ");
    expect(ids?.[0]).toBe("hint");
    expect(ids).toHaveLength(2);
  });

  test("render-prop trigger receives aria-describedby", () => {
    render(
      <Tooltip content="Tip">
        {(props) => (
          <a href="/help" {...props}>
            Help
          </a>
        )}
      </Tooltip>,
    );
    expect(screen.getByRole("link", { name: "Help" })).toHaveAccessibleDescription("Tip");
  });

  test.each([
    ["top", "bottom-full"],
    ["bottom", "top-full"],
    ["left", "right-full"],
    ["right", "left-full"],
  ] as const)("side %s positions with %s", (side, cls) => {
    render(<Example side={side} />);
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveClass(cls, "z-dropdown");
  });

  test("uses the verified inverse pair", () => {
    render(<Example />);
    expect(screen.getByRole("tooltip", { hidden: true })).toHaveClass(
      "bg-surface-inverse",
      "text-text-inverse",
    );
  });

  test("forwards ref and merges className last", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(<Example ref={ref} className="ms-2" tooltipClassName="x-tip" />);
    expect(ref.current).toBe(container.firstElementChild as HTMLSpanElement);
    expect(ref.current?.className.endsWith("ms-2")).toBe(true);
    expect(screen.getByRole("tooltip", { hidden: true }).className.endsWith("x-tip")).toBe(true);
  });
});
