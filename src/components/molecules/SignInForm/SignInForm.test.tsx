import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AUTH_MESSAGES } from "@/app/actions/auth-core";
import { FAQ_ENTRIES } from "@/content/faq";
import {
  PASSWORD_RESET_CONTACT_LABEL,
  PASSWORD_RESET_NOTICE,
  SIGN_IN_FIELD_IDS,
  SIGN_IN_PENDING_LABEL,
  SIGN_IN_SUBMIT_LABEL,
  SignInForm,
} from "./index";
import {
  HOSTILE_NEXT,
  HOSTILE_TEXT,
  authFailure,
  controlledAction,
  scriptedAction,
  serverLikeAction,
} from "./auth-test-helpers";
import { expectFocused, expectNotNull } from "@/test/dom-assertions";

const form = () => document.getElementById("signin-form") as HTMLFormElement;
const emailInput = () => document.getElementById(SIGN_IN_FIELD_IDS.email) as HTMLInputElement;
const passwordInput = () => document.getElementById(SIGN_IN_FIELD_IDS.password) as HTMLInputElement;
const submitButton = () => form().querySelector('button[type="submit"]') as HTMLButtonElement;
const summary = () => screen.queryByTestId("signin-error-summary");

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function fill(email = "ada@example.com", password = "correct horse battery") {
  fireEvent.change(emailInput(), { target: { value: email } });
  fireEvent.change(passwordInput(), { target: { value: password } });
}

async function submitAndSettle(stateCalls: () => number, expected: number) {
  fireEvent.submit(form());
  await waitFor(() => expect(stateCalls()).toBe(expected));
}

