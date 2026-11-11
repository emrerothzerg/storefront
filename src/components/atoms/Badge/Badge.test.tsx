import { describe, expect, spyOn, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Badge, type BadgeTone } from "./Badge";

describe("Badge", () => {
  test.each<[BadgeTone, string, string]>([
    ["neutral", "bg-surface-sunken", "text-text-primary"],
    ["success", "bg-success-subtle", "text-success"],
    ["warning", "bg-warning-subtle", "text-warning"],
    ["danger", "bg-danger-subtle", "text-danger"],
    ["info", "bg-info-subtle", "text-info"],
  ])("%s tone renders its text with the matching tint pair", (tone, bg, fg) => {
    render(<Badge tone={tone}>{`${tone} label`}</Badge>);
    const el = screen.getByText(`${tone} label`);
    expect(el).toBeVisible();
    expect(el).toHaveClass(bg, fg, "rounded-sm", "text-caption");
  });

  test("icon is aria-hidden and the text remains the accessible content", () => {
    render(
      <Badge tone="success" icon={<svg data-testid="icon" />}>
        In stock
      </Badge>,
    );
    const badge = screen.getByText("In stock");
    expect(badge).toHaveTextContent("In stock");
    const iconWrapper = screen.getByTestId("icon").parentElement;
    expect(iconWrapper).toHaveAttribute("aria-hidden", "true");
  });

  test("renders no icon wrapper when no icon is given", () => {
    const { container } = render(<Badge tone="info">New</Badge>);
    expect(container.querySelector("[aria-hidden]")).toBeNull();
  });

  test("merges className last and forwards rest props", () => {
    render(
      <Badge tone="neutral" className="ml-1" data-testid="b" title="Status">
        Draft
      </Badge>,
    );
    const el = screen.getByTestId("b");
    expect(el).toHaveAttribute("title", "Status");
    expect(el.className.endsWith("ml-1")).toBe(true);
  });

  test.each(["", "   ", "\n\t"])("empty or whitespace-only text %j renders nothing and warns", (text) => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { container } = render(
        <Badge tone="danger" icon={<svg />}>
          {text}
        </Badge>,
      );
      expect(container).toBeEmptyDOMElement();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("[Badge] children must be non-empty");
    } finally {
      warn.mockRestore();
    }
  });

  test("empty text renders nothing without warning in production", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const env = process.env as Record<string, string | undefined>;
    const original = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const { container } = render(<Badge tone="info">{""}</Badge>);
      expect(container).toBeEmptyDOMElement();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      env.NODE_ENV = original;
      warn.mockRestore();
    }
  });

  test("valid text does not warn", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(<Badge tone="warning">Low stock</Badge>);
      expect(screen.getByText("Low stock")).toBeInTheDocument();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("children are required at the type level", () => {
    const compileOnly = () => (
      <>
        {/* @ts-expect-error children are required */}
        <Badge tone="danger" />
        {/* @ts-expect-error null children are not allowed */}
        <Badge tone="danger">{null}</Badge>
        {/* @ts-expect-error tone is required */}
        <Badge>x</Badge>
      </>
    );
    expect(typeof compileOnly).toBe("function");
  });
});
