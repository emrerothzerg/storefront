import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appError } from "@/lib/result";
import type { StockAlertActionFn, StockAlertActionState } from "../_contracts/stock-alert-actions";
import { STOCK_ALERT_COPY, StockAlertForm, stockAlertErrorText } from "./StockAlertForm";

type Posted = Record<string, string>;

function recording(result: StockAlertActionState): { action: StockAlertActionFn; calls: Posted[] } {
  const calls: Posted[] = [];
  const action: StockAlertActionFn = async (_prev, formData) => {
    const entry: Posted = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") entry[key] = value;
    });
    calls.push(entry);
    return result;
  };
  return { action, calls };
}

function controlled(): { action: StockAlertActionFn; resolve: (s: StockAlertActionState) => void; count: () => number } {
  let resolveFn: (s: StockAlertActionState) => void = () => {};
  let n = 0;
  const action: StockAlertActionFn = () => {
    n += 1;
    return new Promise<StockAlertActionState>((res) => {
      resolveFn = res;
    });
  };
  return { action, resolve: (s) => resolveFn(s), count: () => n };
}

const failure = (
  code: Parameters<typeof appError>[0],
  message: string,
  details?: Record<string, unknown>,
  retryAfterSeconds?: number,
): StockAlertActionState => ({
  ok: false,
  error: appError(code, message, details),
  message,
  ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
});

const subscribed: StockAlertActionState = { ok: true, kind: "subscribed", message: "Saved" };

