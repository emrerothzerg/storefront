import { describe, expect, test } from "bun:test";
import { createRef } from "react";
import { render, screen, within } from "@testing-library/react";
import { Steps, STEP_STATUS_TEXT } from "./Steps";
import type { StepItem } from "./Steps";

const steps: StepItem[] = [
  { id: "placed", label: "Ordered", status: "complete", timestamp: "Nov 3, 9:12 AM" },
  { id: "shipped", label: "Shipped", status: "current", description: "In transit" },
  { id: "out", label: "Out for delivery", status: "upcoming" },
  { id: "delivered", label: "Delivered", status: "upcoming" },
];

describe("Steps", () => {
  test("renders an ordered list with one item per step", () => {
    render(<Steps steps={steps} aria-label="Order progress" />);
    const list = screen.getByRole("list", { name: "Order progress" });
    expect(list.tagName).toBe("OL");
    // Explicit role: list-none removes list semantics in Safari/VoiceOver.
    expect(list).toHaveAttribute("role", "list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
  });

  test("0 steps renders nothing", () => {
    const { container } = render(<Steps steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("status is conveyed as text before each label", () => {
    render(<Steps steps={steps} />);
    const items = screen.getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Completed: Ordered");
    expect(items[1]).toHaveTextContent("Current step: Shipped");
    expect(items[2]).toHaveTextContent("Upcoming: Out for delivery");
    expect(screen.getByText("Completed:", { exact: false })).toHaveClass("sr-only");
  });

  test("cancelled status text, error icon and danger colour", () => {
    render(
      <Steps
        steps={[
          { id: "a", label: "Ordered", status: "complete" },
          { id: "b", label: "Order cancelled", status: "cancelled" },
        ]}
      />,
    );
    const item = screen.getAllByRole("listitem")[1]!;
    expect(item).toHaveTextContent("Cancelled: Order cancelled");
    expect(item.querySelector("svg")).toHaveClass("text-danger");
    expect(STEP_STATUS_TEXT.cancelled).toBe("Cancelled");
  });

  test("aria-current=step only on the current step", () => {
    render(<Steps steps={steps} />);
    const items = screen.getAllByRole("listitem");
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items.filter((li) => li.hasAttribute("aria-current"))).toHaveLength(1);
    expect(within(items[1]!).getByText("Shipped").closest("span")).toHaveClass("font-semibold");
  });

  test("each status has a distinct, decorative indicator (not colour alone)", () => {
    render(<Steps steps={steps} />);
    const items = screen.getAllByRole("listitem");
    const completeIcon = items[0]!.querySelector("svg");
    expect(completeIcon).toHaveAttribute("aria-hidden", "true");
    expect(completeIcon).toHaveClass("text-accent");
    const currentIcon = items[1]!.querySelector('[data-indicator="current"]');
    expect(currentIcon?.tagName.toLowerCase()).toBe("svg");
    expect(currentIcon).toHaveAttribute("data-icon", "circle-dot");
    expect(currentIcon).toHaveAttribute("aria-hidden", "true");
    expect(currentIcon).toHaveClass("text-accent");
    const upcomingIcon = items[2]!.querySelector('[data-indicator="upcoming"]');
    expect(upcomingIcon).toHaveAttribute("data-icon", "circle");
    expect(upcomingIcon).toHaveAttribute("aria-hidden", "true");
    expect(upcomingIcon).toHaveClass("text-border-strong");
    expect(completeIcon).toHaveAttribute("data-icon", "check-circle");
  });

  test("description and timestamp are rendered", () => {
    render(<Steps steps={steps} />);
    expect(screen.getByText("In transit")).toHaveClass("text-text-secondary");
    expect(screen.getByText("Nov 3, 9:12 AM")).toHaveClass("text-text-secondary");
  });

  test("connectors between steps: accent after completed, default otherwise, none after last", () => {
    render(<Steps steps={steps} />);
    const connectors = screen.getAllByTestId("step-connector");
    expect(connectors).toHaveLength(3);
    expect(connectors[0]).toHaveClass("bg-accent");
    expect(connectors[1]).toHaveClass("bg-border-default");
    expect(connectors[2]).toHaveClass("bg-border-default");
    connectors.forEach((c) => expect(c).toHaveAttribute("aria-hidden", "true"));
  });

  test("vertical by default; horizontal only switches to a row from md", () => {
    const { rerender } = render(<Steps steps={steps} />);
    const list = screen.getByRole("list");
    expect(list).toHaveAttribute("data-orientation", "vertical");
    expect(list).toHaveClass("flex-col");
    expect(list).not.toHaveClass("md:flex-row");
    rerender(<Steps steps={steps} orientation="horizontal" />);
    expect(list).toHaveAttribute("data-orientation", "horizontal");
    expect(list).toHaveClass("flex-col", "md:flex-row");
    expect(screen.getAllByRole("listitem")[0]).toHaveClass("md:flex-1");
  });

  test.each([
    ["sm", "text-small", "size-4"],
    ["md", "text-body", "size-5"],
  ] as const)("size %s", (size, text, box) => {
    render(<Steps steps={steps} size={size} />);
    expect(screen.getByText("Shipped").closest("span")).toHaveClass(text);
    expect(document.querySelector('[data-indicator="current"]')).toHaveClass(box);
  });

  test("forwards ref and merges className last", () => {
    const ref = createRef<HTMLOListElement>();
    render(<Steps ref={ref} steps={steps} className="x-steps" />);
    expect(ref.current?.tagName).toBe("OL");
    expect(ref.current?.className.endsWith("x-steps")).toBe(true);
  });
});
