// QA (T70 / QA-W3-molecules-A): T66 StockAlertForm, ContactForm.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StockAlertForm } from "@/components/molecules/StockAlertForm";
import { ContactForm } from "@/components/molecules/ContactForm";
import type {
  StockAlertActionFn,
  StockAlertActionState,
} from "@/components/molecules/_contracts/stock-alert-actions";
import type {
  ContactActionFn,
  ContactActionState,
  ContactEchoValues,
} from "@/components/molecules/_contracts/contact-actions";
import { appError } from "@/lib/result";
import type { ErrorCode } from "@/lib/types";
import { expectFocused } from "@/test/dom-assertions";

type Fields = Record<string, string>;
function snapshot(fd: FormData): Fields {
  const out: Fields = {};
  fd.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}
function gated<S>() {
  const calls: Fields[] = [];
  const resolvers: Array<(s: S) => void> = [];
  const action = (_prev: S, fd: FormData): Promise<S> => {
    calls.push(snapshot(fd));
    return new Promise<S>((res) => resolvers.push(res));
  };
  const release = async (s: S) => {
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        resolvers.splice(0).forEach((r) => r(s));
        await new Promise((r) => setTimeout(r, 5));
      });
      if (resolvers.length === 0 && i > 2) break;
    }
  };
  return { action, calls, release };
}
function scripted<S>(steps: readonly S[], fallback: S) {
  const calls: Fields[] = [];
  const action = async (_prev: S, fd: FormData): Promise<S> => {
    calls.push(snapshot(fd));
    return steps[calls.length - 1] ?? fallback;
  };
  return { action, calls };
}
function userKeys(f: Fields): string[] {
  return Object.keys(f)
    .filter((k) => !k.startsWith("$ACTION"))
    .sort();
}

