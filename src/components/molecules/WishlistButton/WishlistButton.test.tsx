import { describe, expect, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import type { ListActionFn, ListActionState } from "../_contracts/list-actions";
import {
  WISHLIST_ADDED_MESSAGE,
  WISHLIST_ALREADY_MESSAGE,
  WISHLIST_REMOVED_MESSAGE,
  WishlistButton,
  type WishlistButtonProps,
  wishlistLabel,
} from "./WishlistButton";
import { listErrorMessage } from "./list-error-message";
import { expectFocused } from "@/test/dom-assertions";

type Posted = Record<string, string>;

function recording(result: ListActionState | (() => Promise<ListActionState>)) {
  const calls: Posted[] = [];
  const action: ListActionFn = async (_prev, formData) => {
    const posted: Posted = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") posted[key] = value;
    });
    calls.push(posted);
    return typeof result === "function" ? result() : result;
  };
  return { action, calls };
}

const added: ListActionState = { ok: true, kind: "added", message: "Added to your list.", listId: "L1" };
const removed: ListActionState = { ok: true, kind: "removed", message: "Removed from your list.", listId: "L1" };

function failure(code: ErrorCode, message: string, extra: { retryAfterSeconds?: number } = {}): ListActionState {
  return { ok: false, error: appError(code, message), message, ...extra };
}

function setup(props: Partial<WishlistButtonProps> = {}, results: { add?: ListActionState; remove?: ListActionState } = {}) {
  const add = recording(results.add ?? added);
  const remove = recording(results.remove ?? removed);
  const utils = render(
    <WishlistButton
      productId="p1"
      productSlug="oak-desk"
      productName="Oak Desk"
      inList={false}
      addAction={add.action}
      removeAction={remove.action}
      {...props}
    />,
  );
  return { ...utils, addCalls: add.calls, removeCalls: remove.calls };
}

const noop: ListActionFn = async () => null;

