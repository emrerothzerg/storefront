import { describe, expect, test } from "bun:test";
import { Component, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { appError } from "@/lib/result";
import { validateAddress, validateCard } from "@/lib/validation";
import type {
  CheckoutActionFn,
  CheckoutActionState,
  CheckoutRetainedValues,
} from "../_contracts/checkout-actions";
import { CheckoutForm, nextIdempotencyKey, readStockLines, splitFieldErrors } from "./CheckoutForm";
import { expectFocused } from "@/test/dom-assertions";

const KEY = "key-initial-0000";


type Call = { key: string; fields: Record<string, string> };

function snapshot(formData: FormData): Call {
  const fields: Record<string, string> = {};
  formData.forEach((value, name) => {
    if (typeof value === "string") fields[name] = value;
  });
  return { key: fields.idempotencyKey ?? "", fields };
}

/** Action that answers each call with the next scripted step ("throw" = network error). */
function scriptedAction(steps: ReadonlyArray<CheckoutActionState | "throw">) {
  const calls: Call[] = [];
  const action: CheckoutActionFn = async (_prev, formData) => {
    calls.push(snapshot(formData));
    const step = steps[calls.length - 1] ?? null;
    if (step === "throw") throw new TypeError("Failed to fetch");
    return step;
  };
  return { action, calls };
}

function controlledAction() {
  const calls: Call[] = [];
  let resolveFn: (s: CheckoutActionState) => void = () => {};
  const action: CheckoutActionFn = (_prev, formData) => {
    calls.push(snapshot(formData));
    return new Promise<CheckoutActionState>((res) => {
      resolveFn = res;
    });
  };
  return { action, calls, resolve: (s: CheckoutActionState) => resolveFn(s) };
}

function failure(
  code: Parameters<typeof appError>[0],
  message: string,
  details?: Readonly<Record<string, unknown>>,
  values?: CheckoutRetainedValues,
): CheckoutActionState {
  return { ok: false, error: appError(code, message, details), ...(values ? { values } : {}) };
}

function validationFailure(): CheckoutActionState {
  const address = validateAddress({ fullName: "Ada", email: "nope", line1: "1 Main St", city: "X", region: "Y", postalCode: "1", country: "US" });
  const card = validateCard({ number: "1234", expMonth: "13", expYear: "2030", cvc: "1", nameOnCard: "Ada" });
  if (address.ok || card.ok) throw new Error("expected validation failures");
  return failure(
    "VALIDATION_FAILED",
    "Some fields are invalid.",
    { fields: { ...address.error.details.fields, ...card.error.details.fields } },
    { fullName: "Ada", email: "nope", line1: "1 Main St", city: "X", region: "Y", postalCode: "1", country: "US", nameOnCard: "Ada" },
  );
}

const retained: CheckoutRetainedValues = {
  fullName: "Ada Lovelace",
  email: "ada@example.com",
  line1: "1 Main St",
  city: "London",
  region: "Greater London",
  postalCode: "N1 9GU",
  country: "GB",
  nameOnCard: "A LOVELACE",
};

function form(): HTMLFormElement {
  return screen.getByRole("form", { name: "Checkout" }) as HTMLFormElement;
}
function hiddenKey(): HTMLInputElement {
  const el = form().querySelector<HTMLInputElement>('input[type="hidden"][name="idempotencyKey"]');
  if (!el) throw new Error("hidden key missing");
  return el;
}
function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Labels read "Email (required)": match the visible label text at the start. */
function input(label: string): HTMLInputElement {
  return screen.getByLabelText(new RegExp(`^${escape(label)}`)) as HTMLInputElement;
}
function type(label: string, value: string) {
  fireEvent.change(input(label), { target: { value } });
}
function fillCard(number: string) {
  type("Name on card", "A LOVELACE");
  type("Card number", number);
  type("Expiry month", "12");
  type("Expiry year", "2099");
  type("Security code (CVC)", "123");
}
function fillAll(number = "4000000000000002") {
  type("Full name", "Ada Lovelace");
  type("Email", "ada@example.com");
  type("Address line 1", "1 Main St");
  type("City", "London");
  type("State / province / region", "Greater London");
  type("Postal code", "N1 9GU");
  fireEvent.change(input("Country"), { target: { value: "GB" } });
  fillCard(number);
}
const submitButton = () => screen.getByRole("button", { name: /place order/i });

describe("nextIdempotencyKey", () => {
  test("keeps the key when the attempt did not complete (network error)", () => {
    expect(nextIdempotencyKey("k1", false, () => "k2")).toBe("k1");
  });
  test("generates a new key after a completed attempt", () => {
    expect(nextIdempotencyKey("k1", true, () => "k2")).toBe("k2");
  });
  test("default generator returns a fresh UUID", () => {
    const a = nextIdempotencyKey("k1", true);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(nextIdempotencyKey("k1", true)).not.toBe(a);
  });
});

describe("splitFieldErrors / readStockLines", () => {
  test("splits real validator failures into address and card keys", () => {
    const state = validationFailure();
    const split = splitFieldErrors(state?.error);
    expect(Object.keys(split.address)).toEqual(["email"]);
    expect(Object.keys(split.card).sort()).toEqual(["cvc", "expMonth", "number"]);
  });
  test("ignores malformed details and other codes", () => {
    expect(splitFieldErrors(appError("VALIDATION_FAILED", "x", { fields: { email: "bad", city: { code: 1 } } }))).toEqual({ address: {}, card: {} });
    expect(splitFieldErrors(appError("PAYMENT_FAILED", "x", { fields: { email: { code: "REQUIRED", message: "m" } } }))).toEqual({ address: {}, card: {} });
    expect(readStockLines(appError("STOCK_CHANGED", "x", { lines: [{ productId: "p" }, null] }))).toEqual([]);
  });
});

describe("CheckoutForm", () => {
  test("renders a native, labelled, no-validate form with the server-rendered key", () => {
    const { action } = scriptedAction([]);
    const { container } = render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    expect(form()).toHaveAttribute("novalidate");
    expect(hiddenKey()).toHaveValue(KEY);
    expect(submitButton()).toHaveAttribute("type", "submit");
    expect(screen.queryByRole("alert")).toBeNull();
    for (const control of container.querySelectorAll("input:not([type=hidden]), select, button")) {
      expect(control).toHaveAccessibleName();
    }
    expect(container.innerHTML).not.toContain("outline-none");
  });

  test("posts address, card and idempotency key fields", async () => {
    const { action, calls } = scriptedAction([null]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    fillAll("4242424242424242");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.key).toBe(KEY);
    expect(calls[0]?.fields).toMatchObject({
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      country: "GB",
      number: "4242424242424242",
      expMonth: "12",
      expYear: "2099",
      cvc: "123",
      nameOnCard: "A LOVELACE",
    });
  });

  test("AC1: loading immediately; repeated click/submit/Enter while pending sends one submission", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    const button = submitButton();
    // Synchronous double submit before React re-renders (double-click).
    fireEvent.submit(form());
    fireEvent.submit(form());
    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.keyDown(input("Email"), { key: "Enter" });
    fireEvent.submit(form());
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toHaveLength(1);

    await act(async () => resolve(failure("INVALID_INPUT", "Something was off.")));
    await waitFor(() => expect(button).not.toHaveAttribute("aria-busy"));
    expect(calls).toHaveLength(1);
  });

  test("AC2: validation failure focuses the summary, which links to each invalid field", async () => {
    const { action } = scriptedAction([validationFailure()]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    fireEvent.submit(form());
    const heading = await screen.findByRole("heading", { name: "Please fix the following" });
    const summary = heading.closest('[role="alert"]') as HTMLElement;
    expect(summary).toHaveAttribute("tabindex", "-1");
    await waitFor(() => expectFocused(summary));

    const links = within(summary).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#address-email",
      "#card-number",
      "#card-expMonth",
      "#card-cvc",
    ]);
    expect(links[0]).toHaveTextContent("Email: Enter a valid email address.");
    expect(links[1]).toHaveTextContent(/^Card number: /);

    fireEvent.click(links[0] as HTMLElement);
    expectFocused(document.getElementById("address-email"));
    expect(input("Email")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(links[3] as HTMLElement);
    expectFocused(document.getElementById("card-cvc"));
    // Retained values come back as defaults.
    expect(input("Full name")).toHaveValue("Ada");
    expect(input("Name on card")).toHaveValue("Ada");
  });

  test("AC3 + AC5: payment declined shows an alert, keeps values except card data, and allows a retry", async () => {
    const declined = failure(
      "PAYMENT_FAILED",
      "Your card was declined.",
      { orderId: "ord_1", failureCode: "DECLINED" },
      retained,
    );
    const { action, calls } = scriptedAction([declined, null]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    fillAll("4000000000000002");
    fireEvent.submit(form());

    const heading = await screen.findByRole("heading", { name: /payment didn't go through/i });
    const alert = heading.closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent("Your card was declined.");
    expect(alert).toHaveTextContent(/try a different card/i);
    await waitFor(() => expectFocused(alert));

    await waitFor(() => expect(input("Card number")).toHaveValue(""));
    for (const label of ["Card number", "Expiry month", "Expiry year", "Security code (CVC)"]) {
      const el = input(label);
      expect(el).toHaveValue("");
      expect(el.defaultValue).toBe("");
      expect(el).not.toHaveAttribute("value");
    }
    expect(input("Full name")).toHaveValue("Ada Lovelace");
    expect(input("Email")).toHaveValue("ada@example.com");
    expect(input("Postal code")).toHaveValue("N1 9GU");
    expect(input("Country")).toHaveValue("GB");
    expect(input("Name on card")).toHaveValue("A LOVELACE");
    expect(alert.innerHTML).not.toContain("4000000000000002");

    // Retry with a different card: new attempt, new key.
    fillCard("4242424242424242");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.fields.number).toBe("4242424242424242");
    expect(calls[1]?.fields.email).toBe("ada@example.com");
    expect(calls[1]?.key).not.toBe(calls[0]?.key);
  });

  test("AC4: key is stable across a network-error retry and regenerated after a completed attempt", async () => {
    const declined = failure("PAYMENT_FAILED", "Declined.", { orderId: "o", failureCode: "DECLINED" }, retained);
    const { action, calls } = scriptedAction(["throw", declined, null]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    fillAll();

    fireEvent.submit(form());
    const netHeading = await screen.findByRole("heading", { name: /couldn't place your order/i });
    await waitFor(() => expect(submitButton()).not.toHaveAttribute("aria-busy"));
    expect(hiddenKey()).toHaveValue(KEY);
    // Nothing was reset: the same payload can be replayed.
    expect(input("Card number")).toHaveValue("4000000000000002");
    expect(netHeading.closest('[role="alert"]')).toHaveTextContent(/won't be charged twice/i);

    fireEvent.submit(form());
    await screen.findByRole("heading", { name: /payment didn't go through/i });
    expect(calls[1]?.key).toBe(KEY);
    expect(calls[1]?.fields.number).toBe("4000000000000002");
    await waitFor(() => expect(hiddenKey().value).not.toBe(KEY));
    const newKey = hiddenKey().value;
    expect(newKey).toMatch(/^[0-9a-f-]{36}$/);

    fillCard("4242424242424242");
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]?.key).toBe(newKey);
  });

  test("every completed failure (validation, stock) regenerates the key", async () => {
    const stock = failure("STOCK_CHANGED", "Stock changed.", { lines: [] });
    const { action, calls } = scriptedAction([validationFailure(), stock, null]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    fireEvent.submit(form());
    await screen.findByRole("heading", { name: "Please fix the following" });
    fireEvent.submit(form());
    await screen.findByRole("heading", { name: /items in your cart changed/i });
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(3));
    const keys = calls.map((c) => c.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toBe(KEY);
  });

  test("STOCK_CHANGED lists affected items and links to the cart", async () => {
    const stock = failure("STOCK_CHANGED", "Some items changed since you added them.", {
      lines: [
        { productId: "p1", name: "Mug", requested: 3, available: 1 },
        { productId: "p2", name: "Lamp", requested: 1, available: 0 },
      ],
    });
    const { action } = scriptedAction([stock]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} cartHref="/my-cart" />);
    fireEvent.submit(form());
    const heading = await screen.findByRole("heading", { name: /items in your cart changed/i });
    const alert = heading.closest('[role="alert"]') as HTMLElement;
    expect(alert).toHaveTextContent("Mug: you asked for 3, only 1 available.");
    expect(alert).toHaveTextContent("Lamp: no longer available.");
    expect(within(alert).getByRole("link", { name: "Review your cart" })).toHaveAttribute("href", "/my-cart");
    await waitFor(() => expectFocused(alert));
  });

  test("EMPTY_CART shows an alert with a cart link (default /cart)", async () => {
    const { action } = scriptedAction([failure("EMPTY_CART", "Your cart is empty.")]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    fireEvent.submit(form());
    const heading = await screen.findByRole("heading", { name: "Your cart is empty" });
    const alert = heading.closest('[role="alert"]') as HTMLElement;
    expect(within(alert).getByRole("link", { name: "Go to your cart" })).toHaveAttribute("href", "/cart");
  });

  test("INVALID_INPUT shows a generic alert with the server message", async () => {
    const { action } = scriptedAction([failure("INVALID_INPUT", "Please reload the page and try again.")]);
    render(<CheckoutForm placeOrder={action} initialIdempotencyKey={KEY} />);
    fireEvent.submit(form());
    const heading = await screen.findByRole("heading", { name: /couldn't place your order/i });
    expect(heading.closest('[role="alert"]')).toHaveTextContent("Please reload the page and try again.");
  });

  test("a Next.js redirect (success) is rethrown, not shown as a network error", async () => {
    class Boundary extends Component<{ children: ReactNode }, { caught: string | null }> {
      override state = { caught: null as string | null };
      static getDerivedStateFromError(error: unknown) {
        const digest = typeof error === "object" && error !== null && "digest" in error ? String(error.digest) : "other";
        return { caught: digest };
      }
      override render() {
        return this.state.caught ? <p data-testid="caught">{this.state.caught}</p> : this.props.children;
      }
    }
    const redirectAction: CheckoutActionFn = async () => {
      throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;push;/order/1;303;" });
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      render(
        <Boundary>
          <CheckoutForm placeOrder={redirectAction} initialIdempotencyKey={KEY} />
        </Boundary>,
      );
      fireEvent.submit(form());
      expect(await screen.findByTestId("caught")).toHaveTextContent(/^NEXT_REDIRECT/);
    } finally {
      console.error = originalError;
    }
  });
});
