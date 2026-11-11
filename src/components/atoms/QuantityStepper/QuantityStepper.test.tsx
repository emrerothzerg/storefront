import { describe, expect, test } from "bun:test";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuantityStepper, parseQuantity } from "./QuantityStepper";
import type { QuantityStepperProps } from "./QuantityStepper";

type HarnessProps = Omit<QuantityStepperProps, "value" | "onChange" | "id"> & {
  initial: number;
  calls: number[];
};

function Harness({ initial, calls, ...rest }: HarnessProps) {
  const [value, setValue] = useState(initial);
  return (
    <QuantityStepper
      id="qty"
      {...rest}
      value={value}
      onChange={(next) => {
        calls.push(next);
        setValue(next);
      }}
    />
  );
}

function setup(props: Partial<HarnessProps> = {}) {
  const calls: number[] = [];
  render(<Harness initial={1} max={5} {...props} calls={calls} />);
  return {
    calls,
    input: screen.getByRole("textbox", { name: props.label ?? "Quantity" }) as HTMLInputElement,
    dec: screen.getByRole("button", { name: "Decrease quantity" }),
    inc: screen.getByRole("button", { name: "Increase quantity" }),
  };
}

function typeAndCommit(input: HTMLInputElement, text: string, via: "blur" | "enter") {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: text } });
  if (via === "enter") fireEvent.keyDown(input, { key: "Enter" });
  else fireEvent.blur(input);
}

function expectAllValid(calls: number[], min: number, max: number) {
  for (const c of calls) {
    expect(Number.isInteger(c)).toBe(true);
    expect(c).toBeGreaterThanOrEqual(min);
    expect(c).toBeLessThanOrEqual(max);
  }
}