describe("WishlistButton", () => {
  test("static markup: one plain form, hidden fields, aria-pressed=false, no JS-only state", () => {
    const html = renderToStaticMarkup(
      <WishlistButton productId="p1" productSlug="oak-desk" productName="Oak Desk" inList={false} addAction={noop} removeAction={noop} />,
    );
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html).toContain('type="hidden" name="productId" value="p1"');
    expect(html).toContain('type="hidden" name="productSlug" value="oak-desk"');
    expect(html).toContain('type="hidden" name="listId" value=""');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('aria-label="Add Oak Desk to Wish List"');
    expect(html).toContain('type="submit"');
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain(WISHLIST_ADDED_MESSAGE);
  });

  test("not in list: accessible name includes the product, pressed false, 44px target", () => {
    setup();
    const button = screen.getByRole("button", { name: "Add Oak Desk to Wish List" });
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveClass("size-touch");
  });

  test("in list: Remove label and aria-pressed true", () => {
    setup({ inList: true, listId: "L1" });
    const button = screen.getByRole("button", { name: "Remove Oak Desk from Wish List" });
    expect(button).toHaveAttribute("aria-pressed", "true");
  });

  test("listId is posted as given; null posts an empty listId (default list)", () => {
    const { container } = setup({ listId: "L9" });
    expect(container.querySelector('input[name="listId"]')).toHaveAttribute("value", "L9");
  });

  test("add success: posts fields, flips aria-pressed, announces, next submit goes to removeAction", async () => {
    const { addCalls, removeCalls } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add Oak Desk to Wish List" }));
    await waitFor(() => expect(addCalls).toHaveLength(1));
    expect(addCalls[0]).toEqual({ productId: "p1", productSlug: "oak-desk", listId: "" });
    const pressed = await screen.findByRole("button", { name: "Remove Oak Desk from Wish List" });
    expect(pressed).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("wishlist-status")).toHaveTextContent(WISHLIST_ADDED_MESSAGE);
    expect(screen.getByTestId("wishlist-status")).toHaveAttribute("aria-live", "polite");

    fireEvent.click(pressed);
    await waitFor(() => expect(removeCalls).toHaveLength(1));
    // The list the server added to is used for removal.
    expect(removeCalls[0]).toEqual({ productId: "p1", productSlug: "oak-desk", listId: "L1" });
    const unpressed = await screen.findByRole("button", { name: "Add Oak Desk to Wish List" });
    expect(unpressed).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("wishlist-status")).toHaveTextContent(WISHLIST_REMOVED_MESSAGE);
    expect(addCalls).toHaveLength(1);
  });

  test("already_present counts as in the list", async () => {
    setup({}, { add: { ok: true, kind: "already_present", message: "x", listId: "L1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Oak Desk to Wish List" }));
    const button = await screen.findByRole("button", { name: "Remove Oak Desk from Wish List" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("wishlist-status")).toHaveTextContent(WISHLIST_ALREADY_MESSAGE);
  });

  test.each([
    ["RATE_LIMITED", failure("RATE_LIMITED", "Too many", { retryAfterSeconds: 125 }), "Please try again in 3 minutes."],
    ["LIMIT_REACHED", failure("LIMIT_REACHED", "A list can hold up to 200 items. Remove one to add another."), "up to 200 items"],
    ["NOT_FOUND", failure("NOT_FOUND", "We couldn't find that list or item."), "couldn't find that list"],
  ] as const)("%s error shows in role=alert and pressed state is unchanged", async (_code, state, text) => {
    const { addCalls } = setup({}, { add: state });
    fireEvent.click(screen.getByRole("button", { name: "Add Oak Desk to Wish List" }));
    await waitFor(() => expect(addCalls).toHaveLength(1));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(screen.getByRole("button", { name: "Add Oak Desk to Wish List" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("wishlist-status")).toHaveTextContent("");
  });

  test("pending: button is busy while the action runs", async () => {
    let resolve: (s: ListActionState) => void = () => {};
    const slow = recording(() => new Promise<ListActionState>((r) => (resolve = r)));
    render(
      <WishlistButton productId="p1" productSlug="s" productName="Oak Desk" inList={false} addAction={slow.action} removeAction={noop} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add Oak Desk to Wish List" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add Oak Desk to Wish List" })).toHaveAttribute("aria-busy", "true"),
    );
    resolve(added);
    await screen.findByRole("button", { name: "Remove Oak Desk from Wish List" });
  });

  test("more than one list: 'Save to' select named listId replaces the hidden field", async () => {
    const lists = [
      { id: "L1", name: "Shopping List" },
      { id: "L2", name: "Birthday" },
    ];
    const { container, addCalls } = setup({ lists, listId: "L2" });
    const select = screen.getByRole("combobox", { name: "Save to" });
    expect(select).toHaveAttribute("name", "listId");
    expect(select).toHaveValue("L2");
    expect(container.querySelectorAll('input[name="listId"]')).toHaveLength(0);
    fireEvent.change(select, { target: { value: "L1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Oak Desk to Wish List" }));
    await waitFor(() => expect(addCalls).toHaveLength(1));
    expect(addCalls[0]?.listId).toBe("L1");
  });

  test("one list or in-list state: no select", () => {
    setup({ lists: [{ id: "L1", name: "Shopping List" }] });
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  test("variant button: visible text, product in the accessible name, aria-pressed", () => {
    setup({ variant: "button", inList: true, listId: "L1" });
    const button = screen.getByRole("button", { name: "Remove Oak Desk from Wish List" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveTextContent("Remove Oak Desk from Wish List");
  });

  test("re-syncs when the server's inList prop changes", () => {
    const { rerender } = setup();
    rerender(
      <WishlistButton productId="p1" productSlug="oak-desk" productName="Oak Desk" inList listId="L1" addAction={noop} removeAction={noop} />,
    );
    expect(screen.getByRole("button", { name: "Remove Oak Desk from Wish List" })).toHaveAttribute("aria-pressed", "true");
  });

  test("hostile product name is text, never markup", () => {
    const html = renderToStaticMarkup(
      <WishlistButton productId="p1" productSlug="s" productName={'<img src=x onerror="alert(1)">'} inList={false} addAction={noop} removeAction={noop} variant="button" />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x");
  });

  test("button variant: visible label has single spaces; product name only in the accessible name (U17)", () => {
    const { rerender } = render(
      <WishlistButton productId="p1" productSlug="oak-desk" productName="Oak Desk" inList={false} addAction={noop} removeAction={noop} variant="button" />,
    );
    const visibleLabel = (): string => {
      const span = screen.getByRole("button").querySelector('[data-slot="wishlist-label"]');
      if (span === null) throw new Error("label span missing");
      const copy = span.cloneNode(true);
      if (!(copy instanceof HTMLElement)) throw new Error("not an element");
      for (const hidden of Array.from(copy.querySelectorAll(".sr-only"))) hidden.remove();
      return copy.textContent ?? "";
    };
    expect(screen.getByRole("button", { name: "Add Oak Desk to Wish List" })).toBeTruthy();
    expect(visibleLabel()).toBe("Add to Wish List");
    rerender(
      <WishlistButton productId="p1" productSlug="oak-desk" productName="Oak Desk" inList listId="L1" addAction={noop} removeAction={noop} variant="button" />,
    );
    expect(screen.getByRole("button", { name: "Remove Oak Desk from Wish List" })).toBeTruthy();
    expect(visibleLabel()).toBe("Remove from Wish List");
  });

  test("keyboard: native submit button reachable by Tab", () => {
    setup();
    const button = screen.getByRole("button", { name: "Add Oak Desk to Wish List" });
    button.focus();
    expectFocused(button);
    expect(button.tagName).toBe("BUTTON");
  });

  test("wishlistLabel falls back for a blank name", () => {
    expect(wishlistLabel("  ", false)).toBe("Add this item to Wish List");
    expect(wishlistLabel("Lamp", true)).toBe("Remove Lamp from Wish List");
  });
});

describe("listErrorMessage", () => {
  test("RATE_LIMITED: whole minutes rounded up, singular, fallback", () => {
    const rl = (s?: number) => failure("RATE_LIMITED", "x", s === undefined ? {} : { retryAfterSeconds: s });
    const f = (s: ListActionState) => (s !== null && s.ok === false ? listErrorMessage(s) : "");
    expect(f(rl(60))).toBe("Too many requests. Please try again in 1 minute.");
    expect(f(rl(61))).toBe("Too many requests. Please try again in 2 minutes.");
    expect(f(rl())).toBe("Too many requests. Please try again later.");
    expect(f(rl(Number.NaN))).toBe("Too many requests. Please try again later.");
  });

  test("other codes use the message; blank falls back", () => {
    const s = failure("FORBIDDEN", "  ");
    expect(s !== null && s.ok === false ? listErrorMessage(s) : "").toBe("Something went wrong. Please try again.");
  });
});

describe("WishlistButton Phase 3 look (T145)", () => {
  test("variant button is a neutral 44px pill; fullWidth stretches it for the buy box; pressed state keeps text", () => {
    const { unmount } = setup({ variant: "button" });
    const button = screen.getByRole("button", { name: "Add Oak Desk to Wish List" });
    expect(button).toHaveClass("rounded-full", "min-h-touch", "border-border-strong");
    expect(button).not.toHaveClass("w-full");
    unmount();
    setup({ variant: "button", fullWidth: true, inList: true, listId: "L1" });
    const pressed = screen.getByRole("button", { name: "Remove Oak Desk from Wish List" });
    expect(pressed).toHaveClass("w-full", "rounded-full", "aria-pressed:bg-accent-subtle");
    expect(pressed).toHaveAttribute("aria-pressed", "true");
  });

  test("fullWidth is ignored by the icon variant (44px heart stays square)", () => {
    setup({ fullWidth: true });
    const heart = screen.getByRole("button", { name: "Add Oak Desk to Wish List" });
    expect(heart).toHaveClass("size-touch");
    expect(heart).not.toHaveClass("w-full");
  });
});
