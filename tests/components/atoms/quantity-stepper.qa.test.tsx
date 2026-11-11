// QA (T04.3-T04.5): QuantityStepper adversarial checks.
import { describe, expect, mock, test } from "bun:test";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { QuantityStepper, parseQuantity } from "@/components/atoms/QuantityStepper";
import { expectFocused } from "@/test/dom-assertions";

type Spy = ReturnType<typeof mock<(n: number) => void>>;

function Harness({
  initial,
  min,
  max,
  onChange,
  disabled,
}: {
  initial: number;
  min?: number;
  max: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  const [v, setV] = useState(initial);
  return (
    <QuantityStepper
      id="qty"
      value={v}
      min={min}
      max={max}
      disabled={disabled}
      onChange={(n) => {
        onChange(n);
        setV(n);
      }}
    />
  );
}

const input = () => screen.getByRole("textbox", { name: "Quantity" }) as HTMLInputElement;
const dec = () => screen.getByRole("button", { name: "Decrease quantity" });
const inc = () => screen.getByRole("button", { name: "Increase quantity" });

function assertAllEmitsValid(spy: Spy, min: number, max: number) {
  for (const [n] of spy.mock.calls) {
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(min);
    expect(n).toBeLessThanOrEqual(max);
  }
}

function typeAndBlur(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  fireEvent.blur(input());
}

describe("hostile typed input (min 1, max 10, value 5), committed on blur", () => {
  const cases: Array<[string, number | null]> = [
    ["abc", null],
    ["", null],
    ["-3", null],
    ["2.5", null],
    [" 7 ", 7],
    ["007", 7],
    ["1e2", null],
    ["+3", null],
    ["12345678901234567890", 10],
    ["0", 1],
    ["999", 10],
    ["5", null], // same as current: no emit
    ["\t3\n", 3],
    ["٣", null], // Arabic-Indic digit three: \d in JS is ASCII-only
    ["0x5", null],
    ["Infinity", null],
  ];
  test.each(cases)("%p => %p", (text, expected) => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={5} max={10} onChange={spy} />);
    typeAndBlur(text);
    assertAllEmitsValid(spy, 1, 10);
    if (expected === null) {
      expect(spy).not.toHaveBeenCalled();
      expect(input().value).toBe("5");
    } else {
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expected);
      expect(input().value).toBe(String(expected));
    }
  });

  test.each(cases)("Enter commits %p the same way as blur", (text, expected) => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={5} max={10} onChange={spy} />);
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.keyDown(input(), { key: "Enter" });
    assertAllEmitsValid(spy, 1, 10);
    expect(spy.mock.calls.length).toBe(expected === null ? 0 : 1);
  });

  test("parseQuantity exported helper agrees", () => {
    expect(parseQuantity("abc", 1, 10)).toBeNull();
    expect(parseQuantity(" 7 ", 1, 10)).toBe(7);
    expect(parseQuantity("12345678901234567890", 1, 10)).toBe(10);
  });
});

describe("buttons and clamping", () => {
  test("decrement disabled at min, increment disabled at max", () => {
    const spy: Spy = mock(() => {});
    const { unmount } = render(<Harness initial={1} max={3} onChange={spy} />);
    expect(dec()).toBeDisabled();
    expect(inc()).toBeEnabled();
    unmount();
    render(<Harness initial={3} max={3} onChange={spy} />);
    expect(inc()).toBeDisabled();
    expect(dec()).toBeEnabled();
  });

  test("onChange call count: 3 clicks from 1 with max 3 => 2 calls (1->2, 2->3)", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={1} max={3} onChange={spy} />);
    fireEvent.click(inc());
    fireEvent.click(inc());
    fireEvent.click(inc()); // disabled now
    expect(spy.mock.calls).toEqual([[2], [3]]);
    expect(inc()).toBeDisabled();
    expect(input().value).toBe("3");
  });

  test("min === max: both buttons disabled, typing never emits", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={2} min={2} max={2} onChange={spy} />);
    expect(dec()).toBeDisabled();
    expect(inc()).toBeDisabled();
    typeAndBlur("9");
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "End" });
    expect(spy).not.toHaveBeenCalled();
    expect(input().value).toBe("2");
  });

  test("max < min renders fully disabled and never emits", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={1} min={1} max={0} onChange={spy} />);
    expect(dec()).toBeDisabled();
    expect(inc()).toBeDisabled();
    expect(input()).toBeDisabled();
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "Home" });
    typeAndBlur("1");
    expect(spy).not.toHaveBeenCalled();
  });

  test("disabled: all controls disabled and keys never emit", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={2} max={5} disabled onChange={spy} />);
    expect(dec()).toBeDisabled();
    expect(inc()).toBeDisabled();
    expect(input()).toBeDisabled();
    for (const key of ["ArrowUp", "ArrowDown", "Home", "End"]) fireEvent.keyDown(input(), { key });
    expect(spy).not.toHaveBeenCalled();
  });

  test("value prop above max: increment disabled; decrement clamps into range", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={10} max={5} onChange={spy} />);
    expect(inc()).toBeDisabled();
    fireEvent.click(dec());
    expect(spy).toHaveBeenCalledWith(5);
    assertAllEmitsValid(spy, 1, 5);
  });
});

