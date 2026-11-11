import { describe, expect, jest, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_TOAST_DURATION_MS, ToastProvider, normalizeToastDuration } from "@/components/atoms/Toast";
import {
  ADDED_TO_CART_TITLE,
  AddedToCartToast,
  DEFAULT_CART_HREF,
  safeCartHref,
  type AddedToCartTrigger,
} from "./AddedToCartToast";
import { expectFocused } from "@/test/dom-assertions";

function Harness({
  trigger,
  navigate,
  cartHref,
}: {
  trigger: AddedToCartTrigger | null;
  navigate?: (href: string) => void;
  cartHref?: string;
}) {
  return (
    <ToastProvider>
      <button type="button">Elsewhere</button>
      <AddedToCartToast trigger={trigger} navigate={navigate} {...(cartHref !== undefined ? { cartHref } : {})} />
    </ToastProvider>
  );
}

describe("AddedToCartToast", () => {
  test("renders nothing and does not throw without a ToastProvider", () => {
    const { container, rerender } = render(<AddedToCartToast trigger={null} />);
    expect(container).toBeEmptyDOMElement();
    expect(() => rerender(<AddedToCartToast trigger={{ count: 1, description: "Tote" }} />)).not.toThrow();
    expect(container).toBeEmptyDOMElement();
  });

  test("no toast for a null trigger or count 0", () => {
    const { rerender } = render(<Harness trigger={null} />);
    rerender(<Harness trigger={{ count: 0 }} />);
    expect(screen.queryByText(ADDED_TO_CART_TITLE)).toBeNull();
  });

  test("count increase raises a polite success toast with description and View cart action; focus stays put", async () => {
    const visited: string[] = [];
    const { rerender } = render(<Harness trigger={null} navigate={(h) => visited.push(h)} />);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    rerender(<Harness trigger={{ count: 1, description: "Canvas Tote Bag" }} navigate={(h) => visited.push(h)} />);
    const title = await screen.findByText(ADDED_TO_CART_TITLE);
    expect(screen.getByText("Canvas Tote Bag")).toBeInTheDocument();
    // Polite (success tone) live region, not the interrupting alert list.
    const live = title.closest('[role="status"][aria-live="polite"]');
    expect(live).not.toBeNull();
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    // No focus trap / no focus move.
    expectFocused(elsewhere);
    if (!(live instanceof HTMLElement)) throw new Error("live region not found");
    fireEvent.click(within(live).getByRole("button", { name: "View cart" }));
    expect(visited).toEqual(["/cart"]);
  });

  test("one toast per increase; same count re-render does not duplicate", async () => {
    const { rerender } = render(<Harness trigger={{ count: 1 }} />);
    await screen.findByText(ADDED_TO_CART_TITLE);
    rerender(<Harness trigger={{ count: 1 }} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getAllByText(ADDED_TO_CART_TITLE)).toHaveLength(1);
    rerender(<Harness trigger={{ count: 2 }} />);
    await waitFor(() => expect(screen.getAllByText(ADDED_TO_CART_TITLE)).toHaveLength(2));
  });

  test("ignores non-integer or decreasing counts", async () => {
    const { rerender } = render(<Harness trigger={{ count: Number.NaN }} />);
    rerender(<Harness trigger={{ count: 1.5 }} />);
    rerender(<Harness trigger={{ count: -1 }} />);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText(ADDED_TO_CART_TITLE)).toBeNull();
  });

  test("hostile description renders as text", async () => {
    const { container } = render(<Harness trigger={{ count: 1, description: "<img src=x onerror=alert(1)>" }} />);
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.ownerDocument.querySelector("img")).toBeNull();
  });

  test("auto-dismisses: success tone gets the provider's finite default duration", () => {
    // The toast is raised without `durationMs`, so the atom applies its success default.
    expect(normalizeToastDuration(undefined, "success")).toBe(DEFAULT_TOAST_DURATION_MS);
  });

  test("the toast disappears after its duration (fake timers)", () => {
    jest.useFakeTimers();
    try {
      render(<Harness trigger={{ count: 1 }} />);
      expect(screen.getByText(ADDED_TO_CART_TITLE)).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 1);
      });
      expect(screen.getByText(ADDED_TO_CART_TITLE)).toBeInTheDocument();
      act(() => {
        jest.advanceTimersByTime(2);
      });
      expect(screen.queryByText(ADDED_TO_CART_TITLE)).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test("safeCartHref: internal routes pass, everything else falls back to /cart", () => {
    expect(DEFAULT_CART_HREF).toBe("/cart");
    expect(safeCartHref("/cart")).toBe("/cart");
    expect(safeCartHref("/cart?ref=toast")).toBe("/cart?ref=toast");
    for (const bad of ["javascript:alert(1)", "https://evil.example/cart", "//evil.example", "/\\evil.example", "cart", "", "/no-such-route", undefined, null, 7]) {
      expect(safeCartHref(bad)).toBe("/cart");
    }
  });

  test("View cart never navigates to an unsafe cartHref (falls back to /cart)", async () => {
    for (const cartHref of ["javascript:alert(1)", "https://evil.example/cart", "//evil.example/cart"]) {
      const visited: string[] = [];
      const { unmount } = render(<Harness trigger={{ count: 1 }} cartHref={cartHref} navigate={(h) => visited.push(h)} />);
      fireEvent.click(await screen.findByRole("button", { name: "View cart" }));
      expect(visited).toEqual(["/cart"]);
      unmount();
    }
  });

  test("a safe custom cartHref is used as given", async () => {
    const visited: string[] = [];
    render(<Harness trigger={{ count: 1 }} cartHref="/cart?ref=toast" navigate={(h) => visited.push(h)} />);
    fireEvent.click(await screen.findByRole("button", { name: "View cart" }));
    expect(visited).toEqual(["/cart?ref=toast"]);
  });
});