describe("QuantityStepper", () => {
  test("accessible names, label and input attributes", () => {
    const { input, dec, inc } = setup({ name: "quantity" });
    expect(input).toHaveAttribute("id", "qty");
    expect(input).toHaveAttribute("name", "quantity");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("pattern", "[0-9]*");
    expect(input).toHaveAttribute("type", "text");
    expect(input.value).toBe("1");
    expect(dec).toHaveAttribute("type", "button");
    expect(inc).toHaveAttribute("type", "button");
    expect(screen.getByRole("group", { name: "Quantity" })).toBeInTheDocument();
  });

  test("custom label; showLabel=false keeps it accessible but visually hidden", () => {
    setup({ label: "Qty for Blue Mug", showLabel: false });
    const input = screen.getByRole("textbox", { name: "Qty for Blue Mug" });
    expect(input).toBeInTheDocument();
    expect(screen.getByText("Qty for Blue Mug", { selector: "label" })).toHaveClass("sr-only");
  });

  test("touch targets: both buttons are size-touch", () => {
    const { dec, inc, input } = setup();
    expect(dec).toHaveClass("size-touch");
    expect(inc).toHaveClass("size-touch");
    expect(input).toHaveClass("min-h-touch");
  });

  test("decrement disabled at min, increment disabled at max, clicks clamp", () => {
    const { dec, inc, input, calls } = setup({ initial: 1, min: 1, max: 3 });
    expect(dec).toBeDisabled();
    expect(inc).toBeEnabled();
    fireEvent.click(inc);
    fireEvent.click(inc);
    expect(input.value).toBe("3");
    expect(inc).toBeDisabled();
    expect(dec).toBeEnabled();
    fireEvent.click(inc);
    expect(calls).toEqual([2, 3]);
    fireEvent.click(dec);
    expect(calls).toEqual([2, 3, 2]);
  });

  test("ArrowUp / ArrowDown step by 1 within bounds", () => {
    const { input, calls } = setup({ initial: 4, min: 1, max: 5 });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("5");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("5");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("3");
    expect(calls).toEqual([5, 4, 3]);
  });

  test("ArrowDown at min does not emit", () => {
    const { input, calls } = setup({ initial: 1 });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(calls).toEqual([]);
    expect(input.value).toBe("1");
  });

  test("Home / End jump to min / max", () => {
    const { input, calls } = setup({ initial: 3, max: 5 });
    fireEvent.keyDown(input, { key: "End" });
    fireEvent.keyDown(input, { key: "Home" });
    expect(calls).toEqual([5, 1]);
  });

  test("Enter commits a typed value and prevents form submission", () => {
    const { input, calls } = setup({ initial: 1, max: 10 });
    fireEvent.change(input, { target: { value: "4" } });
    expect(calls).toEqual([]); // buffered until commit
    const notCancelled = fireEvent.keyDown(input, { key: "Enter" });
    expect(notCancelled).toBe(false);
    expect(calls).toEqual([4]);
    expect(input.value).toBe("4");
  });

  test("blur commits a typed value", () => {
    const { input, calls } = setup({ initial: 1, max: 10 });
    typeAndCommit(input, "6", "blur");
    expect(calls).toEqual([6]);
  });

  test("ArrowUp steps from a valid typed draft", () => {
    const { input, calls } = setup({ initial: 1, max: 10 });
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(calls).toEqual([5]);
  });

  // Revert rule: anything that is not digits-only after trimming reverts to the
  // previous valid value and does not call onChange.
  for (const raw of ["abc", "", "-3", "2.5", "+3", "1e2", "   "]) {
    for (const via of ["blur", "enter"] as const) {
      test(`"${raw}" via ${via} reverts without emitting`, () => {
        const { input, calls } = setup({ initial: 2, min: 1, max: 5 });
        typeAndCommit(input, raw, via);
        expect(calls).toEqual([]);
        expect(input.value).toBe("2");
      });
    }
  }

  // Clamp rule: digits-only input is trimmed, parsed and clamped into range.
  const clampCases: ReadonlyArray<[string, number]> = [
    [" 7 ", 7],
    ["007", 7],
    ["0", 1],
    ["999", 10],
    ["99999999999999999999", 10],
  ];
  for (const [raw, expected] of clampCases) {
    test(`"${raw}" commits as ${expected}`, () => {
      const { input, calls } = setup({ initial: 2, min: 1, max: 10 });
      typeAndCommit(input, raw, "blur");
      expect(calls).toEqual([expected]);
      expect(input.value).toBe(String(expected));
      expectAllValid(calls, 1, 10);
    });
  }

  test("committing the same value does not emit", () => {
    const { input, calls } = setup({ initial: 3, max: 10 });
    typeAndCommit(input, "3", "enter");
    typeAndCommit(input, " 03 ", "blur");
    expect(calls).toEqual([]);
  });

  test("Escape discards the draft", () => {
    const { input, calls } = setup({ initial: 3, max: 10 });
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("3");
    fireEvent.blur(input);
    expect(calls).toEqual([]);
  });

  test("never emits a non-integer or out-of-range value across mixed input", () => {
    const { input, inc, dec, calls } = setup({ initial: 2, min: 2, max: 4 });
    for (const raw of ["abc", "", "-3", "2.5", " 7 ", "1", "100"]) {
      typeAndCommit(input, raw, "enter");
      fireEvent.click(inc);
      fireEvent.click(dec);
      fireEvent.keyDown(input, { key: "ArrowUp" });
      fireEvent.keyDown(input, { key: "ArrowDown" });
    }
    expect(calls.length).toBeGreaterThan(0);
    expectAllValid(calls, 2, 4);
  });

  test("disabled disables all controls", () => {
    const { input, dec, inc } = setup({ initial: 2, disabled: true });
    expect(input).toBeDisabled();
    expect(dec).toBeDisabled();
    expect(inc).toBeDisabled();
  });

  test("max below min (out of stock) renders disabled", () => {
    const { input, dec, inc } = setup({ initial: 1, min: 1, max: 0 });
    expect(input).toBeDisabled();
    expect(dec).toBeDisabled();
    expect(inc).toBeDisabled();
  });

  test("live region announces the current value", () => {
    const { inc } = setup({ initial: 1 });
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent("Quantity: 1");
    fireEvent.click(inc);
    expect(live).toHaveTextContent("Quantity: 2");
  });

  test("className merged on the root", () => {
    const { container } = render(
      <QuantityStepper id="q2" value={1} onChange={() => {}} max={3} className="mt-4" />,
    );
    expect((container.firstElementChild as HTMLElement).className.endsWith("mt-4")).toBe(true);
  });
});

describe("parseQuantity", () => {
  test("revert cases return null", () => {
    for (const raw of ["abc", "", "-3", "2.5", "+3", "1e2", " "]) {
      expect(parseQuantity(raw, 1, 5)).toBeNull();
    }
  });
  test("digit cases trim and clamp", () => {
    expect(parseQuantity(" 7 ", 1, 10)).toBe(7);
    expect(parseQuantity("0", 1, 10)).toBe(1);
    expect(parseQuantity("50", 1, 10)).toBe(10);
  });
});