describe("caller-supplied non-integer bounds (outside the criterion; questionable)", () => {
  test("fractional min=1.5: Home emits 1.5 (stepper trusts integer bounds)", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} min={1.5} max={5} onChange={spy} />);
    fireEvent.keyDown(input(), { key: "Home" });
    // Documents current behaviour: a non-integer bound leaks through clamp().
    expect(spy.mock.calls).toEqual([[1.5]]);
  });
});

describe("keyboard (T04.4)", () => {
  test("ArrowUp at max and ArrowDown at min do not emit; key default is still prevented", () => {
    const spy: Spy = mock(() => {});
    const { unmount } = render(<Harness initial={5} max={5} onChange={spy} />);
    expect(fireEvent.keyDown(input(), { key: "ArrowUp" })).toBe(false);
    unmount();
    render(<Harness initial={1} max={5} onChange={spy} />);
    expect(fireEvent.keyDown(input(), { key: "ArrowDown" })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  test("ArrowUp/ArrowDown step by 1", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} max={5} onChange={spy} />);
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(spy.mock.calls).toEqual([[4], [5], [4]]);
  });

  test("ArrowUp with an invalid draft steps from the committed value", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} max={5} onChange={spy} />);
    fireEvent.change(input(), { target: { value: "abc" } });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(spy.mock.calls).toEqual([[4]]);
    expect(input().value).toBe("4");
  });

  test("ArrowUp with a valid draft steps from the draft, clamped", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} max={5} onChange={spy} />);
    fireEvent.change(input(), { target: { value: "999" } });
    fireEvent.keyDown(input(), { key: "ArrowUp" });
    expect(spy.mock.calls).toEqual([[5]]);
  });

  test("Home => min, End => max; Home at min is a no-op", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} min={2} max={9} onChange={spy} />);
    fireEvent.keyDown(input(), { key: "End" });
    fireEvent.keyDown(input(), { key: "Home" });
    fireEvent.keyDown(input(), { key: "Home" });
    expect(spy.mock.calls).toEqual([[9], [2]]);
  });

  test("Escape reverts the draft; subsequent blur emits nothing", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} max={9} onChange={spy} />);
    fireEvent.change(input(), { target: { value: "8" } });
    expect(input().value).toBe("8");
    expect(fireEvent.keyDown(input(), { key: "Escape" })).toBe(false);
    expect(input().value).toBe("3");
    fireEvent.blur(input());
    expect(spy).not.toHaveBeenCalled();
  });

  test("Escape without a draft is not swallowed (lets a dialog close)", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} max={9} onChange={spy} />);
    expect(fireEvent.keyDown(input(), { key: "Escape" })).toBe(true);
  });

  test("Enter inside a surrounding form is prevented and does not submit", () => {
    const spy: Spy = mock(() => {});
    const onSubmit = mock((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness initial={3} max={9} onChange={spy} />
        <button type="submit">Add</button>
      </form>,
    );
    fireEvent.change(input(), { target: { value: "abc" } });
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(input().value).toBe("3");
  });

  test("unrelated keys (Tab, letters) are not prevented", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={3} max={9} onChange={spy} />);
    expect(fireEvent.keyDown(input(), { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(input(), { key: "a" })).toBe(true);
  });
});

describe("accessibility and touch targets (T04.4, T04.5)", () => {
  test("buttons are native type=button with exact names and size-touch", () => {
    render(<Harness initial={2} max={5} onChange={() => {}} />);
    for (const b of [dec(), inc()]) {
      expect(b.tagName).toBe("BUTTON");
      expect(b).toHaveAttribute("type", "button");
      expect(b).toHaveAttribute("aria-controls", "qty");
      expect(b).toHaveClass("size-touch");
    }
    expect(input()).toHaveClass("min-h-touch");
  });

  test("input labelled; group labelled; live region announces value", () => {
    render(<Harness initial={2} max={5} onChange={() => {}} />);
    expect(input()).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByRole("group", { name: "Quantity" })).toBeInTheDocument();
    fireEvent.click(inc());
    const live = document.querySelector("[aria-live='polite']");
    expect(live).toHaveTextContent("Quantity: 3");
  });

  test("custom label + showLabel=false keeps it accessible but visually hidden", () => {
    render(<QuantityStepper id="q2" label="Qty for Tote" showLabel={false} value={1} max={3} onChange={() => {}} />);
    const box = screen.getByRole("textbox", { name: "Qty for Tote" });
    expect(box).toBeInTheDocument();
    expect(screen.getByText("Qty for Tote")).toHaveClass("sr-only");
  });

  test("buttons stay focusable when enabled; clicking via keyboard-equivalent click works", () => {
    const spy: Spy = mock(() => {});
    render(<Harness initial={2} max={5} onChange={spy} />);
    inc().focus();
    expectFocused(inc());
    fireEvent.click(inc());
    expect(spy).toHaveBeenCalledWith(3);
  });
});