describe("SignInForm no-JS markup", () => {
  test("plain form: contract names, autocomplete, caps, one submit, links, notice; no script", () => {
    const html = renderToStaticMarkup(<SignInForm action={serverLikeAction()} next="/orders" />);
    const doc = parse(html);
    const f = doc.querySelector("form") as HTMLFormElement;
    expect(f.hasAttribute("novalidate")).toBe(true);
    expect(f.getAttribute("aria-label")).toBe("Sign in");
    const email = f.querySelector('[name="email"]') as HTMLInputElement;
    expect(email.getAttribute("type")).toBe("email");
    // D-T124-1: the sign-in identifier is `username` (sign-up keeps `email`).
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("maxlength")).toBe("254");
    expect(email.hasAttribute("required")).toBe(true);
    const password = f.querySelector('[name="password"]') as HTMLInputElement;
    expect(password.getAttribute("type")).toBe("password");
    expect(password.getAttribute("autocomplete")).toBe("current-password");
    expect(password.getAttribute("maxlength")).toBe("128");
    expect(password.hasAttribute("value")).toBe(false);
    const next = f.querySelectorAll('[name="next"]');
    expect(next).toHaveLength(1);
    expect(next[0]?.getAttribute("type")).toBe("hidden");
    expect(next[0]?.getAttribute("value")).toBe("/orders");
    expect(f.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(f.querySelector('button[type="submit"]')?.textContent).toBe(SIGN_IN_SUBMIT_LABEL);
    // Only contract names are posted.
    const names = [...f.querySelectorAll("[name]")]
      .map((el) => el.getAttribute("name") ?? "")
      .filter((n) => !n.startsWith("$ACTION"));
    expect(names.sort()).toEqual(["email", "next", "password"]);
    // Links
    const hrefs = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/signup?next=%2Forders");
    expect(hrefs).toContain("/contact");
    expect(doc.querySelector('a[href^="/signup"]')?.textContent).toBe("Create account");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("autofocus");
  });

  test("with a server action the form adopts POST/multipart (works without JS)", () => {
    const html = renderToStaticMarkup(<SignInForm action={serverLikeAction()} />);
    const f = parse(html).querySelector("form");
    expect(f?.getAttribute("method")?.toLowerCase()).toBe("post");
    expect(f?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(f?.getAttribute("action") ?? "").not.toContain("javascript:");
    expect(f?.querySelector('[name="$ACTION_REF_1"]')).not.toBeNull();
  });

  test("password reset notice uses the T126 'not available' wording and links to contact", () => {
    const doc = parse(renderToStaticMarkup(<SignInForm action={serverLikeAction()} contactHref="/help" />));
    const notice = doc.querySelector('[data-testid="password-reset-notice"]');
    expect(notice?.textContent).toContain(PASSWORD_RESET_NOTICE);
    expect(notice?.textContent?.toLowerCase()).toContain("password reset is not available");
    const link = notice?.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/help");
    expect(link?.textContent).toBe(PASSWORD_RESET_CONTACT_LABEL);
    // Same claim as the T126 FAQ entry.
    const faq = FAQ_ENTRIES.find((e) => e.slug === "i-cannot-reset-my-password");
    expect([faq?.answer ?? ""].flat().join(" ")).toContain(PASSWORD_RESET_NOTICE);
  });

  test("an off-site contactHref falls back to /contact", () => {
    for (const bad of ["https://evil.com", "//evil.com", "javascript:alert(1)"]) {
      const html = renderToStaticMarkup(<SignInForm action={serverLikeAction()} contactHref={bad} />);
      expect(html).not.toContain("evil");
      expect(html).not.toContain("javascript:");
      expect(html).toContain('href="/contact"');
    }
  });

  test.each(HOSTILE_NEXT.map((n) => [JSON.stringify(n), n] as const))("hostile next %s is never rendered", (_l, raw) => {
    const html = renderToStaticMarkup(<SignInForm action={serverLikeAction()} next={raw} />);
    const doc = parse(html);
    expect(doc.querySelector('[name="next"]')).toBeNull();
    expect(doc.querySelector('a[href^="/signup"]')?.getAttribute("href")).toBe("/signup");
    expect(html).not.toContain("evil");
    for (const a of doc.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") ?? "";
      expect(href.startsWith("/") && !href.startsWith("//")).toBe(true);
    }
  });

  test("no next: no hidden field and a bare /signup link", () => {
    const doc = parse(renderToStaticMarkup(<SignInForm action={serverLikeAction()} />));
    expect(doc.querySelector('[name="next"]')).toBeNull();
    expect(doc.querySelector('a[href^="/signup"]')?.getAttribute("href")).toBe("/signup");
  });
});

describe("SignInForm interactions", () => {
  test("posts exactly email, password and the safe next", async () => {
    const { action, calls } = scriptedAction([authFailure("INVALID_CREDENTIALS")]);
    render(<SignInForm action={action} next="/orders" />);
    fill();
    await submitAndSettle(() => calls.length, 1);
    expect(calls[0]).toEqual({ email: "ada@example.com", password: "correct horse battery", next: "/orders" });
  });

  test("INVALID_CREDENTIALS: alert summary focused, constant text, password cleared, email re-filled", async () => {
    const { action, calls } = scriptedAction([
      authFailure("INVALID_CREDENTIALS", { message: AUTH_MESSAGES.invalidCredentials, values: { email: "ada@example.com" } }),
    ]);
    render(<SignInForm action={action} />);
    fill();
    await submitAndSettle(() => calls.length, 1);
    await waitFor(() => expectNotNull(summary()));
    const s = summary() as HTMLElement;
    expect(s.getAttribute("role")).toBe("alert");
    expect(s.textContent).toContain("Email or password is incorrect");
    await waitFor(() => expectFocused(s));
    expect(passwordInput().value).toBe("");
    expect(emailInput().value).toBe("ada@example.com");
  });

  test.each([
    ["TOO_MANY_ATTEMPTS (rate limited)", authFailure("TOO_MANY_ATTEMPTS", { retryAfterSeconds: 840 })],
    ["ACCOUNT_LOCKED", authFailure("INTERNAL_ERROR", { errorCode: "ACCOUNT_LOCKED", retryAfterSeconds: 840 })],
    ["RATE_LIMITED", authFailure("INTERNAL_ERROR", { errorCode: "RATE_LIMITED", retryAfterSeconds: 840 })],
  ])("%s shows the identical R-10 text", async (_label, state) => {
    const { action, calls } = scriptedAction([state]);
    render(<SignInForm action={action} />);
    fill();
    await submitAndSettle(() => calls.length, 1);
    await waitFor(() => expect(summary()?.textContent).toContain("Too many attempts. Try again in 14 minutes."));
    expect(passwordInput().value).toBe("");
  });

  test("INTERNAL_ERROR shows the generic text (not the server message)", async () => {
    const { action, calls } = scriptedAction([authFailure("INTERNAL_ERROR", { message: "db exploded at line 3" })]);
    render(<SignInForm action={action} />);
    fill();
    await submitAndSettle(() => calls.length, 1);
    await waitFor(() => expect(summary()?.textContent).toContain(AUTH_MESSAGES.internal));
    expect(summary()?.textContent).not.toContain("db exploded");
  });

  test("VALIDATION_FAILED: summary links to fields, aria wiring, clicking focuses the field", async () => {
    const { action, calls } = scriptedAction([
      authFailure("VALIDATION_FAILED", {
        fieldErrors: { email: "Enter a valid email address.", password: "Enter a password." },
        values: { email: "nope" },
      }),
    ]);
    render(<SignInForm action={action} />);
    fill("nope", "");
    await submitAndSettle(() => calls.length, 1);
    await waitFor(() => expectNotNull(summary()));
    const links = [...(summary() as HTMLElement).querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([`#${SIGN_IN_FIELD_IDS.email}`, `#${SIGN_IN_FIELD_IDS.password}`]);
    expect(links[0]?.textContent).toBe("Email: Enter a valid email address.");
    expect(emailInput().getAttribute("aria-invalid")).toBe("true");
    expect(emailInput().getAttribute("aria-describedby")).toContain(`${SIGN_IN_FIELD_IDS.email}-error`);
    expect(passwordInput().getAttribute("aria-invalid")).toBe("true");
    expect(passwordInput().getAttribute("aria-describedby")).toContain(`${SIGN_IN_FIELD_IDS.password}-error`);
    fireEvent.click(links[1] as HTMLAnchorElement);
    expectFocused(passwordInput());
    expect(emailInput().value).toBe("nope");
  });

  test("hostile echoed email renders inert (input value only, no markup)", async () => {
    const { action, calls } = scriptedAction([authFailure("INVALID_CREDENTIALS", { values: { email: HOSTILE_TEXT } })]);
    const { container } = render(<SignInForm action={action} />);
    fill();
    await submitAndSettle(() => calls.length, 1);
    await waitFor(() => expect(emailInput().value).toBe(HOSTILE_TEXT));
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
  });

  test("pending: spinner label, aria-busy; double submit sends once; guard released on settle", async () => {
    const { action, calls, resolve } = controlledAction();
    render(<SignInForm action={action} />);
    fill();
    fireEvent.submit(form());
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect(submitButton().textContent).toContain(SIGN_IN_PENDING_LABEL));
    expect(submitButton().getAttribute("aria-busy")).toBe("true");
    expect(submitButton().getAttribute("aria-disabled")).toBe("true");
    expect(submitButton().querySelector('[role="status"]')).not.toBeNull(); // spinner
    fireEvent.click(submitButton());
    fireEvent.submit(form());
    expect(calls).toHaveLength(1);
    await act(async () => resolve(authFailure("INVALID_CREDENTIALS")));
    // No waitFor: the guard is released in `finally`, not in a later effect.
    fill();
    fireEvent.submit(form());
    await waitFor(() => expect(calls).toHaveLength(2));
    await act(async () => resolve(authFailure("INVALID_CREDENTIALS")));
    await waitFor(() => expect(submitButton().textContent).toBe(SIGN_IN_SUBMIT_LABEL));
  });

  test("exactly one primary button; no autofocus; every control named; 320px-safe classes", () => {
    const { container } = render(<SignInForm action={scriptedAction([]).action} />);
    const primary = [...container.querySelectorAll("button, a")].filter((el) =>
      (el.getAttribute("class") ?? "").split(/\s+/).includes("bg-accent"),
    );
    expect(primary).toHaveLength(1);
    expect(container.querySelector("[autofocus]")).toBeNull();
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    for (const control of container.querySelectorAll("input:not([type=hidden]), button")) {
      expect(control).toHaveAccessibleName();
    }
    const tokens = [...container.querySelectorAll("[class]")].flatMap((el) => (el.getAttribute("class") ?? "").split(/\s+/));
    const fixedWidths = tokens.filter((t) => /^(w|min-w)-(\d+|screen|\[.*\])$/.test(t) && t !== "min-w-0");
    expect(fixedWidths).toEqual([]);
  });

  test("the password is never echoed into the DOM after a failure", async () => {
    const secret = "Sentinel-Secret-91x";
    const { action, calls } = scriptedAction([authFailure("INVALID_CREDENTIALS", { values: { email: "ada@example.com" } })]);
    const { container } = render(<SignInForm action={action} />);
    fill("ada@example.com", secret);
    await submitAndSettle(() => calls.length, 1);
    await waitFor(() => expectNotNull(summary()));
    expect(container.innerHTML).not.toContain(secret);
    expect(passwordInput().value).toBe("");
  });
});
