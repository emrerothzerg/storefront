import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { appError } from "@/lib/result";
import { CONTACT_TOPICS as SERVER_TOPICS } from "@/server/contact/contact-service";
import type { ContactActionFn, ContactActionState, ContactEchoValues } from "../_contracts/contact-actions";
import { CONTACT_COPY, CONTACT_TOPIC_LABELS, CONTACT_TOPICS, ContactForm } from "./ContactForm";
import { expectFocused } from "@/test/dom-assertions";

type Posted = Record<string, string>;

function recording(result: ContactActionState): { action: ContactActionFn; calls: Posted[] } {
  const calls: Posted[] = [];
  const action: ContactActionFn = async (_prev, formData) => {
    const entry: Posted = {};
    formData.forEach((value, key) => {
      if (typeof value === "string") entry[key] = value;
    });
    calls.push(entry);
    return result;
  };
  return { action, calls };
}

function failure(
  code: Parameters<typeof appError>[0],
  message: string,
  fieldErrors: Partial<Record<keyof ContactEchoValues, string>> = {},
  values: ContactEchoValues = {},
  retryAfterSeconds?: number,
): ContactActionState {
  return {
    ok: false,
    error: appError(code, message),
    message,
    fieldErrors,
    values,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

const success: ContactActionState = { ok: true, reference: "C-AB12CD34", message: "Sent" };

function getForm(): HTMLFormElement {
  return screen.getByRole("form", { name: "Contact us" }) as HTMLFormElement;
}

function fill(): void {
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText(/^Email/), { target: { value: "ada@example.com" } });
  fireEvent.change(screen.getByLabelText(/^Topic/), { target: { value: "shipping" } });
  fireEvent.change(screen.getByLabelText(/^Message/), { target: { value: "Where is my parcel please?" } });
}

describe("ContactForm topics", () => {
  test("local topic list equals the server CONTACT_TOPICS and every topic has a label", () => {
    expect([...CONTACT_TOPICS]).toEqual([...SERVER_TOPICS]);
    for (const t of CONTACT_TOPICS) expect(CONTACT_TOPIC_LABELS[t].length).toBeGreaterThan(0);
  });
});

describe("ContactForm markup", () => {
  test("server markup: plain form with every named field incl. the hidden honeypot, no order select without orders", () => {
    const { action } = recording(success);
    const html = renderToStaticMarkup(<ContactForm action={action} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const form = doc.querySelector("form");
    expect(form).not.toBeNull();
    for (const name of ["name", "email", "topic", "message", "website"]) {
      expect(doc.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect(doc.querySelector('[name="orderId"]')).toBeNull();
    expect(doc.querySelector('[name="productSlug"]')).toBeNull();
    const honeypot = doc.querySelector('input[name="website"]');
    expect(honeypot?.getAttribute("type")).toBe("text");
    expect(honeypot?.getAttribute("tabindex")).toBe("-1");
    expect(honeypot?.getAttribute("autocomplete")).toBe("off");
    expect(honeypot?.getAttribute("aria-hidden")).toBe("true");
    expect(honeypot?.hasAttribute("required")).toBe(false);
    const wrapper = honeypot?.closest("div.sr-only");
    expect(wrapper?.getAttribute("aria-hidden")).toBe("true");
    expect(wrapper?.textContent).toContain("Leave this field empty");
    expect(doc.querySelector('button[type="submit"]')?.textContent).toContain("Send message");
  });

  test("limits, types, autocomplete, required, rows and helper text", () => {
    const { action } = recording(success);
    render(<ContactForm action={action} />);
    const name = screen.getByLabelText(/^Name/);
    expect(name).toHaveAttribute("maxLength", "80");
    expect(name).toHaveAttribute("autocomplete", "name");
    expect(name).toBeRequired();
    const email = screen.getByLabelText(/^Email/);
    expect(email).toHaveAttribute("type", "email");
    expect(email).toHaveAttribute("maxLength", "254");
    expect(email).toHaveAttribute("autocomplete", "email");
    expect(email).toBeRequired();
    const topic = screen.getByLabelText(/^Topic/);
    expect(topic).toBeRequired();
    expect(topic).toHaveValue("");
    const message = screen.getByLabelText(/^Message/);
    expect(message).toHaveAttribute("maxLength", "2000");
    expect(message).toHaveAttribute("rows", "6");
    expect(message).toBeRequired();
    expect(screen.getByText("10–2000 characters")).toBeInTheDocument();
    expect(screen.getByText("0 / 2000")).toBeInTheDocument();
    // Honeypot is not exposed to assistive tech.
    expect(screen.queryByRole("textbox", { name: "Leave this field empty" })).toBeNull();
    expect(screen.getAllByRole("textbox").map((el) => el.getAttribute("name"))).toEqual(["name", "email", "message"]);
  });

  test("topic options use human labels and only the passed topics", () => {
    const { action } = recording(success);
    render(<ContactForm action={action} topics={["returns", "other"]} initialTopic="other" />);
    const topic = screen.getByLabelText(/^Topic/) as HTMLSelectElement;
    const options = Array.from(topic.options).map((o) => [o.value, o.textContent]);
    expect(options).toEqual([
      ["", "Choose a topic"],
      ["returns", "Returns and refunds"],
      ["other", "Something else"],
    ]);
    expect(topic).toHaveValue("other");
  });

  test("feedback topic (T142, /contact?topic=feedback) is offered by default and preselects", () => {
    const { action } = recording(success);
    render(<ContactForm action={action} initialTopic="feedback" />);
    const topic = screen.getByLabelText(/^Topic/) as HTMLSelectElement;
    const values = Array.from(topic.options).map((o) => o.value);
    expect(values).toContain("feedback");
    expect(values.indexOf("feedback")).toBe(values.indexOf("other") - 1);
    expect(topic).toHaveValue("feedback");
    expect(topic.selectedOptions[0]?.textContent).toBe("Feedback about the site");
  });

  test("order select lists exactly the passed orders plus the blank option", () => {
    const { action } = recording(success);
    render(
      <ContactForm
        action={action}
        orders={[
          { id: "o1", label: "Order 1001 (Oct 2)" },
          { id: "o2", label: "Order 1002 (Oct 9)" },
        ]}
        initialOrderId="o2"
      />,
    );
    const select = screen.getByLabelText("Which order?") as HTMLSelectElement;
    expect(select).toHaveAttribute("name", "orderId");
    expect(select).not.toBeRequired();
    expect(Array.from(select.options).map((o) => [o.value, o.textContent])).toEqual([
      ["", "Not about an order"],
      ["o1", "Order 1001 (Oct 2)"],
      ["o2", "Order 1002 (Oct 9)"],
    ]);
    expect(select).toHaveValue("o2");
  });

  test("an unknown initialOrderId falls back to the blank option", () => {
    const { action } = recording(success);
    render(<ContactForm action={action} orders={[{ id: "o1", label: "A" }]} initialOrderId="zzz" />);
    expect(screen.getByLabelText("Which order?")).toHaveValue("");
  });

  test("signedInEmail prefills the email; productSlug posts as a hidden field", () => {
    const { action } = recording(success);
    const { container } = render(
      <ContactForm action={action} signedInEmail="me@example.com" productSlug="desk-lamp" />,
    );
    expect(screen.getByLabelText(/^Email/)).toHaveValue("me@example.com");
    expect(container.querySelector('input[type="hidden"][name="productSlug"]')).toHaveAttribute("value", "desk-lamp");
  });
});

describe("ContactForm submit", () => {
  test("posts the named fields with an empty honeypot", async () => {
    const { action, calls } = recording(success);
    render(<ContactForm action={action} orders={[{ id: "o1", label: "A" }]} />);
    fill();
    fireEvent.change(screen.getByLabelText("Which order?"), { target: { value: "o1" } });
    fireEvent.submit(getForm());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      name: "Ada",
      email: "ada@example.com",
      topic: "shipping",
      orderId: "o1",
      message: "Where is my parcel please?",
      website: "",
    });
  });

  test("pending shows Sending… and a second submit is ignored", async () => {
    let resolveFn: (s: ContactActionState) => void = () => {};
    let count = 0;
    const action: ContactActionFn = () => {
      count += 1;
      return new Promise<ContactActionState>((res) => {
        resolveFn = res;
      });
    };
    render(<ContactForm action={action} />);
    fill();
    fireEvent.submit(getForm());
    const busy = await screen.findByRole("button", { name: /Sending…/ });
    expect(busy).toHaveAttribute("aria-busy", "true");
    fireEvent.submit(getForm());
    expect(count).toBe(1);
    await act(async () => resolveFn(success));
    expect(await screen.findByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  test("success: reference in <code> inside a live region, fields cleared, email re-prefilled", async () => {
    const { action } = recording(success);
    render(<ContactForm action={action} signedInEmail="me@example.com" />);
    fill();
    fireEvent.submit(getForm());
    const status = (await screen.findByText("C-AB12CD34")).closest('[role="status"]');
    if (!(status instanceof HTMLElement)) throw new Error("no status");
    expect(status).toHaveTextContent("Thanks! Your reference number is C-AB12CD34. Keep it for follow-ups.");
    const code = status.querySelector("code");
    expect(code).toHaveTextContent("C-AB12CD34");
    expect(code).toHaveClass("font-mono");
    expect(status.closest('[aria-live="polite"]')).not.toBeNull();
    expect(screen.getByLabelText(/^Name/)).toHaveValue("");
    expect(screen.getByLabelText(/^Message/)).toHaveValue("");
    expect(screen.getByLabelText(/^Topic/)).toHaveValue("");
    expect(screen.getByLabelText(/^Email/)).toHaveValue("me@example.com");
  });

  test("validation failure: summary links, per-field aria-invalid/describedby, values persist", async () => {
    const values = { name: "Ada", email: "not-an-email", topic: "returns", message: "short", orderId: "o2" };
    const { action } = recording(
      failure(
        "VALIDATION_FAILED",
        "Check the form",
        { email: "Enter a valid email address.", message: "Write at least 10 characters." },
        values,
      ),
    );
    render(<ContactForm action={action} orders={[{ id: "o1", label: "A" }, { id: "o2", label: "B" }]} />);
    fill();
    fireEvent.submit(getForm());
    const summary = await screen.findByText("Please fix the following");
    const notice = summary.closest('[role="alert"]');
    expect(notice).not.toBeNull();
    const links = Array.from(notice?.querySelectorAll("a") ?? []);
    expect(links.map((a) => [a.getAttribute("href"), a.textContent])).toEqual([
      ["#contact-email", "Email: Enter a valid email address."],
      ["#contact-message", "Message: Write at least 10 characters."],
    ]);
    // 44px touch target, same classes as ReviewForm's summary links (D-T66-1).
    for (const a of links) {
      expect(a.classList.contains("min-h-touch")).toBe(true);
      expect(a.classList.contains("inline-flex")).toBe(true);
      expect(a.classList.contains("items-center")).toBe(true);
    }
    await waitFor(() => expectFocused(notice));

    const email = screen.getByLabelText(/^Email/);
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email.getAttribute("aria-describedby")).toContain("contact-email-error");
    expect(document.getElementById("contact-email-error")).toHaveTextContent("Enter a valid email address.");
    expect(screen.getByLabelText(/^Name/)).not.toHaveAttribute("aria-invalid");
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Ada");
    expect(email).toHaveValue("not-an-email");
    expect(screen.getByLabelText(/^Topic/)).toHaveValue("returns");
    expect(screen.getByLabelText("Which order?")).toHaveValue("o2");
    expect(screen.getByLabelText(/^Message/)).toHaveValue("short");

    const first = links[0];
    if (!first) throw new Error("no link");
    fireEvent.click(first);
    expectFocused(email);
  });

  test("hostile echoed values and messages render as text", async () => {
    const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">';
    const { action } = recording(
      failure("VALIDATION_FAILED", hostile, { name: hostile }, { name: hostile, message: hostile }),
    );
    const { container } = render(<ContactForm action={action} />);
    fill();
    fireEvent.submit(getForm());
    await screen.findByText("Please fix the following");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByLabelText(/^Name/)).toHaveValue(hostile);
    expect(screen.getByLabelText(/^Message/)).toHaveValue(hostile);
  });

  test.each([
    [failure("DUPLICATE", "x"), "You already sent this message"],
    [failure("RATE_LIMITED", "x", {}, {}, 1800), "Please try again in 30 minutes."],
    [failure("RATE_LIMITED", "x", {}, {}, 10), "Please try again in 1 minute."],
    [failure("INVALID_INPUT", "We couldn't send your message. Please try again.", {}, { name: "Ada" }), "We couldn't send your message. Please try again."],
  ] as const)("non-field failure %# shows a notice in role=alert", async (state, text) => {
    const { action } = recording(state);
    render(<ContactForm action={action} />);
    fill();
    fireEvent.submit(getForm());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(text));
  });

  test("network error keeps typed values and shows a danger notice", async () => {
    const action: ContactActionFn = async () => {
      throw new Error("Failed to fetch");
    };
    render(<ContactForm action={action} />);
    fill();
    fireEvent.submit(getForm());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(CONTACT_COPY.network));
    expect(screen.getByLabelText(/^Name/)).toHaveValue("Ada");
    expect(screen.getByLabelText(/^Message/)).toHaveValue("Where is my parcel please?");
  });

  test("a field error for orderId is not linked when there is no order select", async () => {
    const { action } = recording(failure("VALIDATION_FAILED", "Check", { orderId: "Unknown order." }));
    render(<ContactForm action={action} />);
    fill();
    fireEvent.submit(getForm());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Check"));
    expect(screen.queryByText("Please fix the following")).toBeNull();
  });
});
