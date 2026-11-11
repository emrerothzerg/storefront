// QA (T03.1-T03.3): Button and Spinner adversarial checks.
import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/atoms/Button";
import { Spinner, type SpinnerSize } from "@/components/atoms/Spinner";
import { expectFocused } from "@/test/dom-assertions";

describe("Button", () => {
  test("defaults to type=button, so a click inside a form does not submit", () => {
    const onSubmit = mock((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button>Plain</Button>
      </form>,
    );
    const btn = screen.getByRole("button", { name: "Plain" });
    expect(btn).toHaveAttribute("type", "button");
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("control: type=submit (not loading) DOES submit the form in happy-dom", () => {
    const onSubmit = mock((e: { preventDefault(): void }) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit">Pay</Button>
      </form>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  test("loading + type=submit inside a form: submit and onClick do not fire", () => {
    const onSubmit = mock((e: { preventDefault(): void }) => e.preventDefault());
    const onClick = mock(() => {});
    render(
      <form onSubmit={onSubmit}>
        <Button type="submit" loading onClick={onClick}>
          Pay
        </Button>
      </form>,
    );
    const btn = screen.getByRole("button", { name: /Pay/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onClick).not.toHaveBeenCalled();
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toHaveAttribute("aria-disabled", "true");
    // Stays focusable (not native-disabled) so focus is not lost mid-submit.
    expect(btn).not.toBeDisabled();
    expect(btn.querySelector("[role='status']")).not.toBeNull();
  });

  test("loading -> not loading re-enables clicks", () => {
    const onClick = mock(() => {});
    const { rerender } = render(
      <Button loading onClick={onClick}>
        Go
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    rerender(<Button onClick={onClick}>Go</Button>);
    const btn = screen.getByRole("button", { name: "Go" });
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(btn.querySelector("[role='status']")).toBeNull();
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("disabled sets native disabled and onClick never fires", () => {
    const onClick = mock(() => {});
    render(
      <Button disabled onClick={onClick}>
        Off
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "Off" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("keyboard operable: native focusable <button>, focus() works, click fires onClick", () => {
    const onClick = mock(() => {});
    render(<Button onClick={onClick}>Key</Button>);
    const btn = screen.getByRole("button", { name: "Key" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn).not.toHaveAttribute("tabindex");
    btn.focus();
    expectFocused(btn);
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("ref forwarding gives the DOM <button>", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>R</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
    expect(ref.current?.textContent).toBe("R");
  });

  test("className is appended last (after variant and size)", () => {
    render(
      <Button variant="secondary" size="lg" className="w-full mt-4">
        C
      </Button>,
    );
    const cls = screen.getByRole("button").className.split(" ");
    expect(cls.slice(-2)).toEqual(["w-full", "mt-4"]);
    expect(cls.indexOf("border-border-strong")).toBeLessThan(cls.indexOf("w-full"));
    expect(cls.indexOf("px-6")).toBeLessThan(cls.indexOf("w-full"));
  });

  const variants: ButtonVariant[] = ["primary", "secondary", "ghost", "danger"];
  const sizes: ButtonSize[] = ["sm", "md", "lg"];
  test.each(variants.flatMap((v) => sizes.map((s) => [v, s] as const)))(
    "%s/%s keeps the 44px minimum, never strips the outline",
    (variant, size) => {
      render(
        <Button variant={variant} size={size}>
          V
        </Button>,
      );
      const btn = screen.getByRole("button");
      expect(btn).toHaveClass("min-h-touch", "min-w-touch");
      expect(btn.className).not.toMatch(/outline-none|outline-0|ring-0/);
    },
  );

  test("type=reset is respected", () => {
    render(<Button type="reset">Reset</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "reset");
  });

  test("loading button's accessible name includes the spinner label (documents behaviour)", () => {
    render(<Button loading>Save</Button>);
    expect(screen.getByRole("button").textContent).toBe("LoadingSave");
  });
});

describe("Spinner", () => {
  const cases: Array<[SpinnerSize, string]> = [
    ["sm", "size-4"],
    ["md", "size-5"],
    ["lg", "size-8"],
  ];
  test.each(cases)("size %s uses %s, spins, and is static under reduced motion", (size, cls) => {
    render(<Spinner size={size} />);
    const icon = screen.getByTestId("spinner-icon");
    expect(icon).toHaveClass(cls, "animate-spin", "motion-reduce:animate-none");
    expect(icon).toHaveAttribute("aria-hidden", "true");
  });

  test("default label 'Loading' is visually hidden inside role=status", () => {
    render(<Spinner />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading");
    expect(screen.getByText("Loading")).toHaveClass("sr-only");
  });

  test("custom label replaces the default", () => {
    render(<Spinner label="Adding to cart" />);
    expect(screen.getByRole("status")).toHaveTextContent("Adding to cart");
    expect(screen.queryByText("Loading")).toBeNull();
  });

  test("role cannot be overridden (compile-only)", () => {
    const compileOnly = () => (
      // @ts-expect-error role is omitted from SpinnerProps
      <Spinner role="presentation" />
    );
    expect(typeof compileOnly).toBe("function");
  });
});