function submitButton(name: string | RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

function formOf(el: HTMLElement): HTMLFormElement {
  const form = el.closest("form");
  if (!form) throw new Error("form not found");
  return form;
}

describe("StockAlertForm (not registered)", () => {
  test("server markup is a plain form with hidden ids, a submit button, the helper text and no email input", () => {
    const { action } = recording(subscribed);
    const html = renderToStaticMarkup(
      <StockAlertForm action={action} productId="p1" productSlug="desk-lamp" registered={false} />,
    );
    expect(html).toContain("<form");
    expect(html).toMatch(/<input type="hidden" name="productId" value="p1"\/>/);
    expect(html).toMatch(/<input type="hidden" name="productSlug" value="desk-lamp"\/>/);
    expect(html).toContain('type="submit"');
    expect(html).toContain("Notify me when available");
    expect(html).toContain("You&#x27;ll see a notice here and in your account when it&#x27;s back; we don&#x27;t send email.");
    expect(html).not.toContain('type="email"');
  });

  test("renders the exact helper text, the button and no email input", () => {
    const { action } = recording(subscribed);
    const { container } = render(
      <StockAlertForm action={action} productId="p1" productSlug="desk-lamp" registered={false} />,
    );
    expect(screen.getByText(STOCK_ALERT_COPY.helper)).toBeInTheDocument();
    expect(STOCK_ALERT_COPY.helper).toBe(
      "You'll see a notice here and in your account when it's back; we don't send email.",
    );
    expect(submitButton("Notify me when available")).toHaveAttribute("type", "submit");
    expect(container.querySelector('input[type="email"]')).toBeNull();
    expect(container.querySelectorAll("input:not([type=hidden])")).toHaveLength(0);
  });

  test("posts productId and productSlug only", async () => {
    const { action, calls } = recording(subscribed);
    render(<StockAlertForm action={action} productId="p1" productSlug="desk-lamp" registered={false} />);
    fireEvent.submit(formOf(submitButton("Notify me when available")));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ productId: "p1", productSlug: "desk-lamp" });
  });

  test("shows Saving… with aria-busy while pending, then the registered text in a polite live region", async () => {
    const c = controlled();
    render(<StockAlertForm action={c.action} productId="p1" productSlug="s" registered={false} />);
    fireEvent.submit(formOf(submitButton("Notify me when available")));
    const busy = await screen.findByRole("button", { name: /Saving…/ });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(c.count()).toBe(1);
    await act(async () => c.resolve(subscribed));
    const text = await screen.findByText("We'll let you know when this is back in stock.");
    expect(text).toHaveAttribute("aria-live", "polite");
    expect(text.tagName).toBe("P");
    expect(screen.queryByRole("button", { name: /Notify me/ })).toBeNull();
  });

  test("already_registered also switches to the registered state", async () => {
    const { action } = recording({ ok: true, kind: "already_registered", message: "x" });
    render(<StockAlertForm action={action} productId="p1" productSlug="s" registered={false} />);
    fireEvent.submit(formOf(submitButton("Notify me when available")));
    expect(await screen.findByText(STOCK_ALERT_COPY.registered)).toBeInTheDocument();
  });

  test.each([
    [failure("INVALID_INPUT", "x", { reason: "already_available" }), "Good news: this item is available now."],
    [failure("LIMIT_REACHED", "x", { limit: 20 }), "You're already watching 20 items, the maximum. Stop watching one in your account to add this one."],
    [failure("RATE_LIMITED", "x", undefined, 125), "Too many requests. Try again in 3 minutes."],
    [failure("RATE_LIMITED", "x", undefined, 30), "Too many requests. Try again in 1 minute."],
    [failure("PRODUCT_NOT_FOUND", "We couldn't find that product.", undefined), "We couldn't find that product."],
  ] as const)("error %# renders in role=alert and keeps the form", async (state, text) => {
    const { action } = recording(state);
    render(<StockAlertForm action={action} productId="p1" productSlug="s" registered={false} />);
    fireEvent.submit(formOf(submitButton("Notify me when available")));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(text);
    expect(submitButton("Notify me when available")).toBeInTheDocument();
  });

  test("hostile server message renders as text, never markup", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const { action } = recording(failure("VALIDATION_FAILED", hostile));
    const { container } = render(<StockAlertForm action={action} productId="p1" productSlug="s" registered={false} />);
    fireEvent.submit(formOf(submitButton("Notify me when available")));
    expect(await screen.findByRole("alert")).toHaveTextContent(hostile);
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("StockAlertForm (registered)", () => {
  test("registered prop renders text, no subscribe form; Stop watching needs unsubscribeAction and alertId", () => {
    const { action } = recording(subscribed);
    const { rerender, container } = render(
      <StockAlertForm action={action} productId="p1" productSlug="s" registered />,
    );
    expect(screen.getByText(STOCK_ALERT_COPY.registered)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector("form")).toBeNull();

    const { action: unsub } = recording({ ok: true, kind: "unsubscribed", message: "x" });
    rerender(<StockAlertForm action={action} unsubscribeAction={unsub} productId="p1" productSlug="s" registered />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(
      <StockAlertForm action={action} unsubscribeAction={unsub} productId="p1" productSlug="s" registered alertId="a1" />,
    );
    expect(submitButton("Stop watching")).toHaveAttribute("type", "submit");
  });

  test("Stop watching posts alertId + productSlug and returns to the subscribe form", async () => {
    const { action } = recording(subscribed);
    const { action: unsub, calls } = recording({ ok: true, kind: "unsubscribed", message: "x" });
    render(
      <StockAlertForm action={action} unsubscribeAction={unsub} productId="p1" productSlug="s" registered alertId="a1" />,
    );
    fireEvent.submit(formOf(submitButton("Stop watching")));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({ alertId: "a1", productSlug: "s" });
    expect(await screen.findByRole("button", { name: "Notify me when available" })).toBeInTheDocument();
    expect(screen.getByText(STOCK_ALERT_COPY.unsubscribed)).toHaveAttribute("aria-live", "polite");
  });

  test("unsubscribe failure shows an alert and keeps the registered state", async () => {
    const { action } = recording(subscribed);
    const { action: unsub } = recording(failure("NOT_FOUND", "That alert no longer exists."));
    render(
      <StockAlertForm action={action} unsubscribeAction={unsub} productId="p1" productSlug="s" registered alertId="a1" />,
    );
    fireEvent.submit(formOf(submitButton("Stop watching")));
    expect(await screen.findByRole("alert")).toHaveTextContent("That alert no longer exists.");
    expect(screen.getByText(STOCK_ALERT_COPY.registered)).toBeInTheDocument();
  });

  test("a new registered prop (after revalidation) wins", () => {
    const { action } = recording(subscribed);
    const { rerender } = render(<StockAlertForm action={action} productId="p1" productSlug="s" registered={false} />);
    expect(submitButton("Notify me when available")).toBeInTheDocument();
    rerender(<StockAlertForm action={action} productId="p1" productSlug="s" registered />);
    expect(screen.getByText(STOCK_ALERT_COPY.registered)).toBeInTheDocument();
    rerender(<StockAlertForm action={action} productId="p1" productSlug="s" registered={false} />);
    expect(submitButton("Notify me when available")).toBeInTheDocument();
  });
});

describe("stockAlertErrorText", () => {
  test("null for null/success, default limit when details are malformed, generic fallback for empty message", () => {
    expect(stockAlertErrorText(null)).toBeNull();
    expect(stockAlertErrorText(subscribed)).toBeNull();
    expect(stockAlertErrorText(failure("LIMIT_REACHED", "x", { limit: "lots" }))).toContain("20 items");
    expect(stockAlertErrorText(failure("RATE_LIMITED", "x", undefined, Number.NaN))).toContain("1 minute.");
    expect(stockAlertErrorText(failure("VALIDATION_FAILED", "  "))).toBe(STOCK_ALERT_COPY.generic);
  });
});
