import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import { useEffect } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import {
  DEFAULT_TOAST_DURATION_MS,
  MAX_TOAST_DURATION_MS,
  ToastProvider,
  ToastViewport,
  normalizeToastDuration,
  useToast,
} from "./Toast";
import type { ToastApi, ToastOptions } from "./Toast";

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

const apiRef: { current: ToastApi | null } = { current: null };
function Capture() {
  const api = useToast();
  useEffect(() => {
    apiRef.current = api;
  });
  return null;
}

function setup(props: { maxVisible?: number } = {}) {
  render(
    <ToastProvider {...props}>
      <Capture />
    </ToastProvider>,
  );
  return (options: ToastOptions) => {
    let id = "";
    act(() => {
      id = apiRef.current?.toast(options) ?? "";
    });
    return id;
  };
}

const status = () => screen.getByRole("status");
const alertRegion = () => screen.getByRole("alert");

describe("Toast", () => {
  test("viewport renders empty live regions up front", () => {
    setup();
    const region = screen.getByRole("region", { name: "Notifications" });
    // Bottom-centre on mobile; top-right from md (under the sticky top bar,
    // never over a sticky "Add to cart"), z-toast above z-sticky.
    expect(region).toHaveClass("fixed", "z-toast", "bottom-0", "left-0", "right-0");
    expect(region).toHaveClass("md:top-16", "md:bottom-auto", "md:left-auto");
    expect(region.className).not.toMatch(/(^|\s)md:bottom-0(\s|$)/);
    expect(status()).toHaveAttribute("aria-live", "polite");
    expect(status()).toBeEmptyDOMElement();
    expect(alertRegion()).toBeEmptyDOMElement();
  });

  test("info/success go in the polite region with an sr-only tone prefix", () => {
    const toast = setup();
    toast({ title: "Added to cart", description: "1 x Shoe", tone: "success" });
    const item = within(status()).getByText("Added to cart").closest("[data-toast-id]") as HTMLElement;
    expect(item).toHaveAttribute("data-tone", "success");
    expect(item).toHaveClass("bg-success-subtle", "border-success");
    expect(within(item).getByText("Success:")).toHaveClass("sr-only");
    expect(within(item).getByText("1 x Shoe")).toBeInTheDocument();
    expect(alertRegion()).toBeEmptyDOMElement();
  });

  test("warning/danger go in the role=alert region", () => {
    const toast = setup();
    toast({ title: "Payment failed", tone: "danger" });
    toast({ title: "Low stock", tone: "warning" });
    expect(within(alertRegion()).getByText("Payment failed")).toBeInTheDocument();
    expect(within(alertRegion()).getByText("Low stock")).toBeInTheDocument();
    expect(status()).toBeEmptyDOMElement();
  });

  test("tone defaults to info", () => {
    const toast = setup();
    toast({ title: "Hello" });
    expect(within(status()).getByText("Info:")).toBeInTheDocument();
  });

  test("info auto-dismisses after the default duration", () => {
    const toast = setup();
    toast({ title: "Saved" });
    advance(DEFAULT_TOAST_DURATION_MS - 1);
    expect(screen.getByText("Saved")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Saved")).toBeNull();
  });

  test("danger persists by default; durationMs overrides", () => {
    const toast = setup();
    toast({ title: "Stays", tone: "danger" });
    toast({ title: "Quick", durationMs: 1000 });
    advance(60_000);
    expect(screen.getByText("Stays")).toBeInTheDocument();
    expect(screen.queryByText("Quick")).toBeNull();
  });

  test("hover pauses auto-dismiss; leaving restarts the timer", () => {
    const toast = setup();
    toast({ title: "Hover me", durationMs: 1000 });
    const item = screen.getByText("Hover me").closest("[data-toast-id]") as HTMLElement;
    advance(500);
    fireEvent.mouseEnter(item);
    advance(5000);
    expect(screen.getByText("Hover me")).toBeInTheDocument();
    fireEvent.mouseLeave(item);
    advance(999);
    expect(screen.getByText("Hover me")).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText("Hover me")).toBeNull();
  });

  test("focus inside pauses auto-dismiss", () => {
    const toast = setup();
    toast({ title: "Focus me", durationMs: 1000 });
    const dismissBtn = screen.getByRole("button", { name: "Dismiss notification: Focus me" });
    act(() => dismissBtn.focus());
    advance(5000);
    expect(screen.getByText("Focus me")).toBeInTheDocument();
    act(() => dismissBtn.blur());
    advance(1000);
    expect(screen.queryByText("Focus me")).toBeNull();
  });

  test("dismiss button removes the toast", () => {
    const toast = setup();
    toast({ title: "Bye", tone: "warning" });
    const btn = screen.getByRole("button", { name: "Dismiss notification: Bye" });
    expect(btn).toHaveClass("size-touch");
    fireEvent.click(btn);
    expect(screen.queryByText("Bye")).toBeNull();
  });

  test("Escape inside a toast dismisses it", () => {
    const toast = setup();
    toast({ title: "Esc", tone: "danger" });
    fireEvent.keyDown(screen.getByRole("button", { name: /Dismiss notification/ }), { key: "Escape" });
    expect(screen.queryByText("Esc")).toBeNull();
  });

  test("action runs its handler and dismisses", () => {
    const onClick = mock();
    const toast = setup();
    toast({ title: "Added", tone: "success", action: { label: "View cart", onClick } });
    fireEvent.click(screen.getByRole("button", { name: "View cart" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Added")).toBeNull();
  });

  test("at most 3 visible; queued toasts appear as slots free", () => {
    const toast = setup();
    const ids = ["A", "B", "C", "D"].map((title) => toast({ title, durationMs: null }));
    expect(screen.queryByText("D")).toBeNull();
    expect(screen.getAllByRole("button", { name: /Dismiss notification/ })).toHaveLength(3);
    act(() => apiRef.current?.dismiss(ids[0] ?? ""));
    expect(screen.getByText("D")).toBeInTheDocument();
    expect(screen.queryByText("A")).toBeNull();
  });

  test("maxVisible is configurable", () => {
    const toast = setup({ maxVisible: 1 });
    toast({ title: "One", durationMs: null });
    toast({ title: "Two", durationMs: null });
    expect(screen.queryByText("Two")).toBeNull();
  });

  test("toast() returns unique ids", () => {
    const toast = setup();
    expect(toast({ title: "a" })).not.toBe(toast({ title: "b" }));
  });

  test("viewport={false} lets the app place ToastViewport itself", () => {
    render(
      <ToastProvider viewport={false}>
        <main>
          <ToastViewport label="Alerts" className="x-vp" />
        </main>
      </ToastProvider>,
    );
    const regions = screen.getAllByRole("region");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toHaveAccessibleName("Alerts");
    expect(regions[0]?.className.endsWith("x-vp")).toBe(true);
  });

  test("useToast and ToastViewport throw outside the provider", () => {
    const original = console.error;
    console.error = mock(() => {});
    expect(() => render(<Capture />)).toThrow(/ToastProvider/);
    expect(() => render(<ToastViewport />)).toThrow(/ToastProvider/);
    console.error = original;
  });

  test("maxVisible NaN falls back to 3", () => {
    const toast = setup({ maxVisible: Number.NaN });
    ["A", "B", "C", "D"].forEach((title) => toast({ title, durationMs: null }));
    expect(screen.getAllByRole("button", { name: /Dismiss notification/ })).toHaveLength(3);
  });

  test("maxVisible 0 clamps to 1", () => {
    const toast = setup({ maxVisible: 0 });
    ["A", "B"].forEach((title) => toast({ title, durationMs: null }));
    expect(screen.getAllByRole("button", { name: /Dismiss notification/ })).toHaveLength(1);
  });

  test("durationMs Infinity persists; huge values are capped, not fired immediately", () => {
    const toast = setup();
    toast({ title: "Forever", durationMs: Number.POSITIVE_INFINITY });
    toast({ title: "Huge", durationMs: 1e12 });
    advance(60_000);
    expect(screen.getByText("Forever")).toBeInTheDocument();
    expect(screen.getByText("Huge")).toBeInTheDocument();
  });

  test("durationMs NaN or <= 0 uses the tone default", () => {
    const toast = setup();
    toast({ title: "Nan", durationMs: Number.NaN });
    toast({ title: "Neg", durationMs: -5 });
    advance(50);
    expect(screen.getByText("Nan")).toBeInTheDocument();
    expect(screen.getByText("Neg")).toBeInTheDocument();
    advance(DEFAULT_TOAST_DURATION_MS);
    expect(screen.queryByText("Nan")).toBeNull();
  });

  test("normalizeToastDuration", () => {
    expect(normalizeToastDuration(null, "info")).toBeNull();
    expect(normalizeToastDuration(Number.POSITIVE_INFINITY, "info")).toBeNull();
    expect(normalizeToastDuration(Number.NaN, "info")).toBe(DEFAULT_TOAST_DURATION_MS);
    expect(normalizeToastDuration(0, "danger")).toBeNull();
    expect(normalizeToastDuration(Number.NEGATIVE_INFINITY, "success")).toBe(DEFAULT_TOAST_DURATION_MS);
    expect(normalizeToastDuration(1e12, "info")).toBe(MAX_TOAST_DURATION_MS);
    expect(normalizeToastDuration(2500, "danger")).toBe(2500);
  });
});
