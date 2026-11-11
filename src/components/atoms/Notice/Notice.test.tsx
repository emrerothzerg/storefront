import { describe, expect, mock, test } from "bun:test";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Notice, type NoticeTone } from "./Notice";

describe("Notice", () => {
  test("info/success are polite status, warning/danger are alerts", () => {
    const expected: Record<NoticeTone, string> = {
      info: "status",
      success: "status",
      warning: "alert",
      danger: "alert",
    };
    for (const tone of Object.keys(expected) as NoticeTone[]) {
      const { unmount } = render(<Notice tone={tone}>Message</Notice>);
      expect(screen.getByRole(expected[tone])).toHaveTextContent("Message");
      unmount();
    }
  });

  test("each tone uses its tint, border and a distinct leading icon", () => {
    const icons: Record<NoticeTone, string> = {
      info: "info",
      success: "check-circle",
      warning: "warning",
      danger: "error-circle",
    };
    for (const tone of Object.keys(icons) as NoticeTone[]) {
      const { container, unmount } = render(<Notice tone={tone}>x</Notice>);
      const root = container.firstElementChild;
      expect(root).toHaveClass(`bg-${tone}-subtle`, `border-${tone}`, "text-text-primary");
      const icon = container.querySelector("svg");
      expect(icon).toHaveAttribute("data-icon", icons[tone]);
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveClass(`text-${tone}`);
      unmount();
    }
  });

  test("title renders bold in the tone colour above the body", () => {
    render(
      <Notice tone="danger" title="Payment declined">
        Try another card.
      </Notice>,
    );
    const title = screen.getByText("Payment declined");
    expect(title).toHaveClass("font-semibold", "text-danger");
    expect(screen.getByRole("alert")).toHaveTextContent("Payment declinedTry another card.");
  });

  test("no dismiss button unless onDismiss is given", () => {
    render(<Notice tone="info">x</Notice>);
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("onDismiss: labelled icon button calls it", () => {
    const onDismiss = mock();
    const { rerender } = render(
      <Notice tone="success" onDismiss={onDismiss}>
        Saved
      </Notice>,
    );
    const button = screen.getByRole("button", { name: "Dismiss" });
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(
      <Notice tone="success" onDismiss={onDismiss} dismissLabel="Close message">
        Saved
      </Notice>,
    );
    expect(screen.getByRole("button", { name: "Close message" })).toBeInTheDocument();
  });

  test("className merged last, attributes and ref forwarded", () => {
    const ref = createRef<HTMLDivElement>();
    render(
      <Notice tone="info" className="mt-4" id="n1" ref={ref}>
        x
      </Notice>,
    );
    const root = screen.getByRole("status");
    expect(root.className.split(" ").at(-1)).toBe("mt-4");
    expect(root).toHaveAttribute("id", "n1");
    expect(ref.current).toBe(root as HTMLDivElement);
  });
});