const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>`;
const RTL = "‮مرحبا שלום";

// ---------------------------------------------------------------------------
// StockAlertForm
// ---------------------------------------------------------------------------

const HELPER = "You'll see a notice here and in your account when it's back; we don't send email.";
const noopAlert: StockAlertActionFn = async () => null;
function alertFail(code: ErrorCode, message: string, details?: Record<string, unknown>, retry?: number) {
  const base = { ok: false as const, error: appError(code, message, details), message };
  return (retry === undefined ? base : { ...base, retryAfterSeconds: retry }) as StockAlertActionState;
}
const SA = { productId: "p-1", productSlug: "blue-mug" };

describe("T66 StockAlertForm", () => {
  test("static markup: plain form, hidden productId/productSlug, no email or visible input, exact helper copy", () => {
    const html = renderToStaticMarkup(<StockAlertForm action={noopAlert} {...SA} registered={false} />);
    expect(html).toMatch(/<form[^>]*>/);
    expect(html).toContain('type="hidden" name="productId" value="p-1"');
    expect(html).toContain('type="hidden" name="productSlug" value="blue-mug"');
    expect(html).not.toMatch(/type="email"|name="email"/);
    expect((html.match(/<input/g) ?? []).length).toBe(2);
    expect(html).toContain("Notify me when available");
    // React escapes the apostrophes in static markup.
    expect(html.replace(/&#x27;/g, "'")).toContain(HELPER);
  });

  test("registered: text state in aria-live=polite, no subscribe form; no stop form without both props", () => {
    const { container, rerender } = render(<StockAlertForm action={noopAlert} {...SA} registered />);
    const msg = screen.getByText("We'll let you know when this is back in stock.");
    expect(msg.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Notify me/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Stop watching/ })).toBeNull();
    rerender(<StockAlertForm action={noopAlert} unsubscribeAction={noopAlert} {...SA} registered />);
    expect(screen.queryByRole("button", { name: /Stop watching/ })).toBeNull();
    rerender(<StockAlertForm action={noopAlert} {...SA} registered alertId="a-1" />);
    expect(screen.queryByRole("button", { name: /Stop watching/ })).toBeNull();
    rerender(<StockAlertForm action={noopAlert} unsubscribeAction={noopAlert} {...SA} registered alertId="" />);
    expect(screen.queryByRole("button", { name: /Stop watching/ })).toBeNull();
    rerender(<StockAlertForm action={noopAlert} unsubscribeAction={noopAlert} {...SA} registered alertId="a-1" />);
    const stop = screen.getByRole("button", { name: "Stop watching" });
    const fields = snapshot(new FormData(stop.closest("form")!));
    expect(userKeys(fields)).toEqual(["alertId", "productSlug"]);
    expect(fields.alertId).toBe("a-1");
    expect(container.querySelector('input[type="email"]')).toBeNull();
  });

  test("pending subscribe: aria-busy, double click sends once; success shows registered text politely", async () => {
    const { action, calls, release } = gated<StockAlertActionState>();
    try {
      render(<StockAlertForm action={action} {...SA} registered={false} />);
      const btn = screen.getByRole("button", { name: /Notify me/ });
      fireEvent.click(btn);
      await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
      fireEvent.click(btn);
      fireEvent.click(btn);
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(calls).toHaveLength(1);
      expect(userKeys(calls[0]!)).toEqual(["productId", "productSlug"]);
      await release({ ok: true, kind: "subscribed", message: "ok" });
      const msg = await screen.findByText("We'll let you know when this is back in stock.");
      expect(msg.closest('[aria-live="polite"]')).not.toBeNull();
      expect(screen.queryByRole("button", { name: /Notify me/ })).toBeNull();
    } finally {
      await release(null);
    }
  });

  const errorCases: Array<[string, StockAlertActionState, string]> = [
    [
      "already_available",
      alertFail("INVALID_INPUT", "in stock", { reason: "already_available" }),
      "Good news: this item is available now.",
    ],
    ["LIMIT_REACHED (limit 20)", alertFail("LIMIT_REACHED", "limit", { limit: 20 }), "already watching 20 items"],
    ["LIMIT_REACHED (bad limit)", alertFail("LIMIT_REACHED", "limit", { limit: "x" }), "already watching 20 items"],
    ["RATE_LIMITED 61s", alertFail("RATE_LIMITED", "slow", undefined, 61), "Try again in 2 minutes."],
    ["RATE_LIMITED 60s", alertFail("RATE_LIMITED", "slow", undefined, 60), "Try again in 1 minute."],
    ["RATE_LIMITED no seconds", alertFail("RATE_LIMITED", "slow"), "Try again in 1 minute."],
    ["generic with markup", alertFail("PRODUCT_NOT_FOUND", HOSTILE), HOSTILE],
    ["generic blank message", alertFail("VALIDATION_FAILED", "  ", { reason: "unexpected" }), "We couldn't save that"],
  ];
  for (const [label, state, text] of errorCases) {
    test(`error ${label} -> role=alert text, subscribe button still usable`, async () => {
      const { action } = scripted<StockAlertActionState>([state], null);
      const { container } = render(<StockAlertForm action={action} {...SA} registered={false} />);
      fireEvent.click(screen.getByRole("button", { name: /Notify me/ }));
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(text);
      expect(container.querySelector("img, script")).toBeNull();
      expect(screen.getByRole("button", { name: /Notify me/ })).not.toHaveAttribute("aria-busy");
    });
  }

  test("unsubscribe success returns to subscribe form with polite 'no longer watching' text", async () => {
    const { action: unsub, calls } = scripted<StockAlertActionState>([{ ok: true, kind: "unsubscribed", message: "x" }], null);
    render(<StockAlertForm action={noopAlert} unsubscribeAction={unsub} {...SA} registered alertId="a-9" />);
    fireEvent.click(screen.getByRole("button", { name: "Stop watching" }));
    const msg = await screen.findByText("You're no longer watching this item.");
    expect(msg.closest('[aria-live="polite"]')).not.toBeNull();
    expect(calls[0]!.alertId).toBe("a-9");
    expect(screen.getByRole("button", { name: /Notify me/ })).toBeInTheDocument();
  });

  test("320px: subscribe button is full width; buttons keep 44px minimum", () => {
    render(<StockAlertForm action={noopAlert} unsubscribeAction={noopAlert} {...SA} registered={false} />);
    const btn = screen.getByRole("button", { name: /Notify me/ });
    expect(btn.className).toMatch(/\bw-full\b/);
    expect(btn.className).toMatch(/min-h-touch/);
  });
});

// ---------------------------------------------------------------------------
// ContactForm
// ---------------------------------------------------------------------------

const noopContact: ContactActionFn = async () => null;
function contactFail(
  code: ErrorCode,
  message: string,
  fieldErrors: Partial<Record<keyof ContactEchoValues, string>> = {},
  values: ContactEchoValues = {},
  retry?: number,
): ContactActionState {
  const base = { ok: false as const, error: appError(code, message), message, fieldErrors, values };
  return retry === undefined ? base : { ...base, retryAfterSeconds: retry };
}
const sent: ContactActionState = { ok: true, reference: "C-1A2B3C4D", message: "Sent" };
const ORDERS = [
  { id: "o-1", label: "Order 1001 placed Nov 1" },
  { id: "o-2", label: "Order 1002 placed Nov 3" },
];

function cform(): HTMLFormElement {
  return screen.getByRole("form", { name: "Contact us" }) as HTMLFormElement;
}
function fillValid() {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText(/^Topic/), { target: { value: "shipping" } });
  fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Where is my parcel please?" } });
}

describe("T66 ContactForm: structure", () => {
  test("static markup: plain form with named fields, caps, email type, honeypot; no productSlug unless given", () => {
    const html = renderToStaticMarkup(<ContactForm action={noopContact} />);
    expect(html).toMatch(/<form[^>]*>/);
    for (const name of ["name", "email", "topic", "message", "website"]) expect(html).toContain(`name="${name}"`);
    expect(html).not.toContain('name="productSlug"');
    expect(html).not.toContain('name="orderId"');
    expect(html).toMatch(/maxLength="80"[^>]*name="name"|name="name"[^>]*maxLength="80"/);
    expect(html).toMatch(/type="email"[^>]*name="email"/);
    expect(html).not.toContain("style=");
    const withSlug = renderToStaticMarkup(<ContactForm action={noopContact} productSlug="blue-mug" />);
    expect(withSlug).toContain('type="hidden" name="productSlug" value="blue-mug"');
  });

  test("fields: labels, maxLength 80/254/2000, type=email, required text visible", () => {
    const { container } = render(<ContactForm action={noopContact} />);
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).maxLength).toBe(80);
    const email = screen.getByLabelText(/^Email/) as HTMLInputElement;
    expect(email.maxLength).toBe(254);
    expect(email.type).toBe("email");
    expect((screen.getByLabelText(/^Message/) as HTMLTextAreaElement).maxLength).toBe(2000);
    expect(((container.textContent ?? "").match(/\(required\)/g) ?? []).length).toBe(4);
  });

  test("topic select starts on a disabled placeholder (no silent preselect) and lists the topics", () => {
    render(<ContactForm action={noopContact} />);
    const topic = screen.getByLabelText(/^Topic/) as HTMLSelectElement;
    expect(topic.value).toBe("");
    const first = topic.options[0]!;
    expect(first.textContent).toBe("Choose a topic");
    expect(first.disabled).toBe(true);
    expect(topic.options.length).toBe(12); // placeholder + 11 topics incl. "feedback" (T142)
  });

  test("order select only when orders is non-empty, listing exactly them (+ 'Not about an order')", () => {
    const { rerender } = render(<ContactForm action={noopContact} orders={[]} />);
    expect(screen.queryByLabelText(/Which order/)).toBeNull();
    rerender(<ContactForm action={noopContact} orders={ORDERS} initialOrderId="o-2" />);
    const sel = screen.getByLabelText(/Which order/) as HTMLSelectElement;
    expect(Array.from(sel.options).map((o) => [o.value, o.textContent])).toEqual([
      ["", "Not about an order"],
      ["o-1", "Order 1001 placed Nov 1"],
      ["o-2", "Order 1002 placed Nov 3"],
    ]);
    expect(sel.value).toBe("o-2");
    expect(sel.name).toBe("orderId");
  });

  test("initialOrderId not in orders is ignored (no foreign order id posted)", () => {
    render(<ContactForm action={noopContact} orders={ORDERS} initialOrderId="o-999" />);
    expect((screen.getByLabelText(/Which order/) as HTMLSelectElement).value).toBe("");
  });

  test("honeypot 'website': hidden from users and AT (aria-hidden, tabindex=-1, sr-only wrapper, autocomplete off)", () => {
    const { container } = render(<ContactForm action={noopContact} />);
    const hp = container.querySelector('input[name="website"]') as HTMLInputElement;
    expect(hp).not.toBeNull();
    expect(hp.getAttribute("tabindex")).toBe("-1");
    expect(hp.getAttribute("aria-hidden")).toBe("true");
    expect(hp.getAttribute("autocomplete")).toBe("off");
    expect(hp.type).toBe("text");
    const wrapper = hp.closest('[aria-hidden="true"]:not(input)') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toMatch(/\bsr-only\b/);
    // Not exposed in the accessibility tree.
    const names = screen.getAllByRole("textbox").map((el) => el.getAttribute("name"));
    expect(names).not.toContain("website");
    expect(hp.value).toBe("");
  });

  test("keyboard: every visible control is in the tab order; submit is a native submit button", () => {
    const { container } = render(<ContactForm action={noopContact} orders={ORDERS} />);
    container.querySelectorAll("input:not([type=hidden]):not([name=website]), select, textarea, button").forEach((el) => {
      expect((el as HTMLElement).tabIndex).not.toBe(-1);
    });
    expect(screen.getByRole("button", { name: "Send message" })).toHaveAttribute("type", "submit");
  });
});

describe("T66 ContactForm: submit flows", () => {
  test("field errors: summary role=alert focused, links to fields, aria-invalid/describedby, values persist", async () => {
    const values = { name: HOSTILE, email: "bad", topic: "returns", message: RTL };
    const { action } = scripted<ContactActionState>(
      [contactFail("VALIDATION_FAILED", "Fix", { email: "Enter a valid email.", message: "Too short." }, values)],
      null,
    );
    const { container } = render(<ContactForm action={action} />);
    fireEvent.submit(cform());
    const link = await screen.findByRole("link", { name: /Email: Enter a valid email\./ });
    const summary = link.closest('[role="alert"]') as HTMLElement;
    expect(summary).not.toBeNull();
    await waitFor(() => expectFocused(summary));
    const hrefs = within(summary).getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["#contact-email", "#contact-message"]);

    const email = screen.getByLabelText(/^Email/) as HTMLInputElement;
    expect(email).toHaveAttribute("aria-invalid", "true");
    const ids = (email.getAttribute("aria-describedby") ?? "").split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toContain("Enter a valid email.");
    expect(screen.getByLabelText(/^Name/)).not.toHaveAttribute("aria-invalid");

    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe(HOSTILE);
    expect(email.value).toBe("bad");
    expect((screen.getByLabelText(/^Topic/) as HTMLSelectElement).value).toBe("returns");
    expect((screen.getByLabelText(/^Message/) as HTMLTextAreaElement).value).toBe(RTL);
    expect(container.querySelector("img, script")).toBeNull();

    fireEvent.click(within(summary).getAllByRole("link")[1]!);
    expectFocused(screen.getByLabelText(/^Message/));
  });

  // DEFECT D-T66-1 (SR6, fixed in FIX-mol-A): ContactForm summary links now use `min-h-touch` like ReviewForm.
  test("DEFECT D-T66-1: error summary links meet the 44px touch target (min-h-touch)", async () => {
    const { action } = scripted<ContactActionState>(
      [contactFail("VALIDATION_FAILED", "Fix", { name: "Enter your name." })],
      null,
    );
    render(<ContactForm action={action} />);
    fireEvent.submit(cform());
    const link = await screen.findByRole("link", { name: /Name: Enter your name\./ });
    expect(link.className).toMatch(/min-h-touch/);
  });
  test("regression D-T66-1: summary link is an inline-flex, vertically centred touch target", async () => {
    const { action } = scripted<ContactActionState>(
      [contactFail("VALIDATION_FAILED", "Fix", { name: "Enter your name." })],
      null,
    );
    render(<ContactForm action={action} />);
    fireEvent.submit(cform());
    const link = await screen.findByRole("link", { name: /Name: Enter your name\./ });
    expect(link.className).toMatch(/inline-flex/);
    expect(link.className).toMatch(/items-center/);
  });

  test("DUPLICATE: warning alert, values kept, form usable", async () => {
    const { action, calls } = scripted<ContactActionState>(
      [contactFail("DUPLICATE", "dup", {}, { name: "Ada", message: "Same text again" }), sent],
      null,
    );
    render(<ContactForm action={action} />);
    fireEvent.submit(cform());
    const alert = await screen.findByText("You already sent this message");
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Ada");
    fireEvent.submit(cform());
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  test("RATE_LIMITED: minutes rounded up, alert", async () => {
    const { action } = scripted<ContactActionState>([contactFail("RATE_LIMITED", "slow", {}, {}, 3601)], null);
    render(<ContactForm action={action} />);
    fireEvent.submit(cform());
    const n = await screen.findByText("Please try again in 61 minutes.");
    expect(n.closest('[role="alert"]')).not.toBeNull();
  });

  test("success: reference in polite live region, fields cleared, honeypot posted empty", async () => {
    const { action, calls } = scripted<ContactActionState>([sent], null);
    render(<ContactForm action={action} productSlug="blue-mug" />);
    fillValid();
    fireEvent.submit(cform());
    const ref = await screen.findByText("C-1A2B3C4D");
    expect(ref.closest('[aria-live="polite"]')).not.toBeNull();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText(/^Message/) as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText(/^Topic/) as HTMLSelectElement).value).toBe("");
    expect(userKeys(calls[0]!)).toEqual(["email", "message", "name", "productSlug", "topic", "website"]);
    expect(calls[0]!.website).toBe("");
    expect(calls[0]!.productSlug).toBe("blue-mug");
  });

  test("double submit while pending sends once; button aria-busy", async () => {
    const { action, calls, release } = gated<ContactActionState>();
    try {
      render(<ContactForm action={action} />);
      fillValid();
      fireEvent.submit(cform());
      fireEvent.submit(cform());
      const btn = screen.getByRole("button", { name: /Send|Sending/ });
      await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
      fireEvent.click(btn);
      fireEvent.submit(cform());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      expect(calls).toHaveLength(1);
    } finally {
      await release(null);
    }
  });

  test("network failure (action throws): alert, typed values kept, retry possible", async () => {
    let n = 0;
    const action: ContactActionFn = async () => {
      n++;
      if (n === 1) throw new Error("offline");
      return sent;
    };
    render(<ContactForm action={action} />);
    fillValid();
    fireEvent.submit(cform());
    const t = await screen.findByText("Your message was not sent");
    expect(t.closest('[role="alert"]')).not.toBeNull();
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Ada");
    fireEvent.submit(cform());
    await screen.findByText("C-1A2B3C4D");
    expect(n).toBe(2);
  });

  test("hostile server message in generic failure renders as text", async () => {
    const { action } = scripted<ContactActionState>([contactFail("INVALID_INPUT", HOSTILE)], null);
    const { container } = render(<ContactForm action={action} />);
    fireEvent.submit(cform());
    await screen.findByText(HOSTILE);
    expect(container.querySelector("img, script")).toBeNull();
  });

  test("10k-char echoed message does not crash; textarea keeps maxLength 2000", async () => {
    const big = "x".repeat(10_000);
    const { action } = scripted<ContactActionState>(
      [contactFail("TOO_LONG", "too long", { message: "Too long." }, { message: big })],
      null,
    );
    render(<ContactForm action={action} />);
    fireEvent.submit(cform());
    await screen.findByRole("link", { name: /Message: Too long\./ });
    expect((screen.getByLabelText(/^Message/) as HTMLTextAreaElement).maxLength).toBe(2000);
  });
});
