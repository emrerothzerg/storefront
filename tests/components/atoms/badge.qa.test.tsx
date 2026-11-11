// QA (T02.5): Badge never conveys meaning by colour alone.
import { describe, expect, mock, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Badge, type BadgeTone } from "@/components/atoms/Badge";

const TONES: Array<[BadgeTone, string, string]> = [
  ["neutral", "bg-surface-sunken", "text-text-primary"],
  ["success", "bg-success-subtle", "text-success"],
  ["warning", "bg-warning-subtle", "text-warning"],
  ["danger", "bg-danger-subtle", "text-danger"],
  ["info", "bg-info-subtle", "text-info"],
];

describe("Badge", () => {
  test.each(TONES)("tone %s uses only documented tint pair %s/%s and shows its text", (tone, bg, fg) => {
    render(<Badge tone={tone}>Label {tone}</Badge>);
    const el = screen.getByText(`Label ${tone}`);
    expect(el).toHaveClass(bg, fg);
    expect(el).toHaveTextContent(`Label ${tone}`);
  });

  test.each(TONES)("tone %s with icon: icon is aria-hidden, text remains the accessible content", (tone) => {
    const { container } = render(
      <Badge tone={tone} icon={<svg data-testid="i" viewBox="0 0 1 1" />}>
        In stock
      </Badge>,
    );
    const wrapper = screen.getByTestId("i").parentElement;
    expect(wrapper).toHaveAttribute("aria-hidden", "true");
    expect(container.textContent).toBe("In stock");
  });

  test("icon={0} still renders (0 is not null)", () => {
    const { container } = render(
      <Badge tone="info" icon={0}>
        X
      </Badge>,
    );
    expect(container.querySelector("[aria-hidden='true']")).not.toBeNull();
  });

  test("children are required; null/undefined/false are compile errors", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error children required */}
        <Badge tone="danger" />
        {/* @ts-expect-error null not allowed */}
        <Badge tone="danger">{null}</Badge>
        {/* @ts-expect-error boolean not allowed */}
        <Badge tone="danger">{false}</Badge>
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });

  test.each([[""], ["   "], ["\n\t"]])(
    "empty/whitespace-only string child %p renders nothing and warns once",
    (child) => {
      const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
      try {
        const { container } = render(
          <Badge tone="danger" icon={<svg viewBox="0 0 1 1" />}>
            {child}
          </Badge>,
        );
        expect(container).toBeEmptyDOMElement();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]?.[0])).toContain("[Badge]");
      } finally {
        warn.mockRestore();
      }
    },
  );

  test("non-empty text with surrounding whitespace still renders, no warning", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    try {
      const { container } = render(<Badge tone="info">{"  New  "}</Badge>);
      expect(container.firstElementChild).toHaveClass("bg-info-subtle");
      expect(container.textContent?.trim()).toBe("New");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
